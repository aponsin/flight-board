// #C1204: the probe finds a card's head when the signed commit's subject is "#C<num> (<Role>): ..." or the branch's last segment is
// "c<num>-...", with no Board-Id trailer. (#C1388: collector/derive.mjs's second copy is gone; state.mjs is the one reading.)
import test from "node:test";
import assert from "node:assert/strict";
import { headsFor, subjectNum, branchNum, bareBranch } from "../collector/state.mjs";

const head = (sha, branch, message, at = 1) => ({ sha, branch, message, at });

test("a subject '#C<num> (<Role>):' names the card by its number, as '#C<num>:' does", () => {
  assert.equal(subjectNum("#C1190 (Reviewer): the plans move to the store"), 1190);
  assert.equal(subjectNum("#C1190: the plans move to the store"), 1190);
  assert.equal(subjectNum("#C1190 the plans"), null, "no colon and no bracket: not a card subject");
  assert.equal(subjectNum("fix #C1190 (Reviewer): later in the line"), null, "only at the start");
  assert.equal(subjectNum("#C1190(Reviewer): no space"), null);
  assert.equal(subjectNum(null), null);
});

test("a branch whose last segment starts 'c<num>-' names the card by its number", () => {
  assert.equal(branchNum("refactor/c1190-plans-store"), 1190);
  assert.equal(branchNum("c1190-x"), 1190);
  assert.equal(branchNum("refactor/c1190"), null, "no dash after the number");
  assert.equal(branchNum("refactor/c1190x-plans"), null);
  assert.equal(branchNum("refactor/ac1190-plans"), null);
  assert.equal(branchNum("refactor/c1190-plans/more"), null, "the last segment is the one read");
  assert.equal(branchNum(undefined), null);
});

test("headsFor finds the head by the role subject or by the numbered branch", () => {
  const hs = [
    head("1", "refactor/c1190-plans-store", "#C1190 (Reviewer): the plans move to the store", 5),
    head("2", "other/branch", "#C1190 (Reviewer): a second branch with the role subject", 4),
    head("3", "refactor/c1191-other", "no subject here", 3),
    head("4", "build/c1190-else", "unrelated subject", 2),
    head("5", "build/unrelated", "#C1195 (Reviewer): another card", 1),
  ];
  assert.deepEqual(headsFor("some-card", hs, 1190).map((h) => h.sha), ["1", "2", "4"], "subject and branch number, newest first");
  assert.deepEqual(headsFor("some-card", hs).map((h) => h.sha), [], "a card with no number finds nothing by number");
  assert.deepEqual(headsFor("some-card", hs, 119).map((h) => h.sha), [], "119 is not 1190");
});

test("a numbered branch found only by its name, sitting on main, is a pushed branch (build), never shipped", () => {
  const card = { id: "some-card", num: 1190 };
  assert.deepEqual([
    bareBranch(card, head("1", "refactor/c1190-x", "no subject")),
    bareBranch(card, head("2", "refactor/c1190-x", "#C1190 (Reviewer): has its own subject")),
    bareBranch(card, head("3", "refactor/c1191-x", "no subject")),
    bareBranch({ id: "x" }, head("4", "refactor/c1190-x", "no subject")),
  ], [true, false, false, false]);
});
