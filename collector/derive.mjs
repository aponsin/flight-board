// What is left of the collector's old reasoning (board-brief section 3). #C1388: the phase rule (derivePhase and the head readers
// it used: headsFor, reviewsFor, bareBranch, byNumberOnly) is gone from here. The one phase rule is collector/state.mjs's phaseOf,
// the file the probe pins; this file kept a second copy that only tests ran. #C1393: abandonedAt, conflict, openAsks and staleLive
// are gone too (nothing read them). What stays is read by collector/expected.mjs (repoOf, closed) and by the notes below.
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

export const closed = (card) => card.status === "done" || card.status === "dropped";
