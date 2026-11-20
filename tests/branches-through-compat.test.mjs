// #C1388 follow-up: a card's tracked branches reach the reading through the whole path, not a hand-fed reading: the probe's evidence for the card (`cards.<id>`.value.branches) ->
// the store view -> the Worker's compat answer (compatView -> worker/compat-reading.mjs) -> `readings[card].branches`, one entry {name, phase, landed, reached, live} per branch.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compatView } from "../worker/compat-view.mjs";

const VIEW = JSON.parse(readFileSync(new URL("./fixtures/view-recorded.json", import.meta.url), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
const served = (v) => compatView(v).collections.readings;
const readingOf = (v, id) => served(v).find((d) => d.id === id);

// An open card of the recorded view that has evidence of its own.
const CARD = VIEW.cards.find((c) => !c.dropped && !c.done_at && VIEW.evidence[`cards.${c.id}`]?.value && typeof VIEW.evidence[`cards.${c.id}`].value === "object");
const KEY = `cards.${CARD.id}`;

const TWO = [
  { name: "build-alpha", phase: "checker", headSha12: "0123456789ab", onMain: false, seen: ["build", "checker"] },
  { name: "build-beta", phase: "live", headSha12: "ba9876543210", onMain: true, seen: ["build", "checker", "pack", "live"] },
];
// The view with the card's evidence carrying `branches` (the rest of the evidence as recorded), the card's own reading served.
function withBranches(branches, patch = {}) {
  const v = clone(VIEW);
  v.evidence[KEY].value = { ...v.evidence[KEY].value, stale: false, ...patch };
  delete v.evidence[KEY].value.branches;
  if (branches !== undefined) v.evidence[KEY].value.branches = branches;
  return v;
}

test("a card with two tracked branches is served with one entry per branch, in the shape the page reads", () => {
  const r = readingOf(withBranches(TWO), CARD.id);
  assert.ok(r, "the card is served");
  assert.deepEqual(r.branches, [
    { name: "build-alpha", phase: "checker", landed: false, reached: ["build", "checker"], live: false },
    { name: "build-beta", phase: "live", landed: true, reached: ["build", "checker", "pack", "live"], live: true },
  ]);
});

test("a card with one branch, none, or only one good one has no `branches`", () => {
  assert.ok(!("branches" in readingOf(withBranches([TWO[0]]), CARD.id)), "one branch");
  assert.ok(!("branches" in readingOf(withBranches([]), CARD.id)), "an empty list");
  assert.ok(!("branches" in readingOf(withBranches(undefined), CARD.id)), "no list");
  assert.ok(!("branches" in readingOf(withBranches([TWO[0], { ...TWO[1], headSha12: "short" }]), CARD.id)), "the second tip is odd, so one is left");
  assert.ok(!("branches" in readingOf(withBranches([TWO[0], { ...TWO[0] }]), CARD.id)), "a repeated name counts once");
});

test("an odd branch record is skipped and the good ones are still served", () => {
  const three = [TWO[0], { name: "Bad Name", phase: "build", headSha12: "0123456789ab" }, TWO[1]];
  assert.deepEqual(readingOf(withBranches(three), CARD.id).branches.map((b) => b.name), ["build-alpha", "build-beta"]);
});

test("missing evidence, or evidence with no branches in it, gives no branches", () => {
  const gone = clone(VIEW);
  delete gone.evidence[KEY];
  assert.ok(!("branches" in readingOf(gone, CARD.id)), "no evidence for the card");
  const nulled = clone(VIEW);
  nulled.evidence[KEY].value = null;
  assert.ok(!("branches" in readingOf(nulled, CARD.id)), "evidence with no value");
  const bare = withBranches(undefined, { stale: true });
  assert.ok(!("branches" in readingOf(bare, CARD.id)), "stale evidence that holds none");
});

test("a stale reading keeps serving its last good branches, with the stale mark", () => {
  const fresh = readingOf(withBranches(TWO), CARD.id);
  const since = Date.now() - 3600_000;
  const stale = readingOf(withBranches(TWO, { stale: true, staleSince: since }), CARD.id);
  assert.equal(stale.stale, true, "marked stale");
  assert.equal(stale.staleSince, since, "with the time it was last good");
  assert.equal(stale.branches?.length, 2, "both branches still served");
  assert.deepEqual(stale.branches, fresh.branches, "the same entries as when fresh");
});

test("an unknown reading (no evidence, nothing earlier and good) has no branches", () => {
  const gone = clone(VIEW);
  delete gone.evidence[KEY];
  const r = readingOf(gone, CARD.id);
  assert.ok(!("branches" in r));
  const noGood = readingOf(withBranches(undefined, { stale: true }), CARD.id);
  assert.equal(noGood.state, "unknown", "stale with no earlier good reading is unknown");
  assert.ok(!("branches" in noGood));
});

test("only the card whose evidence holds the branches is served with them", () => {
  const r = served(withBranches(TWO));
  assert.deepEqual(r.filter((d) => d.branches).map((d) => d.id), [CARD.id]);
});
