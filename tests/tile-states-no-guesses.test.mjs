// #C1277 (the owner: "nothing is a guess"): #C1267 left two guesses its own text names. (1) A phase before the current one was drawn as done by its place in the order. (2) The active tile (blue, blinking) fell back
// to the typed state when the page had no reading: it is active only from a reading that shows an agent working on the card; with no reading it is the plain ring, and its hover says so.
// #C1382: the row draws the Worker's reading (state.readings) and nothing of the evidence: a phase the reading has passed is done, the reading's phase is drawn by its state, and a card with no
// reading is "no reading", never a guess from the step log.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBoard, step, readingDoc, setReadings } from "./harness.mjs";

const T = Date.now() - 2 * 36e5;
const item = (b, steps, fields = {}) => { b.state.steps = steps; b.state.waiting = []; return b.gates(b.enrich({ id: "x", level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X", ...fields })); };
const tile = (h, label) => { const m = h.match(new RegExp(`<div class="(step[^"]*)" title="(${label}[^"]*)">(.*?)</div>`)); return m && { cls: m[1], title: m[2], inner: m[3] }; };
const building = (b) => item(b, [step("x", "build", "Builder", "start", T), step("x", "build", "Builder", "end", T + 60e3), step("x", "checker", "Checker", "start", T + 120e3)]);
const read = (b, over) => setReadings(b, readingDoc("x", { phase: "checker", with: "Checker", ...over }));

test("no reading: the card draws no tile as active, never the blinking blue, and says 'no reading'", () => {
  const b = loadBoard(), h = b.initRow(building(b)), t = tile(h, "Checker");
  assert.doesNotMatch(t.cls, /\b(now|stuck|done)\b/);
  assert.equal(/class="step now/.test(h), false, "no tile is blue");
  assert.match(h, /<span class="state[^"]*">No reading<\/span>/);
});

test("an unknown reading is the plain ring (here) with 'no reading', and the hover carries the reading's reason", () => {
  const b = loadBoard(), i = building(b);
  read(b, { state: "unknown", wait: null, with: null, why: "no fresh reading and no earlier good one" });
  const t = tile(b.initRow(i), "Checker");
  assert.match(t.cls, /\bhere\b/);
  assert.doesNotMatch(t.cls, /\bnow\b/);
  assert.match(t.title, /no fresh reading and no earlier good one/);
});

test("a reading that shows an agent working on the card: the blinking blue, with the reading's reason in the hover", () => {
  const b = loadBoard(), i = building(b);
  read(b, { state: "working", wait: null, working: true, why: "Checker is working on it" });
  const t = tile(b.initRow(i), "Checker");
  assert.match(t.cls, /\bnow\b/);
  assert.doesNotMatch(t.cls, /\b(stuck|waits)\b/);
  assert.match(t.title, /Checker is working on it/);
});

test("a reading with nobody on the card (waiting its turn): the yellow tile again, not blue", () => {
  const b = loadBoard(), i = building(b);
  read(b, { state: "waiting", wait: "turn", working: false });
  const t = tile(b.initRow(i), "Checker");
  assert.doesNotMatch(t.cls, /\bnow\b/);
  assert.match(t.cls, /\bwaits proc\b/);
});

test("a phase before the reading's phase is done, whatever the step log holds: the page decides nothing from the evidence", () => {
  const b = loadBoard();
  const rec = building(b);
  read(b, { state: "working", wait: null, working: true });
  const done = tile(b.initRow(rec), "Build");
  assert.match(done.cls, /^step done$/);
  // The card has no step at all for build (checker is its first step): the reading still says build is passed, and the page draws it so, never the amber "no record" tile.
  const none = item(b, [step("x", "checker", "Checker", "start", T)]);
  const passed = tile(b.initRow(none), "Build");
  assert.match(passed.cls, /^step done$/);
  assert.doesNotMatch(passed.cls, /\bnorec\b/);
  assert.doesNotMatch(passed.inner, /no record/);
});
