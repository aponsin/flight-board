// #C1381 (one-reading-module step 2): the Worker serves each card's reading, and the groups and crew views folded from the readings. Three new collections in the compat
// answer, `readings`, `groups` and `crew`; the page does not read them yet (step 3 moves its card rows, group rows and "Who is on what" onto them, and deletes the rules they
// replace), so nothing on the board changes with this step. Everything here is worker/reading.mjs's: this file only gathers what the view holds and hands it over.
import { reading, groupReading, crewColumns } from "./reading.mjs";
import { groupOf, phaseMedians } from "./board-rules.mjs";

export const CLOSED_WINDOW_MS = 7 * 86_400_000; // a card closed in the last 7 days is still served (the contract: every open card and every card closed in the last 7 days)

// What the view holds, in the shapes reading() takes.
export function readingInputs(view) {
  const now = view.now;
  const cards = (view.cards ?? []).filter((c) => c && !c.dropped && (!c.done_at || now - c.done_at <= CLOSED_WINDOW_MS));
  const evidence = {}, valueOf = (id) => view.evidence?.[`cards.${id}`]?.value ?? null;
  for (const c of view.cards ?? []) evidence[c.id] = valueOf(c.id) ?? undefined;
  const agents = view.evidence?.agents?.value && typeof view.evidence.agents.value === "object" ? view.evidence.agents.value : {};
  const phaseStart = new Map();
  for (const h of view.history ?? []) if (h.kind === "start" && !h.wait && Number.isFinite(h.at)) phaseStart.set(`${h.card_id}|${h.phase}`, Math.max(h.at, phaseStart.get(`${h.card_id}|${h.phase}`) ?? 0));
  const closedAsks = new Set((view.asks ?? []).filter((a) => a.closed_at).map((a) => a.id)), doneCards = new Set((view.cards ?? []).filter((c) => c.done_at || c.dropped).map((c) => c.id));
  const endsPassed = new Set([...closedAsks, ...doneCards]);
  const reviewers = view.evidence?.reviewers?.value?.reviewers;
  return {
    now, cards, agents, config: reviewers ? { reviewers } : {},
    ctx: { asks: (view.asks ?? []).filter((a) => !a.closed_at && !a.answered_at && !a.withdrawn_at && a.card_id).map((a) => ({ card_id: a.card_id, num: a.num })), cards: view.cards ?? [], evidence, phaseStart, medians: phaseMedians(view.history), endsPassed },
    claimsOf: (id) => (Array.isArray(view.reviewClaims) ? view.reviewClaims : []).filter((r) => r && r.card_id === id),
    valueOf,
  };
}

// The readings of every open card and every card closed in the last 7 days, each with the card's id, number, group and repository beside it.
export function readingDocs(view) {
  const { now, cards, agents, config, ctx, claimsOf, valueOf } = readingInputs(view);
  return cards.map((c) => {
    const r = reading(c, valueOf(c.id), claimsOf(c.id), agents, config, now, ctx);
    // `closed`: the store closed the card (done_at). A closed card whose reading is not live yet (the audit's 71) keeps its reading, but it is nobody's open card: no crew column.
    // Paused and Blocked are typed overlays (the contract keeps them): the card's tile is the yellow wait whatever the reading under it says, and nobody on it makes it no more working.
    const overlay = !c.done_at ? (c.paused ? "paused" : c.blocked_reason ? "blocked" : null) : null;
    return { id: c.id, num: c.num, ...(groupOf(c) ? { batch: groupOf(c) } : {}), ...(c.repo ? { repo: c.repo } : {}), ...(c.done_at ? { closed: true } : {}), ...r, ...(overlay ? { overlay, working: false } : {}) };
  });
}

// The groups' rows: one per group (batch) that has a card among the readings, folded from the members' readings and nothing else.
export function groupDocs(docs) {
  const by = new Map();
  for (const d of docs) if (d.batch) { if (!by.has(d.batch)) by.set(d.batch, []); by.get(d.batch).push(d); }
  return [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([batch, members]) => ({ id: batch, batch, members: members.map((m) => m.id), ...groupReading(members) }));
}

export function applyReadings(collections, view) {
  const docs = readingDocs(view);
  collections.readings = docs;
  collections.groups = groupDocs(docs);
  collections.crew = [{ id: "crew", at: view.now, columns: crewColumns(docs) }];
}
