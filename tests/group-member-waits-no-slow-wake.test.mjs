// #C1358: the page's wait tile has a twin in the slow wake. In stack mode a card at a review lane whose group still has an unstarted card or one at build is waiting for the group's
// one READY, so Manager is not woken "slow" for it; once every member is at review (the READY is out) the plain rule stands, and a card outside any group or the stack is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { slowWakes, slowLine } from "../worker/board-rules.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const card = (id, num, f = {}) => ({ id, num, owner_role: "Boardsmith", paused: 0, dropped: 0, batch: "g1", ...f });
const rd = (phase, extra = {}) => ({ lit: [phase], phase, headSha12: "aaaaaaaaaaaa", signed: [], onMain: false, stack: { tip: "abcdef012345", size: 2 }, ...extra });
// c0 has been at checker for 40 min (the usual is 10, so the limit is 20).
const slow = (cards, evidence) => slowWakes({ now: T, cards, evidence, openAskCards: new Set(), phaseStart: new Map([["c0|checker", T - 40 * MIN]]), medians: { checker: 10 * MIN }, endsPassed: new Set() }).map((s) => s.reason);

test("a card at review while a group member is unstarted, or at build, is waiting for the READY, not slow", () => {
  assert.deepEqual(slow([card("c0", 1), card("c1", 2)], { c0: rd("checker") }), [], "the other member has no reading: unstarted");
  assert.deepEqual(slow([card("c0", 1), card("c1", 2)], { c0: rd("checker"), c1: rd("build") }), [], "the other member is at build");
});

test("must still wake: every member at review (the READY is out), a card outside the group, a card outside the stack, and a done or paused partner", () => {
  assert.deepEqual(slow([card("c0", 1), card("c1", 2)], { c0: rd("checker"), c1: rd("checker") }), [slowLine(1)]);
  assert.deepEqual(slow([card("c0", 1, { batch: null }), card("c1", 2, { batch: null })], { c0: rd("checker") }), [slowLine(1)]);
  assert.deepEqual(slow([card("c0", 1), card("c1", 2)], { c0: rd("checker", { stack: { outside: true } }) }), [slowLine(1)]);
  assert.deepEqual(slow([card("c0", 1), card("c1", 2)], { c0: rd("checker", { stack: undefined }) }), [slowLine(1)], "no stack mode");
  assert.deepEqual(slow([card("c0", 1), card("c1", 2, { paused: 1 })], { c0: rd("checker") }), [slowLine(1)]);
  assert.deepEqual(slow([card("c0", 1), card("c1", 2, { done_at: T - MIN })], { c0: rd("checker") }), [slowLine(1)]);
  assert.deepEqual(slow([card("c0", 1), card("c1", 2, { batch: "g2" })], { c0: rd("checker") }), [slowLine(1)], "another group's card");
});
