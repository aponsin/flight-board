// #C1385 (one-reading-module step 2, the gates): the dispatch (collector/store-dispatch.mjs), the stall lines (worker/board-rules.mjs) and the reading read the lane table, the rework rule and
// rule A of a group ("a groupmate is not built yet") from one place each, and a test holds that they do. Rules B to E of a group (no head, same repository and not held, not signed, still to land)
// answer other questions and stay where they are (#C1385's scope; the unification is its own card).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { groupWaits as ruleA, REVIEW_PHASES } from "../worker/group-rule.mjs";
import { groupWaits as rulesA, isRework as rulesRework, reworkKind as rulesKind, PHASE_LANES as RULES_LANES, reviewerOf, slowWakes } from "../worker/board-rules.mjs";
import { groupWaits, isRework, reworkKind, isReviewLane, REVIEW_LANES, PHASE_LANES, waitOf } from "../worker/reading.mjs";
import { turnsOf, PHASE_LANES as DISPATCH_LANES, reviewerFor } from "../collector/store-dispatch.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const T = 1_800_000_000_000, MIN = 60e3;

test("rule A is one function: the reading, the stall rules and the module are the same one", () => {
  assert.equal(rulesA, ruleA);
  assert.equal(groupWaits, ruleA);
  assert.deepEqual([...REVIEW_PHASES], ["language", "design", "checker", "security"]);
  assert.doesNotMatch(read("../worker/group-rule.mjs"), /^import /m, "it imports nothing, so a pinned script can take it without board-rules");
  assert.doesNotMatch(read("../worker/board-rules.mjs"), /k\.batch === c\.batch/, "board-rules holds no second copy of the rule");
});

// One table: every row is a card c at evidence v with the group's other members and their evidence; `waits` is rule A's answer, and the reading's wait and the slow wake must follow it.
const stack = { tip: "abcdef012345", size: 2 };
const rd = (phase, extra = {}) => ({ lit: [phase], phase, headSha12: "aaaaaaaaaaaa", signed: [], onMain: false, stack, ...extra });
const mem = (id, f = {}) => ({ id, num: 2, owner_role: "Builder", paused: 0, dropped: 0, batch: "g1", ...f });
const me = { id: "c0", num: 1, owner_role: "Builder", paused: 0, dropped: 0, batch: "g1" };
const ROWS = [
  ["a member with no reading yet (unstarted) holds the card at review", me, rd("checker"), [mem("c1")], {}, true],
  ["a member still at build holds it", me, rd("checker"), [mem("c1")], { c1: rd("build") }, true],
  ["every member at review: the READY is out", me, rd("checker"), [mem("c1")], { c1: rd("checker") }, false],
  ["a member at ship is built", me, rd("language"), [mem("c1")], { c1: rd("ship") }, false],
  ["a paused member does not hold it", me, rd("checker"), [mem("c1", { paused: 1 })], {}, false],
  ["a dropped member does not hold it", me, rd("checker"), [mem("c1", { dropped: 1 })], {}, false],
  ["a done member does not hold it", me, rd("checker"), [mem("c1", { done_at: T - MIN })], {}, false],
  ["another group's card does not hold it", me, rd("checker"), [mem("c1", { batch: "g2" })], {}, false],
  ["a card in no group is never held", { ...me, batch: null }, rd("checker"), [mem("c1", { batch: null })], {}, false],
  ["a card at build is not at review: no wait", me, rd("build"), [mem("c1")], {}, false],
  ["a card already on main is not held", me, rd("checker", { onMain: true }), [mem("c1")], {}, false],
  ["a card outside the stack is not held", me, rd("checker", { stack: { outside: true } }), [mem("c1")], {}, false],
  ["a card with no stack (stack mode off) is not held", me, rd("checker", { stack: undefined }), [mem("c1")], {}, false],
];
test("rule A, one table: the module's answer, the reading's wait and the slow wake agree on every row", () => {
  for (const [label, c, v, others, ev, waits] of ROWS) {
    const cards = [c, ...others], evidence = { [c.id]: v, ...ev };
    assert.equal(ruleA(c, v, cards, evidence), waits, label);
    const w = waitOf({ card: c, e: v, phase: v.phase, kind: "board", now: T, claims: [], agents: {}, config: {}, ctx: { cards, evidence } });
    assert.equal(w?.kind === "group", waits, `${label}: the reading's wait`);
    const slow = slowWakes({ now: T, cards, evidence, openAskCards: new Set(), phaseStart: new Map([[`${c.id}|${v.phase}`, T - 40 * MIN]]), medians: { [v.phase]: 10 * MIN }, endsPassed: new Set() });
    if (waits) assert.equal(slow.length, 0, `${label}: waiting for the group is not slow`);
    else if (REVIEW_PHASES.includes(v.phase) && v.onMain !== true) assert.equal(slow.length, 1, `${label}: not waiting for the group, 40 min at review against a 10 min usual is slow`);
  }
});

