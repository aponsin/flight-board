// The nudges (board v2): what the collector's run tells the lead besides its CONFLICT lines. Pure: the board's mirror,
// the config, the time and the last run's state come in; the lines and the new state go out. Each nudge is sent once,
// then again only after a quiet period while it still holds; one that stops holding is forgotten, so it can come back.
//   1. the owner waits: a thread whose last word is the owner's, or an ask the owner answered and nobody closed or
//      answered since, for config.nudges.ownerWaitMin minutes;
//   2. a step open too long: a declared start with no end, past stepFactor times the median for its card's size;
//   3. a role's memory reading (ctx/<Role>) older than ctxMaxHours;
//   4. a card unchanged for staleHours, unless parked (its status in config.nudges.parked).
// The CONFLICT lines are the collector's own (collector/derive.mjs).

const MIN = 60e3, HOUR = 36e5;
const closed = (k) => k.status === "done" || k.status === "dropped";

// A card's content, keys sorted, to tell whether it changed between runs (the export carries no change time).
function fingerprint(doc) {
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(doc));
}

export function nudges({ config, docs, now, state = {} }) {
  const n = config.nudges, owner = config.owner, firing = [];
  const messages = (docs.messages ?? []).filter((m) => m && typeof m.thread === "string" && typeof m.at === "number");
  const byThread = new Map();
  for (const m of messages) byThread.set(m.thread, [...(byThread.get(m.thread) ?? []), m]);
  const mins = (ms) => Math.round(ms / MIN), hours = (ms) => Math.round((ms / HOUR) * 10) / 10;

  // 1. The owner waits.
  for (const [id, list] of byThread) {
    const last = list.reduce((a, b) => (b.at > a.at ? b : a));
    if (last.from === owner && !last.resolved && now - last.at >= n.ownerWaitMin * MIN) firing.push({ key: `thread:${id}`, text: `thread ${id}: ${owner} has waited ${mins(now - last.at)} min for an answer` });
  }
  for (const w of docs.waiting ?? []) {
    const at = w?.response?.at;
    if (!w || w.done || typeof at !== "number" || now - at < n.ownerWaitMin * MIN) continue;
    if ((byThread.get(w.id) ?? []).some((m) => m.from !== owner && m.at > at)) continue;
    if (firing.some((f) => f.key === `thread:${w.id}`)) continue;
    firing.push({ key: `ask:${w.id}`, text: `ask ${w.id}: ${owner} answered ${mins(now - at)} min ago; act on it and close it` });
  }

  // 2. A step open too long, by its card's size.
  const cards = new Map((docs.initiatives ?? []).filter(Boolean).map((k) => [k.id, k]));
  const runs = new Map();
  for (const s of (docs.steps ?? []).filter((x) => x && !x.wait && typeof x.at === "number").sort((a, b) => a.at - b.at)) {
    const key = `${s.init}:${s.phase}:${s.who}`;
    if (s.kind === "start") runs.set(key, s); else if (s.kind === "end") runs.delete(key);
  }
  for (const [key, s] of runs) {
    const card = cards.get(s.init), median = n.etaHours[card?.size];
    if (!card || closed(card) || typeof median !== "number") continue;
    if (now - s.at > n.stepFactor * median * HOUR) firing.push({ key: `step:${key}`, text: `${s.who} on ${s.init} (${s.phase}): open ${hours(now - s.at)} h, over ${n.stepFactor}× the ${card.size} median of ${median} h` });
  }

  // 3. A memory reading too old.
  for (const c of docs.ctx ?? []) {
    if (c && typeof c.at === "number" && now - c.at > n.ctxMaxHours * HOUR) firing.push({ key: `ctx:${c.id}`, text: `${c.id}'s memory reading is ${hours(now - c.at)} h old` });
  }

  // 4. A card unchanged too long, unless parked.
  const seen = {};
  for (const card of cards.values()) {
    if (closed(card)) continue;
    const fp = fingerprint(card), before = state.seen?.[card.id];
    seen[card.id] = before && before.fp === fp ? before : { fp, since: now };
    if (n.parked.includes(card.status)) continue;
    if (now - seen[card.id].since >= n.staleHours * HOUR) firing.push({ key: `stale:${card.id}`, text: `${card.id}: unchanged for ${hours(now - seen[card.id].since)} h; update it or park it` });
  }

  // Once, then again only after the quiet period; forgotten when it stops holding.
  const sent = {}, lines = [];
  for (const f of firing) {
    const last = state.sent?.[f.key];
    if (typeof last === "number" && now - last < n.quietMin * MIN) { sent[f.key] = last; continue; }
    sent[f.key] = now;
    lines.push(`NUDGE ${f.text}`);
  }
  return { lines, state: { sent, seen } };
}
