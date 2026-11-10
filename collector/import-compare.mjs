// The dry run's comparison with the old page (#C824): the six tab counts and the in-flight count, each with a reason for every difference.
// Pure: the old board's documents, the store's view and the plan's rows in; numbers and ids out. Nothing here writes.
//   Needs you / Later / With the team / To-do / Ideas  the open items: what the plan carries (plus the store's own) against the old page's count
//   Resolved, 7 days  the threads resolved within 7 days on the old page's rule (the last message is resolved, or the thread's item is done)
//                     against the threads the store would show after the import (its own, plus the plan's)
//   In flight         the cards not done on the old board against the cards the store holds open after the import
// `expect` is what Manager read off the old page (--expect needs=N,later=N,lead=N,todo=N,ideas=N,resolved=N,inflight=N); a tab with no
// expected number is listed as unchecked. A difference is never left without a reason: what the export holds that the store will not show
// is grouped by why, and what the store will show that the old page does not is listed too.
import { oldTabs, storeTabs } from "./import-page.mjs";
const DAY = 86_400_000;
const WINDOW = 7 * DAY;
const time = (v) => (Number.isInteger(v) && v > 1_577_836_800_000 && v < 4_102_444_800_000 ? v : null);

// The threads the old page lists as resolved within `window` before `now`, by the page's own rule (threadResolved in page/board.template.html):
// not open (the owner's word is not the last unresolved one), and either the last message is resolved (an ack on a card's thread excepted) or
// its item (a waiting item or an idea or an initiative) is done. The page's clock is the thread's NEWEST message (threadLast).
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
    const ini = docs.initiatives?.[tid];
    const cardDone = !!ini && ini.deleted !== true && ini.status === "done" && !ini.dropped;
    const itemDone = doneThreads.has(tid) || cardDone;
    const flagged = !!last.resolved && !(last.kind === "ack" && docs.initiatives?.[tid]);
    if (flagged || itemDone) out.set(tid, { lastAt, why: doneThreads.has(tid) ? "ask-closed" : cardDone && !flagged ? "card-done" : "flagged" });
  }
  return out;
}

// The threads the store would list as resolved within 7 days after the import, by the SAME page rule (the new page runs the same page code):
// a thread with at least one message (the page's thread list comes from the message index: a closed ask with no message is not listed), its
// newest message in the window, and the newest message resolved, OR its ask closed, OR its card a history card. Map: thread id -> why.
// `view` is the store's view; `h` the history plan.
export function storeResolvedAfter(view, h, now) {
  const msgs = [...(view?.threads?.messages ?? []).map((m) => ({ id: m.id, thread: m.thread_id, at: m.created_at, resolved: !!m.resolved })),
    ...(h?.messages ?? []).map((m) => ({ id: m.id, thread: m.thread_id, at: m.created_at, resolved: !!m.resolved }))], byThread = new Map(), seen = new Set();
  const flaggedNow = new Set(h?.resolve ?? []);
  for (const m of msgs) { if (m.id !== undefined) { if (seen.has(m.id)) continue; seen.add(m.id); } if (flaggedNow.has(m.id)) m.resolved = true; (byThread.get(m.thread) ?? byThread.set(m.thread, []).get(m.thread)).push(m); }
  // The store's ask threads are keyed by the ask id (a store ask is its own thread); the plan's closed asks by their thread id.
  const askClosed = new Set((view?.asks ?? []).filter((a) => a.closed_at).map((a) => a.id));
  const tidOf = (id) => h?.askThread?.[id] ?? id;
  for (const a of h?.asks ?? []) askClosed.add(tidOf(a.id));
  for (const a of h?.closeOpen ?? []) askClosed.add(tidOf(a.id));
  const cardDone = new Set([...(view?.historyCards ?? []).map((c) => c.id), ...(h?.historyCards ?? []).map((c) => c.id)]);
  const out = new Map();
  for (const [tid, list] of byThread) {
    list.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const last = list.at(-1);
    if (!(now - last.at <= WINDOW)) continue;
    const why = last.resolved ? "flagged" : askClosed.has(tid) ? "ask-closed" : cardDone.has(tid) ? "card-done" : null;
    if (why) out.set(tid, { lastAt: last.at, why });
  }
  return out;
}

