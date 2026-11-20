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

// Checker 2's F1: the slow clock starts at the group's READY, the moment its LAST member reached review, not at the card's own review start (a member built at 9:00 with the last one built at 11:00
// is not woken "slow" at 11:00). `starts` is each member's review start, minutes ago.
const slowAt = (starts) => slowWakes({ now: T, cards: [card("c0", 1), card("c1", 2)], evidence: { c0: rd("checker"), c1: rd("checker") }, openAskCards: new Set(), phaseStart: new Map(Object.entries(starts).map(([id, m]) => [`${id}|checker`, T - m * MIN])), medians: { checker: 10 * MIN }, endsPassed: new Set() }).map((s) => s.reason);

test("the slow clock starts at the group's READY: an early member is not slow the moment the last one arrives, and is slow once the usual time passes from then", () => {
  assert.deepEqual(slowAt({ c0: 120, c1: 5 }), [], "c0 reached review 2 h ago, the last member 5 min ago: the READY went out 5 min ago, the limit is 20");
  assert.deepEqual(slowAt({ c0: 5, c1: 120 }), [], "the same with the members the other way round: the later start is c0's");
  assert.deepEqual(slowAt({ c0: 120, c1: 25 }), [slowLine(1), slowLine(2)], "25 min after the READY both are slow");
  assert.deepEqual(slowAt({ c0: 25, c1: 120 }), [slowLine(1), slowLine(2)], "the READY went out 25 min ago (c0 came last)");
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
