// The owner's words, pushed to the lead (#C392): the board's comment watch arms its auto-replies only when the owner's own
// chat message carries the board's link, so after a clear the lead's watch came back without them and ~40 board messages
// arrived with no ping. Nothing here depends on the watch: each collector run reaches the lead with send_message
// (collector/TASK.md, step 4). Pure, like collector/nudges.mjs: the mirror, the config, the time and the last run's state
// in; the lines and the new state out.
//   1. an unseen word: in a thread, the owner's newest word (not one they closed) with no word from the lead after it in
//      that thread; an answered ask, not done, likewise. Each is pushed once, at the first run that sees it, by its id
//      only: never the text (collector/text.mjs), the lead reads it on the board;
//   2. deaf: an unseen word nudges.deafMin (30) minutes old means the lead's pings are likely off. Only the owner can arm
//      them again (their own message with the link), so the lead raises waiting/rearm-pings with that command, unless
//      it is open. Once, then again only after the quiet period while it still holds.
// The watch stays the fast path when armed; the lead's answer on the board is what makes a word seen.

import { idText as q } from "./text.mjs";

const MIN = 60e3, HOUR = 36e5;
export const REARM_ID = "rearm-pings";
// Only the last day's words (older ones were answered another way, or are the owner-waits nudge's), and at most
// MAX_LINES of them a run, newest first, then one "and N more" line: the lead's message stays under the fence's 4 KB.
export const WINDOW_H = 24, MAX_LINES = 5;

// The owner's unseen words: [{ kind: "thread" | "ask", id, at }], one per thread (an ask's thread is its id).
export function unseenOwner(docs, config) {
  const owner = config.owner, lead = config.gate.managerRole, out = [];
  const messages = (docs.messages ?? []).filter((m) => m && typeof m.thread === "string" && typeof m.at === "number");
  const leadLast = new Map(), ownerLast = new Map();
  for (const m of messages) {
    if (m.from === lead && m.at > (leadLast.get(m.thread) ?? -Infinity)) leadLast.set(m.thread, m.at);
    if (m.from === owner && m.at > (ownerLast.get(m.thread)?.at ?? -Infinity)) ownerLast.set(m.thread, m);
  }
  for (const [id, m] of ownerLast) if (!m.resolved && m.at > (leadLast.get(id) ?? -Infinity)) out.push({ kind: "thread", id, at: m.at });
  for (const w of docs.waiting ?? []) {
    const at = w?.response?.at;
    if (!w || w.done || typeof at !== "number" || out.some((u) => u.id === w.id) || at <= (leadLast.get(w.id) ?? -Infinity)) continue;
    out.push({ kind: "ask", id: w.id, at });
  }
  return out;
}

export function ownerPush({ config, docs, now, state = {} }) {
  const owner = config.owner, lead = config.gate.managerRole, n = config.nudges, lines = [];
  const mins = (ms) => Math.round(ms / MIN);
  const unseen = unseenOwner(docs, config).filter((u) => now - u.at < WINDOW_H * HOUR);
  // Keyed by the word's time too, so a newer word in the same thread is pushed again. No prototype: ids are board words.
  const pushed = Object.create(null);
  let more = 0;
  for (const u of unseen.sort((a, b) => b.at - a.at)) {
    const key = `${u.kind}:${u.id}:${u.at}`;
    pushed[key] = Object.hasOwn(state.pushed ?? {}, key) ? state.pushed[key] : now;
    if (pushed[key] !== now) continue;
    if (lines.length >= MAX_LINES) { more++; continue; }
    lines.push(u.kind === "ask"
      ? `NUDGE ${owner} answered ask ${q(u.id)} ${mins(now - u.at)} min ago, and ${lead} has written nothing in its thread since: read it on the board.`
      : `NUDGE ${owner} wrote in thread ${q(u.id)} ${mins(now - u.at)} min ago, and ${lead} has written nothing there since: read it on the board.`);
  }
  if (more) lines.push(`NUDGE and ${more} more word(s) from ${owner} with nothing from ${lead} after them: read the board's threads.`);
  const next = { pushed: { ...pushed } };
  const oldest = Math.min(...unseen.map((u) => u.at));
  const open = (docs.waiting ?? []).some((w) => w?.id === REARM_ID && !w.done);
  if (now - oldest >= n.deafMin * MIN && !open) {
    const last = typeof state.deafAt === "number" && now - state.deafAt < n.quietMin * MIN ? state.deafAt : null;
    next.deafAt = last ?? now;
    if (last === null) lines.push(`NUDGE ${lead} may be deaf to board pings: raise waiting/${REARM_ID} (kind "action", one step {text, cmd: "Turn the board's comment auto-replies back on: ${config.artifactUrl || "<the board's link>"}"}) unless it is open, then answer the owner's unseen words.`);
  }
  return { lines, state: next };
}
