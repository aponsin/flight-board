import test from "node:test";
import assert from "node:assert/strict";
import { askRefusal, cardWriteRefusal, evidenceRefusal, liveNow, STALE_AFTER_MS } from "../worker/board-rules.mjs";

const NOW = 1_800_000_000_000;
const decision = { type: "Decision", title: "Pick", asked_by: "Manager", question: "A or B?", options: ["A", "B"], recommended: "A" };

test("a well-formed Decision passes; a missing part is refused", () => {
  assert.equal(askRefusal(decision, NOW), null);
  const { recommended, ...bad } = decision;
  assert.equal(askRefusal(bad, NOW).rule, "ask-missing-part");
  assert.equal(askRefusal({ ...decision, options: ["A"] }, NOW).rule, "ask-missing-part");
  assert.equal(askRefusal({ ...decision, recommended: "C" }, NOW).rule, "ask-missing-part");
});

test("an unknown field is refused on asks and cards", () => {
  assert.equal(askRefusal({ ...decision, colour: "red" }, NOW).rule, "unknown-field");
  assert.equal(cardWriteRefusal({ id: "x", colour: "red" }).rule, "unknown-field");
});

test("a Later without an ETA is refused; with a future date it passes", () => {
  const later = { type: "Later", title: "t", asked_by: "Manager", text: "do it" };
  assert.equal(askRefusal(later, NOW).rule, "later-without-eta");
  assert.equal(askRefusal({ ...later, eta_at: NOW + 3600_000 }, NOW), null);
  assert.equal(askRefusal({ ...later, eta_at: NOW - 3600_000 }, NOW).rule, "later-without-eta");
});

test("a session cannot type status or phase; the probe can write evidence", () => {
  assert.equal(cardWriteRefusal({ id: "x", status: "done" }).rule, "only-probe-writes-status");
  assert.equal(cardWriteRefusal({ id: "x", phase: "live" }).rule, "only-probe-writes-status");
  assert.equal(evidenceRefusal("cards.x", { lit: ["build"] }, "Manager").rule, "only-probe-writes-status");
  assert.equal(evidenceRefusal("cards.x", { lit: ["build"] }, "probe"), null);
});

test("one lit phase per card", () => {
  assert.equal(evidenceRefusal("cards.x", { lit: ["build", "test"] }, "probe").rule, "one-lit-phase");
  assert.equal(evidenceRefusal("cards.x", { lit: [] }, "probe").rule, "one-lit-phase");
  assert.equal(evidenceRefusal("cards.x", { lit: ["pack"] }, "probe", ["plan", "build"]).rule, "one-lit-phase");
});

test("a typed status that contradicts evidence is refused", () => {
  assert.equal(cardWriteRefusal({ id: "x", dropped: 1 }, { phase: "live" }).rule, "contradicts-evidence");
  assert.equal(cardWriteRefusal({ id: "x", dropped: 1 }, { phase: "build" }), null);
});

test("Blocked needs a note; Rework needs its reason before other writes", () => {
  assert.equal(cardWriteRefusal({ id: "x", blocked_reason: "waits" }).rule, "blocked-needs-note");
  assert.equal(cardWriteRefusal({ id: "x", blocked_reason: "waits", next_note: "n" }), null);
  assert.equal(cardWriteRefusal({ id: "x", summary: "s" }, { rework: true }).rule, "rework-reason-missing");
  assert.equal(cardWriteRefusal({ id: "x", rework_reason: "review findings" }, { rework: true }), null);
  assert.equal(cardWriteRefusal({ id: "x", rework_reason: "because" }).rule, "rework-reason");
});

test("Live now is stale past 3 minutes, never live", () => {
  assert.equal(liveNow({ version: "1.2.3", readAt: NOW - 10_000 }, NOW).state, "live");
  assert.equal(liveNow({ version: "1.2.3", readAt: NOW - STALE_AFTER_MS - 1 }, NOW).state, "stale");
  assert.equal(liveNow(null, NOW).state, "unknown");
  assert.equal(liveNow({ version: 5, readAt: NOW }, NOW).state, "unknown");
});