// Why an old-page resolved thread is not in the store's set after the import.
function whyMissing(tid, docs, view, h) {
  const m = Object.values(docs.messages ?? {}).filter((x) => x && x.thread === tid && x.deleted !== true);
  const entry = Object.entries(docs.waiting ?? {}).find(([id, d]) => d && d.deleted !== true && d.done && threadOfAsk(id, d) === tid);
  if (entry) {
    const [aid] = entry, how = h?.askOutcome?.[aid];
    // What became of this very ask in the plan (not of the run as a whole).
    if (how === "held") return "the store holds this ask closed already (the import never changes a closed ask)";
    if (how === "outsideWindow") return "closed ask older than the import window, or with no usable close time";
    if (how === "noThread") return "closed ask with no thread document or no #T number";
    if (how === "numTaken") return "closed ask whose #T number another ask or thread in the store (or an earlier planned ask) already uses (closedAsks.numTaken)";
    if (how?.startsWith("refused:")) return `closed ask the store's ask rules refuse (${how.slice(8)}; see closedAsks.refusedBy)`;
    if (how === undefined) return "closed ask the plan did not reach (no --history, or an ask id the store refuses)";
    return `closed ask planned as "${how}" but its thread did not come (a message refused, or no message)`;
  }
  if (!m.length) return "no messages in the export";
  return "resolved thread not brought in (a message refused, its card not a history card, or its thread number is missing)";
}

