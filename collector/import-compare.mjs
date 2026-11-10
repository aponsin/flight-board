// The dry run's comparison with the old page (#C824): the six tab counts and the in-flight count, each with a reason for every difference.
// Pure: the old board's documents, the store's view and the plan's rows in; numbers and ids out. Nothing here writes.
//   Needs you / Later / With the team / To-do / Ideas  the open items: what the plan carries (plus the store's own) against the old page's count
//   Resolved, 7 days  the threads resolved within 7 days on the old page's rule (the last message is resolved, or the thread's item is done)
//                     against the threads the store would show after the import (its own, plus the plan's)
//   In flight         the cards not done on the old board against the cards the store holds open after the import
// `expect` is what Manager read off the old page (--expect needs=N,later=N,lead=N,todo=N,ideas=N,resolved=N,inflight=N); a tab with no
// expected number is listed as unchecked. A difference is never left without a reason: what the export holds that the store will not show
// is grouped by why, and what the store will show that the old page does not is listed too.
const DAY = 86_400_000;
const WINDOW = 7 * DAY;
const time = (v) => (Number.isInteger(v) && v > 1_577_836_800_000 && v < 4_102_444_800_000 ? v : null);

// The threads the old page lists as resolved within `window` before `now`, by the page's own rule (threadResolved in page/board.template.html):
// not open (the owner's word is not the last unresolved one), and either the last message is resolved (an ack on a card's thread excepted) or
// its item (a waiting item or an idea or an initiative) is done.
// The thread of a done ask is its `thread` field, else its own id (the key both sides of the comparison use: a thread id, never an ask id).
const threadOfAsk = (id, d) => (typeof d?.thread === "string" && d.thread ? d.thread : id);
export function oldResolved(docs, now) {
  const doneThreads = new Set(Object.entries(docs.waiting ?? {}).filter(([, d]) => d && d.deleted !== true && d.done).map(([id, d]) => threadOfAsk(id, d)));
  const byThread = new Map();
  for (const [id, m] of Object.entries(docs.messages ?? {})) {
    if (!m || m.deleted === true || typeof m.thread !== "string") continue;
    (byThread.get(m.thread) ?? byThread.set(m.thread, []).get(m.thread)).push({ ...m, _id: id });
  }
  const out = new Map();
  for (const [tid, list] of byThread) {
    list.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const last = list.at(-1), lastAt = time(last.at);
    if (lastAt === null || now - lastAt > WINDOW) continue;
    const itemDone = doneThreads.has(tid);
    const flagged = !!last.resolved && !(last.kind === "ack" && docs.initiatives?.[tid]);
    if (flagged || itemDone) out.set(tid, { lastAt, why: itemDone ? "ask-closed" : "flagged" });
  }
  return out;
}

// The threads the store would show as resolved within 7 days after the import: its own (last message resolved, or its ask closed) plus the
// plan's (history threads and closed asks). `view` is the store's view; `h` the history plan.
export function storeResolvedAfter(view, h, now) {
  const msgs = view?.threads?.messages ?? [], byThread = new Map();
  for (const m of msgs) (byThread.get(m.thread_id) ?? byThread.set(m.thread_id, []).get(m.thread_id)).push(m);
  const out = new Set();
  for (const [tid, list] of byThread) {
    list.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    const last = list.at(-1);
    if (last && last.resolved && now - last.created_at <= WINDOW) out.add(tid);
  }
  for (const a of view?.asks ?? []) if (a.closed_at && now - a.closed_at <= WINDOW) out.add(a.id);
  // The plan's asks are keyed by their thread id (not their own id): an ask whose thread has another id would count once missing, once extra.
  const tidOf = (id) => h?.askThread?.[id] ?? id;
  if (h) {
    const msgLast = new Map();
    for (const m of h.messages) { const t = msgLast.get(m.thread_id); if (!t || m.created_at > t.created_at) msgLast.set(m.thread_id, m); }
    for (const m of h.messages) if (m.resolved && msgLast.get(m.thread_id) === m && now - m.created_at <= WINDOW) out.add(m.thread_id);
    for (const a of h.asks ?? []) if (now - a.closed_at <= WINDOW) out.add(tidOf(a.id));
    for (const a of h.closeOpen ?? []) if (now - a.closed_at <= WINDOW) out.add(tidOf(a.id));
  }
  return out;
}

