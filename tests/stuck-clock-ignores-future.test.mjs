// #C1399: a commit's date is its author's to set, so a tip time (evidence.headAt, else readyAt) more than TIP_FUTURE_MS after now is no reading of when the card last pushed:
// it counts as no tip time (the phase's age alone decides), so a future-dated commit cannot keep a card from reading stuck.
import test from "node:test";
import assert from "node:assert/strict";
import { reading, TIP_FUTURE_MS } from "../worker/reading.mjs";

const NOW = 1_795_208_000_000, MEDIAN = 600e3;
const card = { id: "future-card", repo: "flight-board", owner_role: "Boardsmith" };
const ctx = { phaseStart: new Map([["future-card|build", NOW - 1300e3]]), medians: { build: MEDIAN } }; // the phase is over twice the median old
const config = { repos: [{ name: "flight-board", kind: "board" }] };
const ev = (more) => ({ phase: "build", lit: ["build"], headSha: "a".repeat(40), headSha12: "a".repeat(12), signed: [], onMain: false, at: NOW, ...more });
const state = (more) => reading(card, ev(more), [], {}, config, NOW, ctx).state;

test("control: a tip pushed a moment ago is not stuck; an old one is", () => {
  assert.equal(state({ headAt: NOW - 60e3 }), "waiting");
  assert.equal(state({ headAt: NOW - 1300e3 }), "stuck");
});

test("a tip dated far in the future is ignored: the card reads stuck on the phase's age, as with no tip time", () => {
  assert.equal(state({ headAt: NOW + 3600e3 }), "stuck");
  assert.equal(state({ headAt: NOW + TIP_FUTURE_MS + 1000 }), "stuck");
  assert.equal(state({}), "stuck", "no tip time: the same answer");
});

test("a tip a little ahead of now (clock skew) still counts as a push just made", () => {
  assert.equal(state({ headAt: NOW + 60e3 }), "waiting");
  assert.equal(state({ headAt: NOW + TIP_FUTURE_MS }), "waiting");
});

test("the same limit holds for readyAt when headAt is absent", () => {
  assert.equal(state({ readyAt: NOW + 3600e3 }), "stuck");
  assert.equal(state({ readyAt: NOW - 60e3 }), "waiting");
});
