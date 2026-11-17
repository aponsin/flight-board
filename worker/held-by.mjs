// #C1164 (Manager's audit 11-17: waiting_on was read five ways, a sixth in gate/reset.mjs): the ONE reading of a card's waiting_on. Pure, no imports (the Worker, the collector and the hook-loaded
// gate/reset.mjs all load it; worker/board-rules.mjs re-exports it).
//
// waiting_on names who the card waits on. From one role's side it holds the card when it has words and does not start with that role: "waiting on the owner" and "next is Checker" hold it for the owner;
// "Checker: Full review" holds it for the owner but not for Checker; "Boardsmith: next" on a Boardsmith card is the owner's own pointer and holds nothing; empty holds nothing. Returns the words
// (truthy) or null. The role is the card's owner by default. The hold's END is the store's (check_at, hold_end, or the 2 h it gives a waiting_on), not this function's.
export const isHeldBy = (c, role = c?.owner_role) => {
  const w = c && typeof c.waiting_on === "string" ? c.waiting_on.trim() : "";
  return w !== "" && !(typeof role === "string" && role !== "" && w.startsWith(role)) ? w : null;
};
// The same, for a dispatch card (its words are in waitingOn and its owner in who).
export const heldFor = (k, role = k?.who) => isHeldBy({ waiting_on: k?.waitingOn }, role);
