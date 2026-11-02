// The probe's own readings, without a model (#C592 keeper, #C593 watchdog, #C595 usage): pure functions over what
// collector/state.mjs already reads from the transcripts and the app's session files. Numbers, times and enums come out
// (collector/state-schema.mjs's ctx, stuck and usage); no text of a transcript or a title does.
import { ROLE, CARD_ID } from "./state-schema.mjs";

// A role in the last assistant entry's usage fields: the tokens its next turn is sent with. Null without one.
export function contextTokens(entries) {
  const e = entries.findLast((x) => x.type === "assistant" && x.message?.usage && typeof x.message.usage === "object");
  if (!e) return null;
  const u = e.message.usage, n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  const t = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  return t > 0 && t <= 5e6 ? t : null;
}

// Each role's context (#C592): { <role>: { pct, tokens, at, over } } against the window (the board's resetAt is where the
// roles reset, so pct is of the window and over is tokens at or past resetAt).
export const WINDOW_TOKENS = 1_000_000;
export function ctxReadings({ tokens, resetAt, now, window = WINDOW_TOKENS }) {
  const out = {};
  for (const [role, t] of Object.entries(tokens)) {
    if (!ROLE.test(role) || !Number.isInteger(t)) continue;
    out[role] = { pct: Math.min(100, Math.round((t / window) * 100)), tokens: t, at: now, over: t >= resetAt };
  }
  return out;
}

// The roles to send CONTEXT RESET to: over resetAt now and not asked since they last came back under it. before is the
// file kept from run to run, { roles: { <role>: <time asked> } }; the next one keeps only roles still over.
export function resetAsks(ctx, before, now) {
  return askOnce(Object.entries(ctx).filter(([, c]) => c.over).map(([role]) => role), before, now);
}

// Roles to wake after a crash, a restart or a reset (#C583). A roster role with no open session is missing; of those, the
// ones with work (wake-by-need: a card of theirs, not closed, queued or active) are to be woken, and the rest are only
// reported as missing, so the lead isn't asked to start sessions nobody needs. cards: [{ who, status }] of the board's export.
// { wake: [roles], missing: [roles] }, sorted; the lead is never in either (it is the one reading this).
export function wakeNeeds({ roster, agents, cards, lead = "" }) {
  const busy = new Set(cards.filter((c) => c && typeof c.who === "string" && ["queued", "active"].includes(c.status)).map((c) => c.who));
  const missing = roster.filter((r) => ROLE.test(r) && r !== lead && !Object.hasOwn(agents, r)).sort();
  return { wake: missing.filter((r) => busy.has(r)), missing: missing.filter((r) => !busy.has(r)) };
}
// What to ask for now, once per spell: roles asked since they were last seen are not asked again. before: the file kept,
// { roles: { <role>: <time asked> } }; the next one keeps only roles still wanted. { roles, fresh }.
export function askOnce(wanted, before, now) {
  const asked = before && typeof before.roles === "object" && before.roles && !Array.isArray(before.roles) ? before.roles : {};
  const roles = {}, fresh = [];
  for (const role of wanted) {
    const t = Object.hasOwn(asked, role) ? asked[role] : null;
    if (Number.isInteger(t) && t > 0 && t <= now) roles[role] = t;
    else { roles[role] = now; fresh.push(role); }
  }
  return { roles, fresh: fresh.sort() };
}

// An agent's question for the owner that never became a Needs-you item (#C584, Director's miss 2: Builder's font-download ask
// and four of Boardsmith's questions died in chat): an open card whose waitingOn is the owner, with no open waiting item
// naming the card. [{ card, role }] sorted by card; role is the card's who (an agent, never the owner). The lead writes the
// item from the line the wake watch prints.
export function ownerAsks({ cards, waiting, owner }) {
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
  const open = new Set((Array.isArray(waiting) ? waiting : []).filter((w) => w && typeof w === "object" && !w.done && typeof w.initiative === "string").map((w) => w.initiative));
  return cards.filter((c) => c && typeof c.id === "string" && CARD_ID.test(c.id) && same(c.waitingOn, owner) && typeof c.who === "string" && ROLE.test(c.who) && !same(c.who, owner) && !open.has(c.id))
    .map((c) => ({ card: c.id, role: c.who })).sort((a, b) => (a.card < b.card ? -1 : 1));
}
// The asks to write down, each with the time it was first seen (kept while it stays listed): before is the file kept,
// { asks: [{ card, role, since }] }. { asks, fresh } (fresh: those new this run).
export function askSince(list, before, now) {
  const had = new Map((Array.isArray(before?.asks) ? before.asks : []).filter((a) => a && typeof a.card === "string" && Number.isInteger(a.since) && a.since > 0 && a.since <= now).map((a) => [a.card, a.since]));
  const asks = list.map((a) => ({ ...a, since: had.get(a.card) ?? now }));
  return { asks, fresh: asks.filter((a) => !had.has(a.card)) };
}

