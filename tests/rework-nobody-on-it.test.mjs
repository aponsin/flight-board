// A card sent back (state rework) whose owner is on another card is waiting its turn with its owner (wait turn, working false): the yellow tile ("step waits proc") with the pill "Sent back",
// never the red or the dark tile, and never the blue; a card whose reading says rework with its owner working on it is the blue ("step now").
// #C1382: the row draws the card's reading and nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import { drawPage } from "./helpers/draw-page.mjs";
import { readingDoc } from "./harness.mjs";

const card = { id: "back-card", num: 2001, name: "A card sent back", status: "active", phase: "build", size: "S", level: "Quick", who: "Builder", customerText: false, skip: ["plan"], repo: "Flight-Board", createdAt: Date.now() - 5 * 3600e3, lastStepAt: Date.now() - 5 * 60e3 };
const draw = (over) => drawPage({ initiatives: [card], waiting: [], messages: [], steps: [], derived: [], threads: [], readings: [readingDoc("back-card", { phase: "build", state: "rework", with: "Builder", ...over })] }, { host: "store" }).html;
const tile = (h, label) => { const m = h.match(new RegExp(`<div class="(step[^"]*)" title="(${label}[^"]*)">(.*?)</div>`)); return m && { cls: m[1], title: m[2], inner: m[3] }; };
const pill = (h) => /<span class="state[^"]*">([^<]*)<\/span>/.exec(h)[1];

test("a card sent back with its owner on another card: the yellow tile and 'Sent back', never the red, the dark or the blue", () => {
  const html = draw({ wait: "turn", working: false });
  const t = tile(html, "Build");
  assert.equal(t.cls, "step waits proc", "yellow");
  assert.doesNotMatch(t.cls, /\b(ask|stuck|now|here)\b/, "never the red, the dark or the blue");
  assert.match(t.inner, /Waits<span class="sl"> for<\/span> Builder/, "the tile says it waits for its owner's turn");
  assert.equal(pill(html), "Sent back");
  // The same card whose reading carries no wait word still reads as sent back, on the same yellow tile.
  const bare = draw({ wait: null, working: false });
  assert.equal(tile(bare, "Build").cls, "step waits proc");
  // Designer on 8c8c6488: " back" in a .sl part is hidden under 760 px, so a phone read "SENT"; the words are whole.
  assert.match(tile(bare, "Build").inner, /<small>Builder<\/small>/, "#C1406 restated: the tile names the owner the card is back with, and only that (it said 'Sent back'; the name was cut behind a longer word)");
  assert.doesNotMatch(tile(bare, "Build").inner, /class="sl"/);
  assert.doesNotMatch(html, /class="step waits ask"|class="step now stuck"|class="step now"/, "no tile on the row is red, dark or blue");
});

test("a sent-back card with a wait word shows it: the pill says the wait and the tile stays yellow", () => {
  const html = draw({ wait: "group", working: false });
  assert.equal(tile(html, "Build").cls, "step waits proc");
  assert.match(tile(html, "Build").inner, /Waits<span class="sl"> for<\/span> group/);
  assert.match(pill(html), /^(Sent back|Waits for group)$/);
});

test("a card whose reading says rework with its owner working on it is the blue", () => {
  const html = draw({ wait: null, working: true });
  const t = tile(html, "Build");
  assert.equal(t.cls, "step now", "blue");
  assert.doesNotMatch(t.cls, /\b(waits|stuck)\b/);
  assert.equal(pill(html), "Sent back");
});
