// #C1379: a closed card of a product repository that never read live (it closed at "ship" under #C1104 part 2) is read again until a run reads it live, so its stored
// reading carries its live state and version. A board card, a dropped card, one already read live, one closed long ago and one with no repository word are not read.
import test from "node:test";
import assert from "node:assert/strict";
import { cardStates, rereadClosed, REREAD_DONE_MS } from "../collector/state.mjs";

const NOW = 1_800_000_000_000;
const cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
const done = (id, repo, extra = {}) => ({ id, num: 1, status: "done", repo, doneAt: NOW - 86_400_000, ...extra });

test("the rule: a done, named, non-board card inside its window that has not read live", () => {
  assert.equal(rereadClosed(done("a", "widgets"), new Set(), NOW), true);
  assert.equal(rereadClosed(done("a", "acme/widgets.git"), new Set(), NOW), true);
  assert.equal(rereadClosed(done("a", "widgets"), new Set(["a"]), NOW), false, "it read live: done");
  assert.equal(rereadClosed(done("a", "widgets"), ["a"], NOW), false, "a list works as a set");
  assert.equal(rereadClosed(done("a", "flight-board"), new Set(), NOW), false, "a board card's install and live stay as they were");
  assert.equal(rereadClosed(done("a", "board"), new Set(), NOW), false);
  assert.equal(rereadClosed(done("a", undefined), new Set(), NOW), false, "no repository word: not a named product card");
  assert.equal(rereadClosed(done("a", "  "), new Set(), NOW), false);
  assert.equal(rereadClosed({ ...done("a", "widgets"), status: "dropped" }, new Set(), NOW), false);
  assert.equal(rereadClosed({ ...done("a", "widgets"), status: "active" }, new Set(), NOW), false, "an open card is read as always");
  // The bound (Manager): stop after it reads live, or 14 days after done_at, whichever comes first. Both ends.
  assert.equal(REREAD_DONE_MS, 14 * 86_400_000);
  assert.equal(rereadClosed(done("a", "widgets", { doneAt: NOW - REREAD_DONE_MS }), new Set(), NOW), true, "on the last day it is still read");
  assert.equal(rereadClosed(done("a", "widgets", { doneAt: NOW - REREAD_DONE_MS - 1 }), new Set(), NOW), false, "closed past the window: never read forever");
  assert.equal(rereadClosed(done("a", "widgets", { doneAt: NOW - 1000 }), new Set(["a"]), NOW), false, "read live inside the window: stops at once");
  assert.equal(rereadClosed(done("a", "widgets", { doneAt: undefined }), new Set(), NOW), false);
});

test("cardStates reads the open cards and the closed product cards that have not read live, and no others", () => {
  const cards = [
    { id: "open", num: 1, status: "active", repo: "widgets" },
    done("early", "widgets"), done("lived", "widgets"), done("boardc", "flight-board"), done("bare", undefined),
    { ...done("gone", "widgets"), status: "dropped" }, done("old", "widgets", { doneAt: NOW - REREAD_DONE_MS - 1000 }),
  ];
  const out = cardStates({ cards, config: cfg, repos: {}, now: NOW, closedLive: new Set(["lived"]) });
  assert.deepEqual(Object.keys(out).sort(), ["early", "open"]);
  assert.deepEqual(Object.keys(cardStates({ cards, config: cfg, repos: {}, now: NOW })).sort(), ["early", "lived", "open"], "with no memory every closed product card in its window is read once");
});
