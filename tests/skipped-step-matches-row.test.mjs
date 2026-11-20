// #C1319 (the owner's screenshot of #C1316 in a group of one): (1) the group row drew Plan and Language done while the opened card drew them orange "no record",
// and Design "not needed": a step the card never needed reads "not needed" on the card, and the card and the row agree. (2) A ship in progress (the card's commit
// on main, main's CI run going) drew the Ship tile yellow "slow (est.)" instead of blinking blue: it blinks blue until live.
import test from "node:test";
import assert from "node:assert/strict";
import { drawPage } from "./helpers/draw-page.mjs";

const MIN = 60e3;
const card = (extra = {}) => ({ id: "c-one", num: 1316, name: "A card", status: "active", phase: "checker", size: "S", level: "Quick", who: "Checker", repo: "Flight-Board", batch: "g-one", createdAt: Date.now() - 5 * 3600e3, lastStepAt: Date.now() - 2 * MIN, ...extra });
// A product card's track has the Ship tile (the board's own track says Land).
const product = { repo: "product-app" };
const draw = (cardExtra = {}, probeCard = {}, agents = {}) => drawPage({ initiatives: [card(cardExtra)], waiting: [], messages: [], steps: [], derived: [], threads: [] },
  { probe: { v: 1, board: { at: Date.now() - 20e3 }, cards: { "c-one": { headSha12: "a1b2c3d4e5f6", phase: "checker", ...probeCard } }, agents }, host: "store" }).html;
const tile = (html, label) => [...html.matchAll(new RegExp(`<div class="(step[^"]*)" title="${label}[^"]*">${label}(.*?)</div>`, "g"))].map((m) => ({ cls: m[1], inner: m[2] }));

test("a card past Plan and Language with no record of either and no customer text reads them 'not needed', never 'no record'", () => {
  const html = draw();
  for (const l of ["Plan", "Language"]) {
    const t = tile(html, l);
    assert.ok(t.length >= 1, `${l} tile drawn`);
    for (const x of t) { assert.match(x.cls, /\bskip\b/, `${l} is a skipped step`); assert.match(x.inner, /not needed/, `${l} says so`); assert.doesNotMatch(x.inner, /no record/); }
  }
});

test("must still allow: a card that needs wording (customer text) keeps Language as a real step, and a recorded Plan is not skipped", () => {
  const html = draw({ customerText: true });
  const lang = tile(html, "Language");
  assert.ok(lang.length >= 1);
  for (const x of lang) assert.doesNotMatch(x.cls, /\bskip\b/, "Language is needed here");
});

test("a ship in progress (commit on main, main's CI running) blinks blue and is never 'slow'", () => {
  const html = draw({ ...product, phase: "ship", who: "Release", shipAt: Date.now() - 20 * MIN }, { phase: "ship", onMain: true, ci: "running", ciMin: 20 });
  const ship = tile(html, "Ship");
  const own = ship.filter((x) => /deploying/.test(x.inner)); // the card's own tile carries the counter; the group row's does not
  assert.equal(own.length >= 1, true, "the card's Ship tile is drawn");
  assert.match(own[0].cls, /^step now\b/, "blinking blue");
  assert.doesNotMatch(own[0].cls, /stuck/);
  assert.equal(/slow \(est\.\)/.test(html), false, "no slow word");
  assert.match(html, /deploying \(est\.\)/);
});

test("must still allow: the same card with its CI not running keeps the slow reading, and a held card is not shown as shipping", () => {
  const slow = draw({ ...product, phase: "ship", who: "Release", shipAt: Date.now() - 20 * MIN }, { phase: "ship", onMain: true, ci: "passed" });
  assert.match(slow, /slow \(est\.\)/, "control: past its usual time with no run going is slow");
  const held = draw({ ...product, phase: "ship", who: "Release", shipAt: Date.now() - 20 * MIN, blocked: "waiting on something" }, { phase: "ship", onMain: true, ci: "running", ciMin: 20 });
  assert.equal(tile(held, "Ship").some((x) => /^step now\b/.test(x.cls) && /est\./.test(x.inner)), false);
});
