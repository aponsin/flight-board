// #C1385 (one-reading-module step 2, the gates): rule A of "a groupmate is not built yet", written once and imported by nothing (so the owner's pinned scripts can take it without taking board-rules).
// A card at a review phase, on a stack that it is still inside, waits for its group while another open member of the same batch has no lit phase yet or is still at build. The reading
// (worker/reading.mjs waitOf), the stall line and the slow wake (worker/board-rules.mjs) all call this one function. The four other readings of a group ("no head", "same repository and not
// held", "not signed", "still to land") answer other questions and stay where they are (collector/store-dispatch.mjs, scripts/stack-ready.mjs, scripts/board-land.mjs).
export const REVIEW_PHASES = ["language", "design", "checker", "security"];
export function groupWaits(c, v, cards, evidence) {
  if (!c?.batch || !REVIEW_PHASES.includes(v?.lit?.[0]) || v.onMain === true || !v.stack || v.stack.outside === true) return false;
  return (cards ?? []).some((k) => k && k.id !== c.id && k.batch === c.batch && !k.done_at && !k.dropped && !k.paused && (!evidence?.[k.id]?.lit?.[0] || evidence[k.id].lit[0] === "build"));
}