// Why an old-page resolved thread is not in the store's set after the import.
function whyMissing(tid, docs, view, h) {
  const m = Object.values(docs.messages ?? {}).filter((x) => x && x.thread === tid && x.deleted !== true);
  const entry = Object.entries(docs.waiting ?? {}).find(([id, d]) => d && d.deleted !== true && d.done && threadOfAsk(id, d) === tid);
  if (entry) {
    const [aid, askDoc] = entry, how = h?.askOutcome?.[aid];
    // What became of this very ask in the plan (not of the run as a whole).
    if (how === "held") return "the store holds this ask closed already (the import never changes a closed ask)";
    if (how === "outsideWindow") return "closed ask older than the import window, or with no usable close time";
    if (how === "noThread") return "closed ask with no thread document or no #T number";
    if (how === "numTaken") return "closed ask whose #T number another ask or thread in the store (or an earlier planned ask) already uses (closedAsks.numTaken)";
    if (how?.startsWith("refused:")) return `closed ask the store's ask rules refuse (${how.slice(8)}; see closedAsks.refusedBy)`;
    if (how === undefined) return "closed ask the plan did not reach (no --history, or an ask id the store refuses)";
    const closedAt = time(askDoc.doneAt) ?? time(askDoc.response?.at) ?? time(askDoc.respondedAt) ?? time(askDoc.updatedAt);
    return `closed ask planned as "${how}" but dated outside the 7 day window${closedAt === null ? " (no close time)" : ""}`;
  }
  if (!m.length) return "no messages in the export";
  return "resolved thread not brought in (a message refused, or its thread number is missing)";
}

// p: the card plan (planDelta); a: the asks plan (planAsks), whose counts are the open items by tab; h: the history plan.
export function compareTabs({ docs, view, p, a, h, now = Date.now(), expect = {}, windowDays = 30 }) {
  const counts = { needs: a?.counts?.needs ?? 0, later: a?.counts?.later ?? 0, lead: a?.counts?.lead ?? 0, todo: a?.counts?.todo ?? 0, ideas: a?.counts?.ideas ?? 0 };
  const names = { needs: "Needs you", later: "Later", lead: "With the team", todo: "To-do", ideas: "Ideas", resolved: "Resolved, 7 days", inflight: "In flight" };
  const out = {};
  for (const k of ["needs", "later", "lead", "todo", "ideas"]) {
    const e = expect[k];
    out[k] = { tab: names[k], ours: counts[k], oldPage: e ?? null };
    if (e === undefined) out[k].note = "unchecked: no expected count given";
    else if (e !== counts[k]) out[k].difference = counts[k] - e;
  }
  // Resolved.
  const old = oldResolved(docs, now), after = storeResolvedAfter(view, h, now);
  const missing = [...old.keys()].filter((t) => !after.has(t)), extra = [...after].filter((t) => !old.has(t));
  const groups = {};
  for (const t of missing) { const w = whyMissing(t, docs, view, h); (groups[w] ??= []).push(t); }
  out.resolved = {
    tab: names.resolved, ours: after.size, oldPage: expect.resolved ?? null, oldPageByRule: old.size,
    note: expect.resolved === undefined ? "unchecked against the page: no expected count given; oldPageByRule is the page's rule run over the export" : undefined,
    difference: (expect.resolved ?? old.size) !== after.size ? after.size - (expect.resolved ?? old.size) : undefined,
    // What the two lists above do not explain: the page's own count minus ours, less (in the old rule but missing) plus (extra here). A number
    // other than 0 means the page counts something this reading of the export does not (its rule has more cases than oldPageByRule runs).
    unexplained: expect.resolved === undefined ? undefined : (expect.resolved - after.size) - (missing.length - extra.length),
    inOldNotAfter: Object.entries(groups).map(([reason, ids]) => ({ reason, count: ids.length, sample: ids.sort().slice(0, 5) })),
    afterNotInOld: extra.length ? { count: extra.length, sample: extra.sort().slice(0, 5), reason: "resolved in the store (its own writes or the import) but not by the old page's rule over the export" } : undefined,
  };
  // In flight: cards not done on the old board, against the store's open cards after the import.
  const oldOpen = Object.entries(docs.initiatives ?? {}).filter(([, d]) => d && d.deleted !== true && d.status !== "done" && !d.dropped).map(([id]) => id);
  const storeOpen = new Set((view?.cards ?? []).filter((c) => !c.dropped).map((c) => c.id));
  for (const r of p?.insert ?? []) storeOpen.add(r.id);
  const notInStore = oldOpen.filter((id) => !storeOpen.has(id)), onlyInStore = [...storeOpen].filter((id) => !oldOpen.includes(id));
  out.inflight = {
    tab: names.inflight, ours: storeOpen.size, oldPage: expect.inflight ?? null, oldPageByRule: oldOpen.length,
    note: expect.inflight === undefined ? "unchecked against the page: no expected count given" : undefined,
    difference: (expect.inflight ?? oldOpen.length) !== storeOpen.size ? storeOpen.size - (expect.inflight ?? oldOpen.length) : undefined,
    inOldNotInStore: notInStore.length ? { count: notInStore.length, sample: notInStore.sort().slice(0, 8), reason: "open on the old board, numbered below 719 or refused by the store's card rules: the store keeps cards from #C719 on (the earlier open ones are not carried)" } : undefined,
    inStoreNotInOld: onlyInStore.length ? { count: onlyInStore.length, sample: onlyInStore.sort().slice(0, 8), reason: "held open by the store, finished or absent on the old board" } : undefined,
  };
  for (const k of Object.keys(out)) for (const f of Object.keys(out[k])) if (out[k][f] === undefined) delete out[k][f];
  return out;
}