test("the lane table is one: the dispatch's lanes are the reading's review lanes, a subset of board-rules' table, and live, pack and install are no review lane", () => {
  assert.equal(DISPATCH_LANES, REVIEW_LANES);
  assert.equal(PHASE_LANES, RULES_LANES);
  for (const [phase, role] of Object.entries(REVIEW_LANES)) assert.equal(RULES_LANES[phase], role, phase);
  assert.deepEqual(Object.keys(REVIEW_LANES), ["language", "design", "checker", "security", "ship"]);
  for (const p of ["plan", "build", "test", "live", "pack", "install", undefined, null, 7, "constructor"]) assert.equal(isReviewLane(p), false, String(p));
  for (const p of Object.keys(REVIEW_LANES)) assert.equal(isReviewLane(p), true, p);
  const src = read("../collector/store-dispatch.mjs");
  assert.doesNotMatch(src, /ship: "Release" \}/, "no second lane table in the dispatch");
  assert.doesNotMatch(src, /Object\.hasOwn\(PHASE_LANES/, "the review-lane test is isReviewLane");
});

test("rework is one rule: isRework is reworkKind !== null, and the dispatch's step is the kind", () => {
  assert.equal(isRework, rulesRework);
  assert.equal(reworkKind, rulesKind);
  const reasons = [undefined, "", "review findings"], flags = [undefined, true, "unexplained"], phases = [undefined, "build", "checker", "security", "ship"], findings = [undefined, [], ["checker"], ["security"], ["ship"], ["checker", "x"]];
  let n = 0, steps = 0;
  for (const rework_reason of reasons) for (const rework of flags) for (const phase of phases) for (const f of findings) {
    const card = { id: "c1", owner_role: "Builder", repo: "", ...(rework_reason === undefined ? {} : { rework_reason }) };
    const e = { phase, lit: phase ? [phase] : [], headSha12: "aaaaaaaaaaaa", signed: [], onMain: false, ...(rework === undefined ? {} : { rework }), ...(f === undefined ? {} : { findings: f }) };
    const kind = reworkKind(card, e);
    assert.equal(isRework(card, e), kind !== null);
    n++;
    const turns = turnsOf(card, e, {});
    const reason = turns.some((t) => t.step === "reason"), rework2 = turns.some((t) => t.step === "rework");
    // with no stack and no unexplained mark, the dispatch's step is exactly the shared kind
    if (rework !== "unexplained") { assert.equal(reason, kind === "reason", JSON.stringify([rework_reason, rework, phase, f])); assert.equal(rework2, kind === "findings", JSON.stringify([rework_reason, rework, phase, f])); steps++; }
  }
  assert.ok(n > 200 && steps > 100);
});

test("the dispatch's reviewer is the reading module's reviewerOf with the roster on top", () => {
  const roster = ["Checker", "Checker 2", "Designer"];
  const reviewers = { "flight-board": "Checker 2", shop: "Designer", other: "Not On Roster", odd: "x".repeat(30) };
  for (const card of [{ repo: "" }, { repo: "flight-board" }, { repo: "shop" }, { repo: "other" }, { repo: "odd" }, { repo: "none" }]) {
    const of = reviewerOf(card, reviewers);
    assert.equal(reviewerFor(card, reviewers, roster), of !== undefined && roster.includes(of) ? of : undefined, JSON.stringify(card));
  }
  assert.equal(reviewerFor({ repo: "" }, null, roster), undefined);
  assert.equal(reviewerFor({ repo: "" }, ["Checker"], roster), undefined);
  assert.match(read("../collector/store-dispatch.mjs"), /reviewerOf\(card, reviewers\)/, "no second reading of the config's reviewers");
});
