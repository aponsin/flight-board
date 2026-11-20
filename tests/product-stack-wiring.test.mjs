// #C1303 (a bug in #C1295: on the live config the product's stack switch could never read a product stack): the probe's "" is the clone at collector.repoPath. A config that LISTS
// the board's own repository in collector.repos has the board as the listed repository, so "" is the product's clone and the product's row must switch it. A config that does not
// list the board's repository (the board's own clone is repoPath) reads as #C1295 had it. The board's row is "" in both shapes and does not move.
import test from "node:test";
import assert from "node:assert/strict";
import { stacksOn, productRepoNames } from "../collector/store-cards.mjs";

const sw = (board, product) => [{ repo: "board", stack: board }, { repo: "product", stack: product }];
// The live shape, with no values: the board's own repository listed as the one entry (name, path, main branch, notes, id prefixes, installed link), and the team's own clone at repoPath.
const LIVE_SHAPE = { collector: { repoPath: "<path>", remote: "origin", mainBranch: "main", notes: { checker: "refs/notes/x" }, repos: [{ name: "flight-board", path: "<path>", mainBranch: "main", notes: { checker: "refs/notes/x", security: "refs/notes/y" }, idPrefixes: ["<prefix>"], installedLink: "<path>" }] } };
// The single-repository shape: nothing listed, or only other repositories; the board's own clone is repoPath.
const SINGLE_SHAPE = { collector: { repoPath: "<path>", repos: [] } };
const SINGLE_WITH_OTHER = { collector: { repoPath: "<path>", repos: [{ name: "platform", path: "<path>", notes: { checker: "refs/notes/x" } }] } };

test("the live shape (the board's repository listed): the product row switches the team's own clone, \"\"", () => {
  assert.deepEqual(productRepoNames(LIVE_SHAPE), [""]);
  assert.deepEqual(stacksOn(sw(false, true), productRepoNames(LIVE_SHAPE)), [""], "the product's row alone reads the product's clone");
  assert.deepEqual(stacksOn(sw(false, false), productRepoNames(LIVE_SHAPE)), [], "both off: nothing");
});

test("the live shape: the board's row reads exactly what it read before, and both rows on name \"\" once", () => {
  assert.deepEqual(stacksOn(sw(true, false), productRepoNames(LIVE_SHAPE)), [""], "unchanged from the live stacks.json");
  assert.deepEqual(stacksOn(sw(true, true), productRepoNames(LIVE_SHAPE)), [""], "not twice");
  assert.deepEqual(stacksOn(sw(true, false)), [""], "called as before, with no list");
});

test("the live shape with another repository listed too: \"\" and that one, in that order", () => {
  const cfg = { collector: { repos: [...LIVE_SHAPE.collector.repos, { name: "site" }] } };
  assert.deepEqual(productRepoNames(cfg), ["", "site"]);
  assert.deepEqual(stacksOn(sw(true, true), productRepoNames(cfg)), ["", "site"]);
});

test("the single-repository shape reads as #C1295 had it: nothing listed is nothing to read, another listed repository is the product", () => {
  assert.deepEqual(productRepoNames(SINGLE_SHAPE), []);
  assert.deepEqual(stacksOn(sw(false, true), productRepoNames(SINGLE_SHAPE)), [], "the product row on, no other repository: changes nothing here");
  assert.deepEqual(stacksOn(sw(true, true), productRepoNames(SINGLE_SHAPE)), [""], "the board's own row only");
  assert.deepEqual(productRepoNames(SINGLE_WITH_OTHER), ["platform"]);
  assert.deepEqual(stacksOn(sw(false, true), productRepoNames(SINGLE_WITH_OTHER)), ["platform"]);
  assert.deepEqual(stacksOn(sw(true, true), productRepoNames(SINGLE_WITH_OTHER)), ["", "platform"]);
});

test("the board's words count as the board's own repository however they are written; odd entries are ignored; the list reads from a config with no collector", () => {
  for (const word of ["Flight-Board", " flight-board ", "owner/flight-board", "flight-board.git", "board"]) assert.deepEqual(productRepoNames({ collector: { repos: [{ name: word }] } }), [""], word);
  assert.deepEqual(productRepoNames({ collector: { repos: [{}, null, { name: 7 }, { name: "" }] } }), []);
  assert.deepEqual(productRepoNames(null), []);
  assert.deepEqual(productRepoNames({ collector: {} }), []);
  assert.deepEqual(stacksOn(sw(false, true), ["x".repeat(41), "ok"]), ["ok"], "a name over 40 characters is not used");
});