// What the cards' own evidence says no one has to remember to write (#C617; gate/reset.mjs prints it): ship, a card whose tip has
// every sign-off its level needs (its phase is the ship phase), is not on main and no ship run is on it; close, a card whose
// commits are live (the live phase: on main and deployed, or in the installed pack) while it is still open. A card waiting on its
// done test (hold: a set of ids with a checkAt, #C581) is not asked to close. [{ kind, card, sha }], by card, at most `max`.
export function boardTruth({ states, shipPhase, livePhase, hold = new Set(), max = 20 }) {
  const items = [];
  for (const [card, s] of Object.entries(states ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!s || typeof s !== "object" || !/^[0-9a-f]{12}$/.test(String(s.headSha12 ?? ""))) continue;
    if (s.phase === shipPhase && s.onMain === false && s.shipping !== true) items.push({ kind: "ship", card, sha: s.headSha12 });
    else if (s.phase === livePhase && s.onMain === true && !hold.has(card)) items.push({ kind: "close", card, sha: s.headSha12 });
  }
  return items.slice(0, max);
}

// A role stuck (#C593): working on one prompt over STEP_MS (the same step, the turn's start unmoved), or stopped on a call
// the owner must answer over USER_MS (promptSince from the transcript). { <role>: { kind, card, since } }; the lead and
// the idle are never stuck on a step.
export const STEP_MS = 45 * 60e3, USER_MS = 15 * 60e3;
export function stuckReadings({ agents, prompts, now, lead = "" }) {
  const out = {};
  for (const [role, a] of Object.entries(agents)) {
    if (!ROLE.test(role)) continue;
    const asked = prompts[role];
    if (Number.isInteger(asked) && now - asked > USER_MS) out[role] = { kind: "user", card: a.card ?? null, since: asked };
    else if (role !== lead && a.state === "working" && Number.isInteger(a.since) && now - a.since > STEP_MS) out[role] = { kind: "step", card: a.card ?? null, since: a.since };
  }
  return out;
}

// The usage tile (#C595): the top five sources of the spend script's rows, as shares, and the week's pace. rows: the
// script's --json rows ({ source, share }); a source is a roster role, "scheduled" for "scheduled: …", else "other".
// plan: { weekPct, resetsAt } (a number and a time) when someone wrote it; pace = weekPct over the share of the week gone.
export const WEEK_MS = 7 * 24 * 3600e3, AMBER_PACE = 1.3, RED_PACE = 1.6;
export function usageReading({ rows, roster, plan, now }) {
  const by = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.source !== "string" || !Number.isFinite(r.share) || r.share < 0) continue;
    const src = roster.includes(r.source) && ROLE.test(r.source) ? r.source : r.source.startsWith("scheduled:") ? "scheduled" : "other";
    by.set(src, (by.get(src) ?? 0) + r.share);
  }
  const top = [...by].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([src, s]) => ({ src, pct: Math.min(100, Math.round(s * 100)) }));
  let weekPct = null, pace = null;
  if (plan && Number.isFinite(plan.weekPct) && plan.weekPct >= 0 && plan.weekPct <= 1000 && Number.isInteger(plan.resetsAt)) {
    weekPct = Math.round(plan.weekPct);
    const gone = 1 - (plan.resetsAt - now) / WEEK_MS;
    if (gone >= 0.02 && gone <= 1) pace = Math.min(10000, Math.round((plan.weekPct / 100 / gone) * 100));
  }
  const x = pace === null ? 0 : pace / 100;
  return { at: now, weekPct, pace, level: x >= RED_PACE ? "red" : x >= AMBER_PACE ? "amber" : "ok", top };
}
