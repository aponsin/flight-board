// #C1288 (the owner, during Release's product ship: a product card's Ship tile said "Queued for board release" and he thought it waited on him). The release wait names
// the ship it is and who acts: a product card waits for Release's product ship (Release acts); only the board's own card waits for a board release; only the install is the owner's.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const NAMES = ["waitWord", "waitEvidence", "knownWaitText", "cardRepo", "BOARD_REPO", "PLATFORM_REPO", "state", "derivedOf"];
const load = () => loadNames(NAMES, {});
const card = (id, repo) => ({ id, repo });

test("a product card's release wait says Release's product ship, never a board release; the hover says Release acts and nothing waits on the owner", () => {
  const b = load();
  const product = card("p1", b.PLATFORM_REPO);
  assert.equal(b.waitWord(product, "release"), "Queued for Release's product ship");
  assert.match(b.waitEvidence(product, "release"), /Release acts, nothing is waiting on you/);
  assert.doesNotMatch(b.waitWord(product, "release"), /board release|your/i);
});

test("the board's own card still says board release, and the install is untouched (it is the owner's)", () => {
  const b = load();
  const own = card("b1", b.BOARD_REPO);
  assert.equal(b.waitWord(own, "release"), "Queued for board release");
  assert.equal(b.waitEvidence(own, "release"), "evidence: signed, queued for a board release");
  assert.equal(b.waitWord(own, "install"), "Waiting for install");
  assert.equal(b.waitWord(card("p1", b.PLATFORM_REPO), "install"), "Waiting for install", "only a release wait is reworded");
});

test("the status line (knownWaitText) uses the same word", () => {
  const b = load();
  b.state.derived = [{ id: "all", cards: { p1: { phase: "ship", wait: "release", evidence: "e" }, b1: { phase: "ship", wait: "release", evidence: "e" } } }];
  b.state.initRaw = [];
  assert.equal(b.knownWaitText(card("p1", b.PLATFORM_REPO)), "Queued for Release's product ship");
  assert.equal(b.knownWaitText(card("b1", b.BOARD_REPO)), "Queued for board release");
});
