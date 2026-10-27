// The owner's word unanswered (#C297): the threads whose newest message is the owner's, still open WAIT_MIN minutes on.
// Only a later message from the lead in the same thread closes one (Manager, 2026-10-27); the owner's own close
// (resolved) owes nothing. The page draws the same rule (lateTag in page/board.template.html).
export const WAIT_MIN = 5;

// A thread's messages oldest first by time; one that names the message it answers (after: <its id>) always comes after
// it, whatever the two clocks said (the page's threadOf).
export function threadOrder(list) {
  const by = new Map(list.map((m) => [m.id, m])), key = new Map();
  const k = (m, seen = new Set()) => {
    if (key.has(m)) return key.get(m);
    let v = m.at;
    const p = m.after && by.get(m.after);
    if (p && !seen.has(p)) { seen.add(m); v = Math.max(v, k(p, seen) + 1); }
    key.set(m, v);
    return v;
  };
  return list.slice().sort((a, b) => k(a) - k(b) || a.at - b.at);
}

// messages: [{ id, thread, from, at, after?, resolved? }]. Returns [{ thread, id, at }] for each thread whose newest
// message is the owner's, not a close, at least `minutes` old at `now`.
export function openOwnerWords(messages, { owner, now, minutes = WAIT_MIN }) {
  const threads = new Map();
  for (const m of messages) {
    if (!m || typeof m.thread !== "string" || typeof m.at !== "number") continue;
    threads.set(m.thread, [...(threads.get(m.thread) ?? []), m]);
  }
  const out = [];
  for (const [thread, list] of threads) {
    const t = threadOrder(list), last = t[t.length - 1];
    if (last.from === owner && !last.resolved && now - last.at >= minutes * 60e3) out.push({ thread, id: last.id, at: last.at });
  }
  return out.sort((a, b) => a.at - b.at);
}
