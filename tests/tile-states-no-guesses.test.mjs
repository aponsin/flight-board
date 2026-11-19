// #C1277 (the owner: "nothing is a guess"): #C1267 left two guesses its own text names. (1) A phase before the current one was drawn as done by its place in the order: it is green only with a
// record (its own time, a sign-off note, or the repository's evidence); with none it is the amber "no record" tile. (2) The active tile (blue, blinking) fell back to the typed state when the page had no
// probe reading: it is active only from a reading that shows an agent working on the card; with no reading it is the plain ring, and its hover says so.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBoard, step, probeWorking } from "./harness.mjs";

const T = Date.now() - 2 * 36e5;
const item = (b, steps, fields = {}) => { b.state.steps = steps; b.state.waiting = []; return b.gates(b.enrich({ id: "x", level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X", ...fields })); };
const tile = (h, label) => { const m = h.match(new RegExp(`<div class="(step[^"]*)" title="(${label}[^"]*)">(.*?)</div>`)); return m && { cls: m[1], title: m[2], inner: m[3] }; };
const building = (b) => item(b, [step("x", "build", "Builder", "start", T), step("x", "build", "Builder", "end", T + 60e3), step("x", "checker", "Checker", "start", T + 120e3)]);

test("no probe reading: the current tile is the plain ring, never the blinking blue, and the hover says why", () => {
  const b = loadBoard(), t = tile(b.initRow(building(b)), "Checker");
  assert.match(t.cls, /\bhere\b/);
  assert.doesNotMatch(t.cls, /\bnow\b/);
  assert.match(t.title, /evidence: no live reading, so the tile is not shown as active/);
});

test("a reading that shows an agent working on the card: the blinking blue, with the probe named as the evidence", () => {
  const b = loadBoard(), i = building(b);
  probeWorking(b, "x", "Checker", { phase: "checker" });
  const t = tile(b.initRow(i), "Checker");
  assert.match(t.cls, /\bnow\b/);
  assert.match(t.title, /evidence: the probe sees Checker working on it/);
});

test("a reading with nobody on the card: the ring again, not blue", () => {
  const b = loadBoard(), i = building(b);
  probeWorking(b, "other-card", "Checker", { phase: "checker" });
  const t = tile(b.initRow(i), "Checker");
  assert.doesNotMatch(t.cls, /\bnow\b/);
  assert.match(t.title, /evidence: the probe sees no agent on it/);
});

test("a phase before the current one is green only with a record; with none it is the amber 'no record' tile", () => {
  const b = loadBoard();
  const rec = item(b, [step("x", "build", "Builder", "start", T), step("x", "build", "Builder", "end", T + 60e3), step("x", "checker", "Checker", "start", T + 120e3)]);
  const done = tile(b.initRow(rec), "Build");
  assert.match(done.cls, /\bdone\b/);
  assert.doesNotMatch(done.cls, /\bnorec\b/, "its own time: a record");
  const none = item(b, [step("x", "checker", "Checker", "start", T)]); // checker is current; build has no step at all
  const guess = tile(b.initRow(none), "Build");
  assert.match(guess.cls, /\bnorec\b/, "no record: amber, never plain green");
  assert.match(guess.inner, /no record/);
});
