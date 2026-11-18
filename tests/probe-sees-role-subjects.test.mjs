// #C1204: the probe finds a card's head when the signed commit's subject is "#C<num> (<Role>): ..." or the branch's last segment is
// "c<num>-...", with no Board-Id trailer. derive.mjs and the probe's own copy in state.mjs read the same way.
import test from "node:test";
import assert from "node:assert/strict";
import { headsFor as probeHeadsFor, subjectNum as probeSubjectNum, branchNum as probeBranchNum, bareBranch as probeBare } from "../collector/state.mjs";
import { headsFor, subjectNum, branchNum, bareBranch } from "../collector/derive.mjs";

const head = (sha, branch, message, at = 1) => ({ sha, branch, message, at });
const both = (fn) => [fn(headsFor, subjectNum, branchNum, bareBranch), fn(probeHeadsFor, probeSubjectNum, probeBranchNum, probeBare)];

test("a subject '#C<num> (<Role>):' names the card by its number, as '#C<num>:' does", () => {
  for (const [, sub] of [[0, subjectNum], [1, probeSubjectNum]]) {
    assert.equal(sub("#C1190 (Reviewer): the plans move to the store"), 1190);
    assert.equal(sub("#C1190: the plans move to the store"), 1190);
    assert.equal(sub("#C1190 the plans"), null, "no colon and no bracket: not a card subject");
    assert.equal(sub("fix #C1190 (Reviewer): later in the line"), null, "only at the start");
    assert.equal(sub("#C1190(Reviewer): no space"), null);
    assert.equal(sub(null), null);
  }
});

test("a branch whose last segment starts 'c<num>-' names the card by its number", () => {
  for (const br of [branchNum, probeBranchNum]) {
    assert.equal(br("refactor/c1190-plans-store"), 1190);
    assert.equal(br("c1190-x"), 1190);
    assert.equal(br("refactor/c1190"), null, "no dash after the number");
    assert.equal(br("refactor/c1190x-plans"), null);
    assert.equal(br("refactor/ac1190-plans"), null);
    assert.equal(br("refactor/c1190-plans/more"), null, "the last segment is the one read");
    assert.equal(br(undefined), null);
  }
});

test("headsFor finds the head by the role subject or by the numbered branch, and both copies agree", () => {
  const hs = [
    head("1", "refactor/c1190-plans-store", "#C1190 (Reviewer): the plans move to the store", 5),
    head("2", "other/branch", "#C1190 (Reviewer): a second branch with the role subject", 4),
    head("3", "refactor/c1191-other", "no subject here", 3),
    head("4", "build/c1190-else", "unrelated subject", 2),
    head("5", "build/unrelated", "#C1195 (Reviewer): another card", 1),
  ];
  for (const [i, f] of [[0, headsFor], [1, probeHeadsFor]]) {
    assert.deepEqual(f("some-card", hs, 1190).map((h) => h.sha), ["1", "2", "4"], `copy ${i}: subject and branch number, newest first`);
    assert.deepEqual(f("some-card", hs).map((h) => h.sha), [], `copy ${i}: a card with no number finds nothing by number`);
    assert.deepEqual(f("some-card", hs, 119).map((h) => h.sha), [], `copy ${i}: 119 is not 1190`);
  }
  assert.deepEqual(headsFor("x", hs, 1190), probeHeadsFor("x", hs, 1190));
});

test("a numbered branch found only by its name, sitting on main, is a pushed branch (build), never shipped", () => {
  const card = { id: "some-card", num: 1190 };
  const [a, b] = both((_h, _s, _b, bare) => [
    bare(card, head("1", "refactor/c1190-x", "no subject")),
    bare(card, head("2", "refactor/c1190-x", "#C1190 (Reviewer): has its own subject")),
    bare(card, head("3", "refactor/c1191-x", "no subject")),
    bare({ id: "x" }, head("4", "refactor/c1190-x", "no subject")),
  ]);
  assert.deepEqual(a, [true, false, false, false]);
  assert.deepEqual(b, a, "the probe's copy reads the same");
});
