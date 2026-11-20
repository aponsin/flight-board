// #C1325 (11-19 night, twice: the dispatch watch said "nothing pushed" for a card whose only branch was <id>-v3 or <id>-v4): the probe matched a card to a branch by the tip's Board-Id trailer,
// by the branch's last part equal to the card id, or by the card number. A re-cut is named <id>-v<N> (the collector follows only -vN), and a tip whose commit has no usable trailer matched none of
// those, so the card read as having nothing pushed. The last part of a branch name now names the card with or without a -v<N> suffix.
import test from "node:test";
import assert from "node:assert/strict";
import { headsFor, slugOfBranch } from "../collector/state.mjs";

const tip = (branch, extra = {}) => ({ branch, sha: "a".repeat(40), message: "work in progress", at: 1000, ...extra });

test("a card whose only branch is <id>-v3 (its tip with no trailer) is found, and so are -v2 and the bare name", () => {
  for (const branch of ["build/card-x-v3", "build/card-x-v2", "build/card-x", "admin/card-x-v12"]) {
    assert.deepEqual(headsFor("card-x", [tip(branch)]).map((h) => h.branch), [branch], branch);
  }
});

test("must still allow: the trailer, the exact id and the number still find a card", () => {
  assert.equal(headsFor("card-x", [tip("build/other", { message: "x\n\nBoard-Id: card-x" })]).length, 1, "by trailer");
  assert.equal(headsFor("card-x", [tip("build/card-x")]).length, 1, "by exact id");
  assert.equal(headsFor("card-x", [tip("build/c1325-thing")], 1325).length, 1, "by number");
});

test("must still refuse: another card's branch, a longer name that only starts with the id, and a -v suffix that is not a version", () => {
  assert.deepEqual(headsFor("card-x", [tip("build/card-y-v3")]), []);
  assert.deepEqual(headsFor("card-x", [tip("build/card-x-extra-v3")]), []);
  assert.deepEqual(headsFor("card-x", [tip("build/card-x-v3a")]), []);
  assert.deepEqual(headsFor("card-x", [tip("build/my-card-x-v3")]), [], "a different slug that ends with the id is another card");
});

test("slugOfBranch strips one trailing -v<N> from the last part only", () => {
  assert.equal(slugOfBranch("build/card-x-v3"), "card-x");
  assert.equal(slugOfBranch("build/card-x"), "card-x");
  assert.equal(slugOfBranch("build-v2/card-x"), "card-x");
});

test("the newest version of a family is the card's first tip", () => {
  const tips = headsFor("card-x", [tip("build/card-x-v2", { at: 1000 }), tip("build/card-x-v3", { at: 3000 }), tip("build/card-x", { at: 500 })]);
  assert.equal(tips[0].branch, "build/card-x-v3");
});
