// #C991 (the owner's pick A): every reviewer DISPATCH line carries "your queue: #C.., #C..", the cards whose review turn is that role's, in the
// store's queue order (queue_pos, then the card's number); held cards, cards with an open ask and cards waiting on someone else are out.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchInput, dispatchRun } from "../collector/store-dispatch.mjs";
import { dispatchLine, DISPATCH_QUEUE_MAX } from "../gate/reset.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Checker", "Security", "Release"], LEAD = "Manager";
const idle = () => ({ state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN });
const sha = (n) => String(n).padStart(12, "a").slice(0, 12);
// Cards pushed at the checker phase, each with its own commit; `extra` overrides per card number.
const world = (nums, extra = {}, asks = []) => {
  const cards = [], evidence = { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle()])) } };
  for (const n of nums) {
    const id = `c${n}-thing`;
    cards.push({ id, num: n, owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", ...(extra[n] ?? {}) });
    evidence[`cards.${id}`] = { readAt: NOW - 5_000, value: { lit: ["checker"], phase: "checker", headSha12: sha(n), signed: [] } };
  }
  return { cards, asks, evidence };
};
const run = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "rq-")), roster: ROSTER, lead: LEAD, now: NOW }).items;

test("a review line names the role's whole queue, in queue_pos order then number", () => {
  const v = world([905, 903, 904], { 904: { queue_pos: 1 } });
  assert.deepEqual(dispatchInput(v, NOW, { lead: LEAD }).queues, { Checker: [904, 903, 905] });
  const items = run(v);
  assert.equal(items.length, 3);
  for (const i of items) {
    assert.deepEqual(i.queue, [904, 903, 905]);
    assert.match(dispatchLine(i), /; review it \(your verdict is the git note on that commit\); your queue: #C904, #C903, #C905 \(Checker's turn;/);
  }
});

test("held, asked and waiting-on-someone-else cards are out of the queue", () => {
  const v = world([901, 902, 903, 904], { 902: { hold_end: "ask-1" }, 903: { waiting_on: "the owner" }, 904: { paused: 1 } }, [{ id: "a", card_id: "c901-thing", closed_at: null, answered_at: null }]);
  assert.deepEqual(dispatchInput(v, NOW, { lead: LEAD }).queues, {});
  const w = world([901, 902], { 902: { waiting_on: "Checker: PASS at ..." } });
  assert.deepEqual(dispatchInput(w, NOW, { lead: LEAD }).queues, { Checker: [901, 902] }, "waiting on the reviewer itself stays in");
});

test("each reviewer gets its own queue: Security's lists only Full cards", () => {
  const v = world([910, 911], { 911: { review_level: "Full" } });
  assert.deepEqual(dispatchInput(v, NOW, { lead: LEAD }).queues, { Checker: [910, 911], Security: [911] });
  const sec = run(v).find((i) => i.role === "Security");
  assert.match(dispatchLine(sec), /your queue: #C911 \(Security's turn;/);
});

test("only review lines carry a queue; a forged or long queue is cut to plain card numbers", () => {
  const build = { card: "c1-x", role: "Boardsmith", phase: "build", step: "build", queue: [1, 2], level: 1, since: NOW };
  assert.doesNotMatch(dispatchLine(build), /your queue/);
  const forged = { card: "c1-x", role: "Checker", phase: "checker", step: "review", sha: "8b3855f0f672", queue: [1, "2; rm -rf", 3.5, -4, 1e7, 5], level: 1, since: NOW };
  assert.match(dispatchLine(forged), /your queue: #C1, #C5 \(/);
  const long = { ...forged, queue: Array.from({ length: 40 }, (_, k) => k + 1) };
  assert.equal(dispatchLine(long).match(/#C\d+/g).length, DISPATCH_QUEUE_MAX);
  assert.doesNotMatch(dispatchLine({ ...forged, queue: [] }), /your queue/);
});
