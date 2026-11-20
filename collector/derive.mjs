// What is left of the collector's old reasoning (board-brief section 3). #C1388: the phase rule (derivePhase and the head readers
// it used: headsFor, reviewsFor, bareBranch, byNumberOnly) is gone from here. The one phase rule is collector/state.mjs's phaseOf,
// the file the probe pins; this file kept a second copy that only tests ran. What stays is read by collector/expected.mjs (repoOf,
// closed) and by the notes below.
import { idText, lineText } from "./text.mjs";
import { boardIdOf } from "./board-id.mjs";

// The repository a card lives in (#C278): one of collector.repos by the card's own repo field, else the first whose id
// prefix the card carries; null for the team's own repository (collector.repoPath).
// #C985: a repo word that names no listed repository ("board" on 10 cards on 11-11, where the list says "flight-board") is read as no
// word at all: the id prefix, then the repository whose branches name the card (#C632), as for a card with none. namedRepo says which.
export const namedRepo = (card, config) => (card.repo ? (config.collector.repos ?? []).find((r) => r.name === card.repo) ?? null : null);
export function repoOf(card, config) {
  const repos = config.collector.repos ?? [];
  return namedRepo(card, config) ?? repos.find((r) => (r.idPrefixes ?? []).some((p) => String(card.id).startsWith(p))) ?? null;
}

// The id a commit's message names in its "Board-Id:" trailer, or null (#C1166: git's reading, collector/board-id.mjs).
export { boardIdOf };

// #C654: a plain build start with no work behind it. A PLAIN start (no wait) is open until the same role ends that card; after
// ABANDON_MS with no evidence (the card has no commit or branch head, and the role is not working on it in the fresh live
// state) the start is treated as closed at start.at + ABANDON_MS, so the board does not show a card building for a start
// nobody acted on. Returns the latest such close time, or null. Pure: steps, the card's derived reading, the live state.
export const ABANDON_MS = 30 * 60 * 1000;
export function abandonedAt({ steps, cardId, derived, liveState = null, buildPhase, now }) {
  if (derived?.head || derived?.workSeen === true || (Array.isArray(derived?.branches) && derived.branches.length)) return null;
  const mine = (Array.isArray(steps) ? steps : []).filter((s) => s && s.init === cardId && s.phase === buildPhase && Number.isFinite(s.at) && typeof s.who === "string");
  const open = new Map();
  for (const s of mine.slice().sort((a, b) => a.at - b.at)) {
    if (s.kind === "start" && !s.wait) open.set(s.who, s.at);
    else if (s.kind === "end") open.delete(s.who);
  }
  let out = null;
  for (const [who, at] of open) {
    if (!(now - at >= ABANDON_MS)) continue;
    const a = liveState?.agents?.[who];
    if (a && typeof a === "object" && a.state === "working" && a.card === cardId) continue;
    out = Math.max(out ?? -Infinity, at + ABANDON_MS);
  }
  return out;
}

// A conflict line when the card's declared phase disagrees with the derived one (one line per card, for the lead).
export const closed = (card) => card.status === "done" || card.status === "dropped";

// A card ahead of evidence that can't be firm (a head with no trailer or note yet) is no conflict: the evidence is missing.
export function conflict(card, derived, config) {
  if (!derived?.phase || !card.phase || closed(card)) return null;
  if (card.phase === derived.phase) return null;
  const order = config.phases.map((p) => p[0]);
  const behind = order.indexOf(card.phase) < order.indexOf(derived.phase);
  if (!behind && derived.firm === false) return null;
  return `${idText(card.id)}: the card says ${idText(card.phase)}, the repository says ${idText(derived.phase)} (${lineText(derived.evidence)})${behind ? "" : "; the card is ahead of its evidence"}`;
}

// The owner's asks tied to a card and still open: the gate's rule 5 refuses to close the card while there is one.
export function openAsks(waiting, id) {
  return (waiting ?? []).filter((x) => x.initiative === id && !x.done && !x.response);
}

// The first pass's close-out: every card still marked active whose work is live by the evidence, and that the lead
// can close now: one with an open ask tied to it waits for the ask, so it isn't the lead's to act on (#C440).
export function staleLive(cards, derivedById, config, waiting = []) {
  return cards.filter((k) => !closed(k) && derivedById[k.id]?.phase === config.collector.livePhase && !openAsks(waiting, k.id).length).map((k) => k.id);
}
