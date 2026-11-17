// #C1145 (a gap named in #C1144): the holds file's same-repository filter must not skip a member of the group that has no commit yet, and must not read two spellings of one
// repository as two repositories (that dropped a peer and let a lone tip land alone, as #C1126 did). A card with no branch is still a member to land; a card of ANOTHER repository,
// with or without a commit, is no peer.
import test from "node:test";
import assert from "node:assert/strict";
import { landHoldsFile } from "../collector/store-dispatch.mjs";
import { landPlan } from "../scripts/board-land.mjs";

const NOW = 1_800_000_000_000;
const card = (id, over = {}) => ({ id, batch: "g-one", owner_role: "Boardsmith", repo: "flight-board", ...over });
const ev = (phase) => ({ value: { phase, lit: [phase] } });
const view = (cards, phases = {}) => ({ cards, evidence: Object.fromEntries(Object.entries(phases).map(([id, p]) => [`cards.${id}`, ev(p)])) });
const sha = (n) => String(n).padStart(40, "0");
const head = (n, over = {}) => ({ branch: `build/${n}`, sha: sha(n.length), notes: { checker: "PASS Full", security: "SECURE" }, cards: [n], onMain: false, forward: true, ahead: 1, dataLines: 0, ...over });

test("a member with no commit yet (no reading at all, any repository word it may have) is a peer to land: the signed cards list it and a lone tip waits for it", () => {
  for (const repo of ["flight-board", "board", null, "", undefined, 7]) {
    const v = view([card("a"), card("b"), card("late", { repo })], { a: "ship", b: "ship" }); // `late` has no evidence: nothing pushed
    const g = landHoldsFile(v, NOW).groups;
    assert.deepEqual(g.a, ["b", "late"], `a waits for b and for late (repo ${JSON.stringify(repo)})`);
    assert.deepEqual(g.late, ["a", "b"], "and the card with no commit has its own peers");
    const plan = landPlan({ heads: [head("a")], holds: landHoldsFile(v, NOW), now: NOW });
    assert.deepEqual(plan.try, [], "a lone tip does not land");
    assert.match(plan.waiting[0].why, /^held: a \(group\)/, "a is held by the unsigned member that has no commit");
  }
  // the member's own review is done elsewhere (signed or landed reading) yet it has no commit in this repository's view of the group: the `groups` list still stops the lone tip
  const signedLate = view([card("a"), card("b"), card("late")], { a: "ship", b: "ship", late: "ship" });
  const holds = landHoldsFile(signedLate, NOW);
  assert.deepEqual(holds.cards, { a: "", b: "", late: "" });
  const plan = landPlan({ heads: [head("a")], holds, now: NOW });
  assert.deepEqual(plan.try, []);
  assert.match(plan.waiting[0].why, /^its group is not whole: this tip lacks b, late,/);
});

test("a member of ANOTHER repository with no commit yet is no peer, and neither is it for its own repository's cards the other way round", () => {
  const v = view([card("a"), card("b"), card("far", { repo: "elsewhere" })], { a: "ship", b: "ship" });
  const g = landHoldsFile(v, NOW).groups;
  assert.deepEqual(g.a, ["b"]);
  assert.equal(Object.hasOwn(g, "far"), false, "alone in its repository: nothing to wait for");
});

test("two spellings of one repository are one repository: case, spaces, an owner front and a .git end never drop a peer", () => {
  for (const other of ["Flight-Board", " flight-board ", "aponsin/flight-board", "flight-board.git", "ponsin/Flight-Board.git", "BOARD", "owner/board"]) {
    const g = landHoldsFile(view([card("a"), card("b", { repo: other })], { a: "ship", b: "build" }), NOW).groups;
    assert.deepEqual(g.a, ["b"], `${JSON.stringify(other)} is the board's repository`);
    assert.deepEqual(g.b, ["a"]);
  }
  for (const [x, y] of [["Elsewhere", "elsewhere"], ["me/elsewhere", "elsewhere"], ["elsewhere.git", " ELSEWHERE "]]) {
    const g = landHoldsFile(view([card("a", { repo: x }), card("b", { repo: y })], { a: "ship", b: "build" }), NOW).groups;
    assert.deepEqual(g.a, ["b"], `${x} and ${y} are one repository`);
  }
});

test("repositories that really differ still drop the peer, and a word that reads to nothing is unknown and stays a peer", () => {
  for (const [x, y] of [["flight-board", "elsewhere"], ["elsewhere", "other"], ["me/elsewhere", "me/other"], ["flight-board-x", "flight-board"]]) {
    const g = landHoldsFile(view([card("a", { repo: x }), card("b", { repo: y })], { a: "ship", b: "build" }), NOW).groups;
    assert.deepEqual(g, {}, `${x} and ${y} differ`);
  }
  for (const odd of ["/", "owner/", ".git", "   "]) {
    const g = landHoldsFile(view([card("a"), card("b", { repo: odd })], { a: "ship", b: "build" }), NOW).groups;
    assert.deepEqual(g.a, ["b"], `${JSON.stringify(odd)} names nothing: unknown, a peer (the lone tip waits)`);
  }
});
