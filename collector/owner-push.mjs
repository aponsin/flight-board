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

// The page's own rules, mirrored (page/board.template.html: ACK_ONLY, ackOnly, settled, threadOf), so a word counts here
// exactly when the page shows it waiting on the lead (Checker on 26bca32: an Ack, an answer stamped a little early and a
// shipped card's thread each raised the deaf line).
const ACK_ONLY = /^(?:ok(?:ay)?|k|done|thanks?(?: you)?|thx|ty|got it|noted|yes|yep|yup|sure|great|perfect|good|cool|nice|fine|all good|will do|👍|✅|🙏)$/i;
export const ackOnly = (text) => ACK_ONLY.test(String(text || "").trim().replace(/[\s.!👍✅🙏]+$/u, "").replace(/^[\s👍✅🙏]+/u, "") || "ok");
// Closed, or the owner's own reply closed it: an Ack on an answer, or a Done on anything but a decision, with no note
// (or one that only acknowledges) and no files.
export function settled(w) {
  if (!w) return false;
  if (w.done) return true;
  const r = w.response;
  if (!r || (Array.isArray(r.files) && r.files.length) || !ackOnly(r.note)) return false;
  return (w.kind === "answer" && r.status === "ack") || (w.kind !== "decision" && r.status === "done");
}
// A thread's messages oldest first; one that names the message it answers (after: <id>) comes after it, whatever the
// clocks said.
export function ordered(list) {
  const by = new Map(list.map((m) => [m.id, m])), key = new Map();
  const k = (m, seen = new Set()) => {
    if (key.has(m)) return key.get(m);
    let v = m.at;
    const p = m.after && by.get(m.after);
    if (p && !seen.has(p)) { seen.add(m); v = Math.max(v, k(p, seen) + 1); }
    key.set(m, v);
    return v;
  };
  return [...list].sort((a, b) => k(a) - k(b) || a.at - b.at);
}

// The owner's unseen words: [{ kind: "thread" | "ask", id, at }], one per thread (an ask's thread is its id). A thread's
// newest owner word with no word from the lead after it (another role's word isn't the lead's), unless the owner closed
// it, it only acknowledges a settled ask, or its item is done (a card done, an idea done). An ask the owner answered and
// that isn't settled, with no word from the lead since.
export function unseenOwner(docs, config) {
  const owner = config.owner, lead = config.gate.managerRole, out = [];
  const byThread = new Map();
  for (const m of docs.messages ?? []) if (m && typeof m.thread === "string" && typeof m.at === "number") byThread.set(m.thread, [...(byThread.get(m.thread) ?? []), m]);
  const asks = new Map((docs.waiting ?? []).filter(Boolean).map((w) => [w.id, w]));
  const done = (id) => (docs.initiatives ?? []).some((k) => k?.id === id && k.status === "done") || (docs.ideas ?? []).some((d) => d?.id === id && d.done);
  const leadAt = new Map();
  for (const [id, list] of byThread) {
    const t = ordered(list);
    const o = t.findLastIndex((m) => m.from === owner), l = t.findLastIndex((m) => m.from === lead);
    if (l >= 0) leadAt.set(id, t[l].at);
    if (o < 0 || o < l) continue;
    const m = t[o], w = asks.get(id);
    if (m.resolved || done(id) || (w && settled(w) && ackOnly(m.text) && !(Array.isArray(m.assets) && m.assets.length))) continue;
    out.push({ kind: "thread", id, at: m.at });
  }
  for (const w of asks.values()) {
    const at = w.response?.at;
    if (settled(w) || typeof at !== "number" || out.some((u) => u.id === w.id) || at <= (leadAt.get(w.id) ?? -Infinity)) continue;
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
