// #C1063 (11-12, #C1053): a card in rework had its stall line flip every few minutes between "rework reason missing (Boardsmith attaches it)" and "slow with no reason";
// Manager's rework_reason and next_note silenced neither. A reason attached in the last hour is the reason, and a missing one is not nagged while the owner is working the card.
import test from "node:test";
import assert from "node:assert/strict";
import { slowWakes, slowLine, reworkReasonLine, SHIP_SLOW_MS, NOTE_FRESH_MS } from "../worker/board-rules.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const base = { id: "c", num: 1053, owner_role: "Boardsmith", paused: 0, dropped: 0 };
const rework = { lit: ["ship"], phase: "ship", headSha12: "aaaaaaaaaaaa", signed: [], onMain: false, rework: true };
const plain = { ...rework, rework: undefined };
const slow = (fields, agents, ev = rework) => slowWakes({ now: T, cards: [{ ...base, ...fields }], evidence: { c: ev }, openAskCards: new Set(), phaseStart: new Map([["c|ship", T - SHIP_SLOW_MS - MIN]]), medians: {}, endsPassed: new Set(), agents }).map((s) => s.reason);

test("a rework card with no reason names what is missing, as before", () => {
  assert.deepEqual(slow({}), [reworkReasonLine(1053, "Boardsmith")]);
  assert.deepEqual(slow({ rework_reason: "" }), [reworkReasonLine(1053, "Boardsmith")]);
});

test("a rework_reason attached in the last hour is the reason: no line at all (neither line flips); an hour old, the slow line comes back", () => {
  assert.deepEqual(slow({ rework_reason: "review findings", updated_at: T - 2 * MIN }), []);
  assert.deepEqual(slow({ rework_reason: "review findings", updated_at: T - NOTE_FRESH_MS + 1 }), []);
  assert.deepEqual(slow({ rework_reason: "review findings", updated_at: T - NOTE_FRESH_MS }), [slowLine(1053)]);
  assert.deepEqual(slow({ rework_reason: "review findings", updated_at: T + 5 * MIN }), [slowLine(1053)], "a time in the future is not believed");
  assert.deepEqual(slow({ rework_reason: "review findings" }), [slowLine(1053)], "no time, no claim of freshness");
});

test("a card not in rework is not silenced by a recent update, whatever its rework_reason says", () => {
  assert.deepEqual(slow({ rework_reason: "review findings", updated_at: T - MIN }, undefined, plain), [slowLine(1053)]);
});

test("a missing reason is not nagged while its owner is working this very card; another card, idle or no reading, still names it", () => {
  assert.deepEqual(slow({}, { Boardsmith: { state: "working", card: "c" } }), []);
  assert.deepEqual(slow({}, { Boardsmith: { state: "idle", card: "c" } }), [reworkReasonLine(1053, "Boardsmith")]);
  assert.deepEqual(slow({}, { Builder: { state: "working", card: "c" } }), [reworkReasonLine(1053, "Boardsmith")], "another role on it is not the owner");
  assert.deepEqual(slow({}, {}), [reworkReasonLine(1053, "Boardsmith")]);
  assert.deepEqual(slow({}, { Boardsmith: { state: "working", card: "other" } }), [], "queued behind the owner's other card (#C1093)");
});

test("a reason that was never given and a plain slow card keep their own lines apart: the same card cannot read both in one reading", () => {
  const a = slow({ updated_at: T - 2 * MIN }), b = slow({ rework_reason: "review findings", updated_at: T - 2 * MIN });
  assert.deepEqual([a, b], [[reworkReasonLine(1053, "Boardsmith")], []]);
});
