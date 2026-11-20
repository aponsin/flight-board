// #C1279 (Checker 2's LOW on #C1277, the owner: nothing is a guess): the dark stuck tile says "nobody is on it", so it needs a reading that shows nobody on the card. With no reading a slow
// step is the plain ring with "slow N×" and a hover that says there is no reading; with a reading that shows an agent on it, the blue with "slow N×". On a phone the stuck words shorten to "slow N×".
// #C1382: the row draws the Worker's reading (state.readings): unknown (or none) is the plain ring, stuck is the dark tile, working is the blue.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames, step, readingDoc, setReadings } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const css = page.slice(page.indexOf("<style>"), page.indexOf("</style>"));
const NOW = Date.now(), MIN = 60e3, H = 36e5, ID = "rev-card";
const base = { id: ID, num: 448, name: "Our work editor", status: "active", phase: "checker", size: "S", level: "Full", who: "Checker", createdAt: NOW - 5 * H, nextNote: "x", nextNoteAt: NOW };
const hist = ["d1", "d2", "d3"].map((id) => ({ id, status: "done", size: "S", doneAt: NOW - H, phaseLog: [{ phase: "checker", start: NOW - 9 * H, end: NOW - 8 * H }] }));
// A checker step open for 2.5 h against a usual hour: slow (over twice the usual).
function board(over) {
  const b = loadNames(["enrich", "gates", "initRow", "phaseMedians", "CONFIG"]);
  b.CONFIG.collector = { notes: { language: "refs/notes/linguist", checker: "refs/notes/checker", security: "refs/notes/security" } };
  Object.assign(b.state, {
    initRaw: [base], steps: [step(ID, "build", "Builder", "start", NOW - 9 * H), step(ID, "build", "Builder", "end", NOW - 8 * H), step(ID, "checker", "Checker", "start", NOW - 2.5 * H)], waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [], checkRequests: [],
    derived: [{ id: "all", at: NOW - 50 * MIN, cards: { [ID]: { phase: "checker", at: NOW - 50 * MIN } } }],
  });
  if (over) setReadings(b, readingDoc(ID, { phase: "checker", with: "Checker", ...over }));
  b.state.initiatives = [...hist, b.gates(b.enrich(base))];
  b.state.phaseMed = b.phaseMedians(b.state.initiatives);
  return b.initRow(b.state.initiatives[b.state.initiatives.length - 1]);
}
const tile = (h, label) => { const m = h.match(new RegExp(`<div class="(step[^"]*)" title="(${label}[^"]*)">(.*?)</div>`)); return m && { cls: m[1], title: m[2], inner: m[3] }; };

test("no reading served: nothing says nobody is on it: no dark stuck tile, no blue, no slow word, and the pill says 'No reading'", () => {
  const h = board(null);
  const t = tile(h, "Checker");
  assert.doesNotMatch(t.cls, /\b(stuck|now)\b/, "no reading: nothing says nobody is on it");
  assert.equal(/class="slow"/.test(h), false, "no slow word without a reading");
  assert.match(h, /<span class="state[^"]*">No reading<\/span>/);
});

test("an unknown reading is the plain ring: 'no reading' on the tile, the reason in the hover, never dark, no slow word", () => {
  const h = board({ state: "unknown", wait: null, with: null, why: "no fresh reading and no earlier good one" });
  const t = tile(h, "Checker");
  assert.match(t.cls, /\bhere\b/);
  assert.doesNotMatch(t.cls, /\bstuck\b/);
  assert.match(t.inner, /<small>no reading<\/small>/);
  assert.match(t.title, /no fresh reading and no earlier good one/);
  assert.equal(/class="slow"/.test(h), false);
});

test("a reading that shows nobody on the card (stuck): the dark stuck tile; a reading that shows an agent on it (working): the blue, never dark", () => {
  const stuck = tile(board({ state: "stuck", wait: null, working: false }), "Checker");
  assert.match(stuck.cls, /\bstuck\b/);
  assert.match(stuck.inner, /slow<span class="sl"> ·<\/span> 2\.5×<span class="sl"> usual<\/span>/);
  const on = tile(board({ state: "working", wait: null, working: true }), "Checker");
  assert.match(on.cls, /\bnow\b/);
  assert.doesNotMatch(on.cls, /\bstuck\b/);
  assert.match(on.inner, /<small class="slow">slow 2\.5×<\/small>/);
});

test("on a phone the stuck words shorten to 'slow N×': the .sl parts are hidden under 760 px", () => {
  assert.match(css, /@media \(max-width:760px\)\{\.step small\.slow \.sl\{display:none\}\}/);
});
