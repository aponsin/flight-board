// #C1337 (11-20: the dispatch told Boardsmith that #C1335, a fold in its own group cut from main, was "outside the stack" and must be re-cut on board-polish-seven's tip): folds go alone
// (the owner, 11-17) and a re-cut would void the fold's SECURE. A fold card (its id starts `fold-data-fragments`, the landing job's own rule) in its own group is never outside another group's
// stack: it carries no stack field. An ordinary small card that was not cut from the tip is still outside, and a fold card that IS under the tip is still a member.
import test from "node:test";
import assert from "node:assert/strict";
import { readStack, stackFields, isFoldCard } from "../collector/stack.mjs";

const history = (parents) => (a, b) => { for (let x = b; x; x = parents[x]) if (x === a) return true; return false; };
const P = { c1: "c0", c2: "c1", c3: "c2", f1: "m0", z1: "m0", c0: "m0", m0: null };
const tips = [{ branch: "build/stack", sha: "c3", at: 3 }, { branch: "build/fold-data-fragments-1120", sha: "f1", at: 9 }, { branch: "build/z", sha: "z1", at: 8 }];

test("a fold card cut from main is not outside another group's stack and carries no stack field", () => {
  const s = readStack({ heads: { a: "c1", b: "c2", c: "c3", "fold-data-fragments-1120": "f1" }, tips, isAncestor: history(P) });
  assert.deepEqual(s.members, ["a", "b", "c"]);
  assert.deepEqual(s.outside, [], "the fold is no outsider");
  assert.equal("fold-data-fragments-1120" in stackFields(s), false);
  assert.equal(stackFields(s).a.size, 3);
});

test("must still refuse: an ordinary small card not cut from the stack tip is outside, with the fold beside it left alone", () => {
  const s = readStack({ heads: { a: "c1", b: "c2", z: "z1", "fold-data-fragments-1120": "f1" }, tips, isAncestor: history(P) });
  assert.deepEqual(s.outside, ["z"]);
  assert.deepEqual(stackFields(s).z, { outside: true, branch: "build/stack" });
  assert.equal("fold-data-fragments-1120" in stackFields(s), false);
});

test("a fold card whose head is under the stack tip is still a member of it", () => {
  const s = readStack({ heads: { a: "c1", "fold-data-fragments-1120": "c2" }, tips: [{ branch: "build/stack", sha: "c3", at: 3 }], isAncestor: history(P) });
  assert.deepEqual(s.members, ["a", "fold-data-fragments-1120"]);
});

test("isFoldCard: the Board-Id prefix of a fold, as the landing job reads it; a card only named like one, or no string, is not", () => {
  assert.equal(isFoldCard("fold-data-fragments"), true);
  assert.equal(isFoldCard("fold-data-fragments-1120"), true);
  assert.equal(isFoldCard("fold-data-fragments-2026-11-16-v5"), true);
  assert.equal(isFoldCard("my-fold-data-fragments"), false);
  assert.equal(isFoldCard("fold-data"), false);
  assert.equal(isFoldCard(undefined), false);
  assert.equal(isFoldCard(1335), false);
});
