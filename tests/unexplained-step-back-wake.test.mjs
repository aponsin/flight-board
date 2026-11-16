// #C1114 part 2: a step back from a review phase with no FINDINGS note and no reason is held by the Worker as rework "unexplained"; the dispatch wakes the
// reviewer of that phase (not the owner) to file the finding on that commit, and the wake says what to do. Fictional names, as stall-says-rework-reason.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { turnsOf } from "../collector/store-dispatch.mjs";
import { dispatchLine, DISPATCH_STEPS } from "../gate/reset.mjs";

const T = 1_800_000_000_000;
const A = "aaaaaaaaaaaa";
const card = { id: "c", num: 962, owner_role: "Builder", paused: 0, dropped: 0 };
const rd = (phase, extra = {}) => ({ lit: [phase], phase, headSha12: A, signed: [], onMain: false, ...extra });

test("an unexplained step back at a review phase wakes that phase's reviewer, not the owner", () => {
  const checker = turnsOf(card, rd("checker", { rework: "unexplained" }));
  assert.deepEqual(checker.map((t) => [t.role, t.phase, t.step, t.sha]), [["Checker", "checker", "unexplained", A]]);
  const named = turnsOf(card, rd("checker", { rework: "unexplained" }), { reviewer: "Checker 2" });
  assert.equal(named[0].role, "Checker 2", "the checker phase's reviewer is the one the config names");
  assert.equal(named[0].step, "unexplained");
});

test("it is only for a review phase: build, plan and ship read as before, and rework true is still the owner's reason turn", () => {
  assert.equal(turnsOf(card, rd("build", { rework: "unexplained" }))[0].step, "build");
  assert.notEqual(turnsOf(card, rd("ship", { rework: "unexplained", onMain: false }))[0]?.step, "unexplained");
  assert.deepEqual(turnsOf(card, rd("checker", { rework: true })), [{ role: "Builder", phase: "checker", step: "reason" }]);
  assert.equal(turnsOf(card, rd("checker", { rework: "unexplained", findings: ["checker"] }))[0].step, "unexplained", "an unexplained hold is shown first; the findings turn follows once the note is on the commit and the hold is gone");
});

test("the wake line says what the reviewer does", () => {
  assert.match(DISPATCH_STEPS.unexplained, /FINDINGS note on that commit/);
  assert.match(dispatchLine({ card: "c", num: 962, role: "Checker", phase: "checker", step: "unexplained", level: 1, since: T }), /^DISPATCH #C962 at checker: .*stepped back from review with no FINDINGS note/);
});
