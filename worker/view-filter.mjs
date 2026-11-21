// What the read_view tool hands an agent (#C1089). The store's whole view is about 5.4 MB (4816 messages): no agent can read it, and Ops could not list its
// own open cards. The tool takes, besides nothing:
//   owner_role  the open cards that role owns, the evidence for those cards (the pickup digest reads each card's phase from it), and the open asks it asked or
//               that sit on one of those cards: a few KB
//   thread_id   one thread and its messages
//   message_id  one message the owner wrote (#C1125), to check a forwarded owner answer against the board
//   summary     true: a short summary (the tags, the live and probe state, the open cards and asks counted per role)
//   nothing     the whole view, as before: the pickup digest (scripts/pickup-digest.mjs) and the release check (scripts/approvals-check.mjs) read it
// Only the tool's answer is cut here. readView itself, which the page, the probe and the dispatch read, is not touched. Pure.

const open = (c) => !c.done_at && !c.dropped;
// #C1101: a withdrawn approval has its answer cleared and waits for the owner's Approve again, so it is still open: the pickup digest has counted it as open since
// #C826 W1 (and so does the dispatch, collector/store-dispatch.mjs), and a role's answer here must list it too.
const openAsk = (a) => !a.closed_at;

const head = (view) => ({ tag: view.tag, now: view.now, live: view.live, probe: view.probe, wakeState: view.wakeState });

// #C1125 (11-16: Manager forwarded the owner's answer with its message id and thread, and the builder could not check it against the source, so it asked the owner again in its
// own chat): message_id returns ONE message by its id, only when the owner wrote it: { id, thread_id, author, body, created_at }. A message by anyone else, or no such id, is
// `message: null`, so the tool is the check on a forwarded owner answer and nothing wider. The id must be a plain id (letters, digits, "-", "_", at most 64): nothing else is looked up.
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ownerMessage = (m) => ({ id: m.id, thread_id: m.thread_id, author: m.author, body: m.body, created_at: m.created_at });

export function viewForTool(view, args = {}) {
  if (typeof args.message_id === "string" && args.message_id !== "") {
    const id = args.message_id;
    const m = MESSAGE_ID.test(id) ? (view.threads?.messages ?? []).find((x) => x.id === id && x.author === "owner") : null;
    return { ...head(view), message_id: id, message: m ? ownerMessage(m) : null };
  }
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
    // The evidence the digest reads for each card (key "cards.<id>"): its phase, so a live card is not shown as open.
    const evidence = Object.fromEntries(cards.map((c) => [`cards.${c.id}`, view.evidence?.[`cards.${c.id}`]]).filter(([, v]) => v !== undefined));
    return { ...head(view), owner_role: role, cards, asks, evidence };
  }
  if (args.summary === true) {
    const perRole = {};
    for (const c of view.cards) if (open(c)) { const r = c.owner_role ?? "none"; perRole[r] = (perRole[r] ?? 0) + 1; }
    const asksOpen = view.asks.filter((a) => openAsk(a) && !a.outdated_at); // an outdated ask (#C1409) is owed by no one
    return { ...head(view), summary: true, openCardsByRole: perRole, openCards: Object.values(perRole).reduce((a, b) => a + b, 0), openAsks: asksOpen.length, threads: view.threads?.threads?.length ?? 0, messages: view.threads?.messages?.length ?? 0, hint: "Pass owner_role (a role's open cards, their evidence and its open asks) or thread_id (one thread's messages); with neither, and no summary, you get the whole view (about 5 MB)." };
  }
  return view;
}