// p: the card plan (planDelta); a: the asks plan (planAsks); h: the history plan.
// The tabs are read off the PAGE (collector/import-page.mjs): the page's own script over the old export, and over the store's view after the
// import (the plan's rows laid in, compatView), so no tab rule is written again here (Checker on 06422f3). `oldPageByCode` is the old
// board's page code over the export; `oldPage` is what Manager read off the live page (--expect). To-do is not in the export.
// In flight is what the page DRAWS: the store's open cards less every card that reads live, on main with no check date (closeableNow).
export function compareTabs({ docs, view, p, a, h, now = Date.now(), expect = {}, windowDays = 30, owner = "Owner" }) {
  const oldT = oldTabs(docs, { now, owner }), newT = storeTabs(view, a, h, { now, owner });
  const counts = { needs: newT.counts.you, later: newT.counts.later, lead: newT.counts.lead, todo: newT.counts.todo, ideas: newT.counts.ideas };
  const byCode = { needs: oldT.counts.you, later: oldT.counts.later, lead: oldT.counts.lead, ideas: oldT.counts.ideas };
  const idsOf = { needs: newT.ids.you, later: newT.ids.later, lead: newT.ids.lead };
  const names = { needs: "Needs you", later: "Later", lead: "With the team", todo: "To-do", ideas: "Ideas", resolved: "Resolved, 7 days", inflight: "In flight" };
  const out = {};
  for (const k of ["needs", "later", "lead", "todo", "ideas"]) {
    const e = expect[k];
    out[k] = { tab: names[k], ours: counts[k], oldPage: e ?? null, ...(byCode[k] !== undefined ? { oldPageByCode: byCode[k] } : {}) };
    if (e === undefined) out[k].note = "unchecked: no expected count given";
    else if (e !== counts[k]) out[k].difference = counts[k] - e;
    if (idsOf[k]) out[k].asks = idsOf[k];
  }
  // Resolved: the threads the page lists, old export against the store after the import.
  const oldIds = new Set(oldT.ids.resolved), afterIds = new Set(newT.ids.resolved), classify = storeResolvedAfter(view, h, now);
  const missing = [...oldIds].filter((t) => !afterIds.has(t)), extra = [...afterIds].filter((t) => !oldIds.has(t));
  const groups = {};
  for (const t of missing) { const w = whyMissing(t, docs, view, h); (groups[w] ??= []).push(t); }
  const extraBy = {};
  for (const t of extra) { const w = classify.get(t)?.why ?? "page"; (extraBy[w] ??= []).push(t); }
  const extraWhy = { flagged: "its newest message is resolved in the store (its own write or the import); the old export does not hold that flag", "ask-closed": "its ask is closed in the store (the import or Manager) and it has messages; the old export does not list it as done", "card-done": "its card is a history card in the store; the old export does not hold the card as done", page: "the page lists it by a rule the store's rows meet and the export's do not" };
  out.resolved = {
    tab: names.resolved, ours: afterIds.size, oldPage: expect.resolved ?? null, oldPageByCode: oldIds.size,
    note: expect.resolved === undefined ? "unchecked against the page: no expected count given; oldPageByCode is the old page code run over the export" : undefined,
    difference: (expect.resolved ?? oldIds.size) !== afterIds.size ? afterIds.size - (expect.resolved ?? oldIds.size) : undefined,
    // The page's own count (the screenshot) minus ours, less (listed by the old code but missing) plus (extra here): 0 when the lists explain it.
    unexplained: expect.resolved === undefined ? undefined : (expect.resolved - afterIds.size) - (missing.length - extra.length),
    inOldNotAfter: Object.entries(groups).map(([reason, ids]) => ({ reason, count: ids.length, ids: ids.sort() })),
    afterNotInOld: Object.entries(extraBy).map(([why, ids]) => ({ why, count: ids.length, reason: extraWhy[why], ids: ids.sort(), allHaveMessages: true })),
  };
  // In flight: the cards not done on the old board (28 active + the paused one), against the cards the page will DRAW from the store.
  const oldOpen = Object.entries(docs.initiatives ?? {}).filter(([, d]) => d && d.deleted !== true && d.status !== "done" && d.status !== "dropped" && !d.dropped).map(([id]) => id);
  const cards = new Map((view?.cards ?? []).filter((c) => !c.dropped).map((c) => [c.id, c]));
  const storeOpen = new Set(cards.keys());
  for (const r of p?.insert ?? []) storeOpen.add(r.id);
  // The page decides which cards it draws: its shown card (asShown) is done when the evidence closes it (live, on main, no check date).
  // A card the plan inserts is not in the view yet, so no evidence reads it: it is drawn.
  const shown = new Map(newT.cards.map((c) => [c.id, c]));
  const closeable = (id) => shown.get(id)?.status === "done";
  const hidden = [...storeOpen].filter(closeable).sort(), drawn = [...storeOpen].filter((id) => !closeable(id)).sort();
  const notInStore = oldOpen.filter((id) => !storeOpen.has(id)), onlyInStore = [...storeOpen].filter((id) => !oldOpen.includes(id));
  const whyStays = (id) => { const e = view?.evidence?.[`cards.${id}`]?.value, c = cards.get(id); return !e ? "no evidence (no commit carries its id yet)" : c?.check_at ? "has a check date" : e.phase !== "live" ? `phase ${e.phase}` : e.onMain !== true ? "not on main" : "?"; };
  out.inflight = {
    tab: names.inflight, ours: drawn.length, oldPage: expect.inflight ?? null, oldPageByRule: oldOpen.length,
    note: expect.inflight === undefined ? "unchecked against the page: no expected count given" : undefined,
    difference: (expect.inflight ?? oldOpen.length) !== drawn.length ? drawn.length - (expect.inflight ?? oldOpen.length) : undefined,
    storeOpen: storeOpen.size, hiddenByEvidence: { count: hidden.length, ids: hidden, reason: "live and on main with no check date: the page hides it (closeableNow)" },
    drawn: drawn.map((id) => ({ id, why: whyStays(id) })),
    inOldNotInStore: notInStore.length ? { count: notInStore.length, ids: notInStore.sort(), reason: "open on the old board and not a store card" } : undefined,
    inStoreNotInOld: onlyInStore.length ? { count: onlyInStore.length, ids: onlyInStore.sort(), reason: "made on the store, or finished on the old board and held open by the store" } : undefined,
  };
  for (const k of Object.keys(out)) for (const f of Object.keys(out[k])) if (out[k][f] === undefined) delete out[k][f];
  return out;
}
