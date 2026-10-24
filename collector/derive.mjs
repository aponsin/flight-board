// The collector's reasoning (board-brief section 3): each card's phase worked out from the repository, never from what
// someone remembered to write. Pure: the card, the facts about its commits and the config come in; the derived phase goes
// out. collector/facts.mjs gathers the facts from git and the CI runs.
//
// The phases, in the config's order, are read as:
//   build  - a branch exists for the card, and its head is not READY;
//   review - READY (a commit trailer "Board-Id: <id>" on the head, or the card names its head), and a review phase that
//            the card doesn't skip has no sign-off note on the head yet: the first such phase is the card's phase;
//   ship   - every review it needs has signed the head, and the head isn't on the main branch yet;
//   live   - the head is on the main branch and a successful deploy run contains it (with the version it shipped in).
// Anything the facts can't show (plan, a card with no branch) is left as declared: derived is null.

// The id a commit's message names in its "Board-Id:" trailer, or null.
export function boardIdOf(message) {
  const m = /^Board-Id:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/im.exec(String(message ?? ""));
  return m ? m[1].toLowerCase() : null;
}

// The card's commit: a "Board-Id" trailer on a branch head wins, else a branch whose last path segment is the card's id.
// heads: [{ branch, sha, at, message }]. Returns the newest match, or null.
export function headFor(id, heads) {
  const byTrailer = heads.filter((h) => boardIdOf(h.message) === id);
  const byName = heads.filter((h) => String(h.branch).split("/").pop() === id);
  const pick = (list) => list.slice().sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0] ?? null;
  return pick(byTrailer) ?? pick(byName);
}

// The review phases a card needs: the config's review phases, minus the ones its skips or its fields rule out.
export function reviewsFor(card, config) {
  const c = config.collector;
  const skip = new Set(Array.isArray(card.skip) ? card.skip : []);
  for (const k of config.skips ?? []) {
    if (k.unlessLevel && card.level && card.level !== k.unlessLevel) skip.add(k.phase);
    if (k.whenFalse && card[k.whenFalse] === false) skip.add(k.phase);
  }
  return Object.keys(c.notes).filter((p) => !skip.has(p));
}

// { phase, head, version, evidence } for one card, or { phase: null } when the facts say nothing.
// facts: { head: {branch, sha, message} | null, signed: Set of phases with a note on head.sha, onMain, deployed, version }
export function derivePhase(card, facts, config) {
  const c = config.collector;
  if (!facts.head) return { phase: null, evidence: "no branch or Board-Id commit for this card" };
  const head = facts.head.sha;
  const short = String(head).slice(0, 8);
  if (facts.onMain && facts.deployed) return { phase: c.livePhase, head, version: facts.version ?? null, evidence: `${short} is on ${c.mainBranch} and deployed${facts.version ? ` in ${facts.version}` : ""}` };
  if (facts.onMain) return { phase: c.shipPhase, head, version: facts.version ?? null, evidence: `${short} is on ${c.mainBranch}, not deployed yet` };
  const ready = boardIdOf(facts.head.message) === card.id || facts.ready === true;
  if (!ready) return { phase: c.buildPhase, head, evidence: `${facts.head.branch} at ${short}, not READY` };
  const order = config.phases.map((p) => p[0]);
  const waiting = reviewsFor(card, config).filter((p) => !facts.signed.has(p)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (waiting.length) return { phase: waiting[0], head, evidence: `READY at ${short}; waiting for ${waiting.join(", ")}` };
  return { phase: c.shipPhase, head, evidence: `READY at ${short}; every review signed` };
}

// A conflict line when the card's declared phase disagrees with the derived one (one line per card, for the lead).
export function conflict(card, derived, config) {
  if (!derived?.phase || !card.phase || card.status === "done") return null;
  if (card.phase === derived.phase) return null;
  const order = config.phases.map((p) => p[0]);
  const behind = order.indexOf(card.phase) < order.indexOf(derived.phase);
  return `${card.id}: the card says ${card.phase}, the repository says ${derived.phase} (${derived.evidence})${behind ? "" : "; the card is ahead of its evidence"}`;
}

// The first pass's close-out: every card still marked active whose work is live by the evidence.
export function staleLive(cards, derivedById, config) {
  return cards.filter((k) => k.status !== "done" && derivedById[k.id]?.phase === config.collector.livePhase).map((k) => k.id);
}
