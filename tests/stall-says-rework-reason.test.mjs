// #C981: on 11-11 ~9:10 pm MT #C962 and #C964 stalled as "slow with no reason" while the store refused every write for a missing
// rework_reason nobody had been asked for; #C964 was no rework at all (its first push came after a local re-cut). (1) A first push is never
// rework; (2) a slow card in rework without a reason says "rework reason missing", and the dispatch gives its owner the turn to attach one.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { reworkTriggered, slowWakes, slowLine, reworkReasonLine, SHIP_SLOW_MS } from "../worker/board-rules.mjs";
import { createCard, updateCard, writeEvidence, wakeAsk, takeInbox } from "../worker/board-store.mjs";
import { turnsOf } from "../collector/store-dispatch.mjs";
import { dispatchLine, DISPATCH_STEPS } from "../gate/reset.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const A = "aaaaaaaaaaaa", B = "bbbbbbbbbbbb";
const rd = (phase, extra = {}) => ({ lit: [phase], phase, headSha12: A, signed: [], onMain: false, ...extra });

test("(1) a first push is never rework: no head before, whatever phase the earlier reading said", () => {
  for (const before of [null, undefined, ""]) {
    for (const p of ["checker", "security", "ship"]) assert.equal(reworkTriggered(rd(p, { headSha12: before }), rd("build", { headSha12: B })), false, `${p} with no head -> build`);
    assert.equal(reworkTriggered(rd("checker", { headSha12: before }), rd("checker", { headSha12: B, findings: ["checker"] })), false, "even with findings on the first commit");
  }
});

test("(1) still allowed: a real push after a review's FINDINGS is rework, and so is a pushed card going back to build", () => {
  assert.equal(reworkTriggered(rd("checker", { findings: ["checker"] }), rd("checker", { headSha12: B })), true, "a push after FINDINGS");
  assert.equal(reworkTriggered(rd("checker"), rd("build", { headSha12: B })), true, "a pushed card back to build");
  assert.equal(reworkTriggered(rd("build"), rd("build", { headSha12: B })), false, "a card that never left build");
});

const card = { id: "c", num: 962, owner_role: "Boardsmith", paused: 0, dropped: 0 };
const slow = (ev, c = card) => slowWakes({ now: T, cards: [c], evidence: { c: ev }, openAskCards: new Set(), phaseStart: new Map([["c|ship", T - SHIP_SLOW_MS - MIN]]), medians: {}, endsPassed: new Set() }).map((s) => s.reason);

test("(2) a slow card in rework with no reason says so and names who attaches it; with a reason, or not in rework, the plain slow line", () => {
  assert.deepEqual(slow(rd("ship", { rework: true })), [reworkReasonLine(962, "Boardsmith")]);
  assert.equal(reworkReasonLine(962, "Boardsmith"), "#C962 is slow, rework reason missing (Boardsmith attaches it): add one or unstick it");
  assert.deepEqual(slow(rd("ship", { rework: true }), { ...card, rework_reason: "review findings" }), [slowLine(962)], "a reason given: no rework line");
  assert.deepEqual(slow(rd("ship")), [slowLine(962)], "no rework: as before");
  assert.deepEqual(slow(rd("ship", { rework: true }), { ...card, owner_role: "<b>" }), [reworkReasonLine(962, "the owner")], "an owner that is not a plain name is not echoed");
});

test("(2) the dispatch: a card in rework with no reason is its owner's turn, with a line that says what to attach; with a reason, the usual turn", () => {
  assert.deepEqual(turnsOf({ ...card, owner_role: "Builder" }, rd("checker", { rework: true })), [{ role: "Builder", phase: "checker", step: "reason" }]);
  assert.deepEqual(turnsOf({ ...card, owner_role: "Builder" }, { rework: true }), [{ role: "Builder", phase: "build", step: "reason" }], "no phase read: build");
  const usual = turnsOf({ ...card, owner_role: "Builder", rework_reason: "review findings" }, rd("checker", { rework: true }));
  assert.equal(usual[0].role, "Checker", "a reason given: the review goes on");
  assert.match(DISPATCH_STEPS.reason, /rework_reason/);
  assert.match(dispatchLine({ card: "c", num: 962, role: "Builder", phase: "checker", step: "reason", level: 1, since: T }), /^DISPATCH #C962 at checker: it is in rework with no reason, so the store refuses its other writes; attach a rework_reason/);
});

test("(2) end to end: the stall reaches Manager with the rework words, and attaching the reason ends it", async () => {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "c", title: "A card", owner_role: "Boardsmith" });
  await writeEvidence(db, T, "probe", "cards.c", rd("checker", { findings: ["checker"] }));
  await writeEvidence(db, T + 1, "probe", "cards.c", rd("ship", { headSha12: B })); // a push after FINDINGS: rework, no reason yet
  await wakeAsk(db, T + SHIP_SLOW_MS + 2 * MIN);
  const num = (await db.prepare("SELECT num FROM cards WHERE id = 'c'").first()).num;
  assert.deepEqual((await takeInbox(db, T + SHIP_SLOW_MS + 3 * MIN)).stalls.map((s) => s.reason), [reworkReasonLine(num, "Boardsmith")]);
  assert.equal((await updateCard(db, T + SHIP_SLOW_MS + 4 * MIN, "Boardsmith", { id: "c", rework_reason: "review findings" })).ok, true);
  await wakeAsk(db, T + SHIP_SLOW_MS + 5 * MIN);
  const rows = (await db.prepare("SELECT reason FROM stall_wakes WHERE card_id = 'c'").all()).results.map((r) => r.reason);
  assert.ok(!rows.includes(reworkReasonLine(num, "Boardsmith")), "the rework row is cleared once a reason is attached");
});
