// #C207: a card's phase is the repository's (the collector's derived/all) when it has firm evidence; steps give timings.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBoard, step } from "./harness.mjs";

const T = 1_800_000_000_000;
function card(b, steps, derived, fields = {}) {
  b.state.steps = steps;
  b.state.waiting = [];
  b.state.derived = derived ? [{ id: "all", at: derived.at ?? T + 100, cards: { x: { at: derived.at ?? T + 100, ...derived } } }] : [];
  return b.gates(b.enrich({ id: "x", level: "Full", customerText: false, skip: ["plan"], status: "active", name: "X", ...fields }));
}
const built = [step("x", "build", "Builder", "start", T), step("x", "build", "Builder", "end", T + 1)];

test("live by the evidence: the card says Live, still open, never stalled, whatever the steps stopped at", () => {
  const b = loadBoard();
  const i = card(b, built, { phase: "live", version: "1.104.1", evidence: "ad601701 is on main and deployed in 1.104.1" });
  assert.equal(i.phase, "live");
  assert.equal(i.stepPhase, "checker");
  assert.equal(i.version, "1.104.1");
  assert.equal(i.upNext, false);
  const old = Date.now() - 9e6;
  assert.equal(b.stalled({ ...i, lastStepAt: old }), 0);
  assert.ok(b.stalled({ ...i, byEvidence: false, lastStepAt: old }) > 0, "the same card by its steps alone would stall");
  const html = b.initRow({ ...i, lastStepAt: old });
  assert.match(html, /Live, still open/);
  assert.doesNotMatch(html, /Stalled|up next/);
  assert.match(html, /class="evidence clash"[^>]*>Repository: Live 1\.104\.1 · steps say Checker</);
});

test("a review signed by the evidence moves the card on, with no step logged; the next reviewer is up next", () => {
  const b = loadBoard();
  const i = card(b, built, { phase: "security", evidence: "READY at 1234abcd; waiting for security" });
  assert.equal(i.phase, "security");
  assert.equal(i.who, null);
  assert.equal(i.upNext, true);
});

test("the agent on the evidence's phase is named; agreement shows no clash", () => {
  const b = loadBoard();
  const i = card(b, [...built, step("x", "checker", "Checker", "start", T + 2)], { phase: "checker", evidence: "READY; waiting for checker, security" });
  assert.equal(i.phase, "checker");
  assert.equal(i.who, "Checker");
  assert.doesNotMatch(b.initRow(i), /evidence clash/);
});

test("two reviews open at once, the evidence on the earlier one: that reviewer is named", () => {
  const b = loadBoard();
  const both = [...built, step("x", "checker", "Checker", "start", T + 2), step("x", "security", "Security", "start", T + 3)];
  const i = card(b, both, { phase: "checker", at: T + 100 });
  assert.equal(i.stepPhase, "security");
  assert.equal(i.phase, "checker");
  assert.equal(i.who, "Checker");
  assert.equal(i.upNext, false);
});

test("steps newer than the collector's run and further on win until the next run; older ones don't", () => {
  const b = loadBoard();
  const signed = [...built, step("x", "checker", "Checker", "start", T + 2), step("x", "checker", "Checker", "end", T + 300)];
  assert.equal(card(b, signed, { phase: "checker", at: T + 100 }).phase, "security");
  assert.equal(card(b, signed, { phase: "checker", at: T + 400 }).phase, "checker");
});

test("no evidence, or evidence that can't be firm (a head with no READY yet), leaves the steps' phase", () => {
  const b = loadBoard();
  assert.equal(card(b, built, null).phase, "checker");
  assert.equal(card(b, built, { phase: "build", firm: false }).phase, "checker");
  assert.equal(card(b, built, { phase: "nonsense" }).phase, "checker");
  assert.equal(card(b, [], { phase: "security" }).phase, "security", "a card with no steps at all still shows its evidence");
});

test("the stall clock counts from the READY commit too, and a done card is left alone", () => {
  const b = loadBoard();
  const i = card(b, built, { phase: "security", readyAt: T + 50 });
  assert.equal(i.lastStepAt, T + 50);
  assert.equal(card(b, [...built, step("x", "live", "Release", "end", T + 5, { version: "1.0.0" })], { phase: "ship" }).status, "done");
});
