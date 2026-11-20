// #C1303 (a bug in #C1295: on the live config the product's stack switch could never read a product stack): the probe's "" is the clone at collector.repoPath. A config that LISTS
// the board's own repository in collector.repos has the board as the listed repository, so "" is the product's clone and the product's row must switch it. A config that does not
// list the board's repository (the board's own clone is repoPath) reads as #C1295 had it.
// Checker 2's F1: in that live shape the board's row names the listed board repository (repos keys it by its listed name), never ""; in the single shape it is "".
import test from "node:test";
import assert from "node:assert/strict";
import { stacksOn, productRepoNames, boardRepoNames } from "../collector/store-cards.mjs";

const sw = (board, product) => [{ repo: "board", stack: board }, { repo: "product", stack: product }];
const stacks = (cfg, board, product) => stacksOn(sw(board, product), productRepoNames(cfg), boardRepoNames(cfg));
// The live shape, with no values: the board's own repository listed as the one entry (name, path, main branch, notes, id prefixes, installed link), and the team's own clone at repoPath.
const LIVE_SHAPE = { collector: { repoPath: "<path>", remote: "origin", mainBranch: "main", notes: { checker: "refs/notes/x" }, repos: [{ name: "flight-board", path: "<path>", mainBranch: "main", notes: { checker: "refs/notes/x", security: "refs/notes/y" }, idPrefixes: ["<prefix>"], installedLink: "<path>" }] } };
// The single-repository shape: nothing listed, or only other repositories; the board's own clone is repoPath.
const SINGLE_SHAPE = { collector: { repoPath: "<path>", repos: [] } };
const SINGLE_WITH_OTHER = { collector: { repoPath: "<path>", repos: [{ name: "platform", path: "<path>", notes: { checker: "refs/notes/x" } }] } };

test("the live shape (the board's repository listed): the product row switches the team's own clone, \"\"", () => {
  assert.deepEqual(productRepoNames(LIVE_SHAPE), [""]);
  assert.deepEqual(stacks(LIVE_SHAPE, false, true), [""], "the product's row alone reads the product's clone");
  assert.deepEqual(stacks(LIVE_SHAPE, false, false), [], "both off: nothing");
});

test("the live shape: the board's row switches the listed board repository, never the product's clone, and both rows switch both", () => {
  assert.deepEqual(boardRepoNames(LIVE_SHAPE), ["flight-board"]);
  assert.deepEqual(stacks(LIVE_SHAPE, true, false), ["flight-board"], "board only: the board's repository, not \"\"");
  assert.deepEqual(stacks(LIVE_SHAPE, true, true), ["flight-board", ""], "both rows");
  assert.deepEqual(stacksOn(sw(true, false)), [""], "called as before, with no lists");
});

test("the live shape with another repository listed too: the board's name, then \"\" and that one", () => {
  const cfg = { collector: { repos: [...LIVE_SHAPE.collector.repos, { name: "site" }] } };
  assert.deepEqual(productRepoNames(cfg), ["", "site"]);
  assert.deepEqual(stacks(cfg, true, true), ["flight-board", "", "site"]);
});

test("the single-repository shape reads as #C1295 had it: nothing listed is nothing to read, another listed repository is the product", () => {
  assert.deepEqual(productRepoNames(SINGLE_SHAPE), []);
  assert.deepEqual(stacks(SINGLE_SHAPE, false, true), [], "the product row on, no other repository: changes nothing here");
  assert.deepEqual(boardRepoNames(SINGLE_SHAPE), [""]);
  assert.deepEqual(stacks(SINGLE_SHAPE, true, true), [""], "the board's own row only");
  assert.deepEqual(productRepoNames(SINGLE_WITH_OTHER), ["platform"]);
  assert.deepEqual(stacks(SINGLE_WITH_OTHER, false, true), ["platform"]);
  assert.deepEqual(stacks(SINGLE_WITH_OTHER, true, true), ["", "platform"]);
});

test("the board's words count as the board's own repository however they are written; odd entries are ignored; the list reads from a config with no collector", () => {
  for (const word of ["Flight-Board", " flight-board ", "owner/flight-board", "flight-board.git", "board"]) {
    const c = { collector: { repos: [{ name: word }] } };
    assert.deepEqual(productRepoNames(c), [""], word);
    assert.deepEqual(boardRepoNames(c), [word], word);
  }
  assert.deepEqual(productRepoNames({ collector: { repos: [{}, null, { name: 7 }, { name: "" }] } }), []);
  assert.deepEqual(productRepoNames(null), []);
  assert.deepEqual(boardRepoNames(null), [""]);
  assert.deepEqual(productRepoNames({ collector: {} }), []);
  assert.deepEqual(stacksOn(sw(false, true), ["x".repeat(41), "ok"]), ["ok"], "a name over 40 characters is not used");
});
