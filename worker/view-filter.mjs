// What the read_view tool hands an agent (#C1089). The store's whole view is about 5.4 MB (4816 messages): no agent can read it, and Ops could not
// list its own open cards. The tool now takes one of:
//   owner_role  the open cards that role owns and the open asks it asked or that sit on one of those cards, nothing else (a few KB)
//   thread_id   one thread and its messages
//   full: true  the whole view (the shared checks that read every ask, scripts/approvals-check.mjs, say so)
//   nothing     a short summary: the tags, the live and probe state, and the open cards and asks counted per role
// Only the tool's answer is cut here. readView itself, which the page, the probe and the dispatch read, is not touched. Pure.

const open = (c) => !c.done_at && !c.dropped;
const openAsk = (a) => !a.closed_at && !a.withdrawn_at;

const head = (view) => ({ tag: view.tag, now: view.now, live: view.live, probe: view.probe, wakeState: view.wakeState });

export function viewForTool(view, args = {}) {
  if (args.full === true) return view;
  if (typeof args.thread_id === "string" && args.thread_id !== "") {
    const id = args.thread_id;
    const thread = (view.threads?.threads ?? []).find((t) => t.id === id) ?? null;
    return { ...head(view), thread_id: id, thread, messages: (view.threads?.messages ?? []).filter((m) => m.thread_id === id) };
  }
  if (typeof args.owner_role === "string" && args.owner_role !== "") {
    const role = args.owner_role;
    const cards = view.cards.filter((c) => open(c) && c.owner_role === role);
    const ids = new Set(cards.map((c) => c.id));
    const asks = view.asks.filter((a) => openAsk(a) && (a.asked_by === role || ids.has(a.card_id)));
    return { ...head(view), owner_role: role, cards, asks };
  }
  const perRole = {};
  for (const c of view.cards) if (open(c)) { const r = c.owner_role ?? "none"; perRole[r] = (perRole[r] ?? 0) + 1; }
  const asksOpen = view.asks.filter(openAsk);
  return { ...head(view), summary: true, openCardsByRole: perRole, openCards: Object.values(perRole).reduce((a, b) => a + b, 0), openAsks: asksOpen.length, threads: view.threads?.threads?.length ?? 0, messages: view.threads?.messages?.length ?? 0, hint: "Pass owner_role (a role's open cards and asks), thread_id (one thread's messages) or full: true (the whole view, about 5 MB)." };
}
