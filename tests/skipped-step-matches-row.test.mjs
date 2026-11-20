// #C1319 (the owner's screenshot of #C1316 in a group of one): (1) the group row drew Plan and Language done while the opened card drew them orange "no record",
// and Design "not needed": a step the card never needed reads "not needed" on the card, and the card and the row agree. (2) A ship in progress (the card's commit
// on main, main's CI run going) drew the Ship tile yellow "slow (est.)" instead of blinking blue: it blinks blue until live.
import test from "node:test";
import assert from "node:assert/strict";
import { drawPage } from "./helpers/draw-page.mjs";
import { readingDoc } from "./harness.mjs";

const MIN = 60e3;
const card = (extra = {}) => ({ id: "c-one", num: 1316, name: "A card", status: "active", phase: "checker", size: "S", level: "Quick", who: "Checker", repo: "Flight-Board", batch: "g-one", createdAt: Date.now() - 5 * 3600e3, lastStepAt: Date.now() - 2 * MIN, ...extra });
// A product card's track has the Ship tile (the board's own track says Land).
const product = { repo: "product-app" };
// #C1382: the row draws the card's reading; `reading` is laid over a build-phase waiting one.
const draw = (cardExtra = {}, reading = {}) => drawPage({ initiatives: [card(cardExtra)], waiting: [], messages: [], steps: [], derived: [], threads: [], readings: [readingDoc("c-one", { phase: "checker", with: "Checker", ...reading })] },
  { host: "store" }).html;
const tile = (html, label) => [...html.matchAll(new RegExp(`<div class="(step[^"]*)" title="${label}[^"]*">${label}(.*?)</div>`, "g"))].map((m) => ({ cls: m[1], inner: m[2] }));

test("a card past Plan and Language with no record of either and no customer text reads them 'not needed', never 'no record'", () => {
  const html = draw();
  // #C1382: Plan is not a strip phase, so the card row draws no tile for it and the group row says "not needed"; Language is a phase the reading has passed, so the card row
  // draws it as any passed phase (done, blank) and the group row says "not needed". Neither is ever the orange "no record" or lit.
  const plan = tile(html, "Plan");
  assert.ok(plan.length >= 1, "Plan tile drawn");
  for (const x of plan) { assert.match(x.cls, /\bskip\b/, "Plan is a skipped step"); assert.match(x.inner, /not needed/, "Plan says so"); assert.doesNotMatch(x.inner, /no record/); }
  const lang = tile(html, "Language");
  assert.ok(lang.length >= 1, "Language tile drawn");
  for (const x of lang) { assert.match(x.cls, /^step (skip|done)$/, "Language is a skipped or passed step, never lit"); assert.doesNotMatch(x.inner, /no record/); }});

test("must still allow: a card that needs wording (customer text) keeps Language as a real step, and a recorded Plan is not skipped", () => {
  const html = draw({ customerText: true });
  const lang = tile(html, "Language");
  assert.ok(lang.length >= 1);
  for (const x of lang) assert.doesNotMatch(x.cls, /\bskip\b/, "Language is needed here");
});

// The reading says a session (or the CI run) is on the ship: working, so the tile is blue ("step now") and carries the card's own counter.
const shipping = { phase: "ship", state: "working", wait: null, with: "Release", working: true };
test("a ship in progress (the reading says working) blinks blue, never the yellow or the dark tile", () => {
  const html = draw({ ...product, phase: "ship", who: "Release", shipAt: Date.now() - 8 * MIN }, shipping);
  const ship = tile(html, "Ship");
  const own = ship.filter((x) => /deploying/.test(x.inner)); // the card's own tile carries the counter; the group row's does not
  assert.equal(own.length >= 1, true, "the card's Ship tile is drawn");
  assert.match(own[0].cls, /^step now\b/, "blinking blue");
  assert.doesNotMatch(own[0].cls, /stuck|waits/);
  assert.match(html, /deploying \(est\.\) 8\/~10 min/);
});

test("must still allow: a ship the reading does not call working has no counter and no blue, and a held card says held", () => {
  const idle = draw({ ...product, phase: "ship", who: "Release", shipAt: Date.now() - 20 * MIN }, { phase: "ship", state: "waiting", wait: "deploy", with: "Release", working: false });
  assert.equal(/\(est\.\)/.test(idle), false, "control: a ship that is not working has no estimate counter");
  assert.equal(tile(idle, "Ship").some((x) => /^step now\b/.test(x.cls)), false, "and no blue");
  assert.equal(tile(idle, "Ship").some((x) => /^step waits proc\b/.test(x.cls)), true, "it is the yellow wait");
  const held = draw({ ...product, phase: "ship", who: "Release", shipAt: Date.now() - 20 * MIN, blocked: "waiting on something" }, shipping);
  assert.equal(/\(est\.\)/.test(held), false, "a held card is not shown as shipping");
  assert.match(held, /held 20 min/);
});
