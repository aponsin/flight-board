// #C937 (the owner, 11-11: 13 landed cards showed an active blue Ship cell with a counter and "slow", so they looked stuck while they only waited for his install):
// a card of the board's repository that waits only for the owner's install has a quiet tile, no counter, no slow word.
// #C1382: the row draws the card's reading (state.readings), so each case below is a reading: wait pack (yellow), wait install (green, names the pack), done (no wait tile).
import test from "node:test";
import assert from "node:assert/strict";
import { drawPage } from "./helpers/draw-page.mjs";
import { readingDoc } from "./harness.mjs";

const MIN = 60e3;
const card = (extra = {}) => ({ id: "landed-card", num: 937, name: "A landed card", status: "active", phase: "ship", size: "S", level: "Quick", who: "Release", customerText: false, skip: ["plan"], repo: "Flight-Board", createdAt: Date.now() - 5 * 3600e3, shipAt: Date.now() - 30 * MIN, etaLive: Date.now() + 40 * MIN, lastStepAt: Date.now() - 5 * MIN, ...extra });
const draw = (cardExtra = {}, reading = {}, host = "store") => drawPage({ initiatives: [card(cardExtra)], waiting: [], messages: [], steps: [], derived: [], threads: [], readings: [readingDoc("landed-card", { with: "Release", ...reading })] }, { host }).html;

// #C1300: with no pack yet the landed card waits on the normal process (yellow, "Queued for pack"); the install is the owner's only once the pack is cut.
test("a landed card with no pack yet says 'Queued for pack' on the yellow stripes, not the install's green", () => {
  const html = draw({}, { phase: "pack", state: "waiting", wait: "pack" });
  assert.match(html, /Queued<span class="sl"> for pack<\/span>/);
  assert.equal(/'s install<\/span>/.test(html), false);
  assert.match(html, /<div class="step waits proc" title="Pack/);
  assert.equal(/class="step waits rel"/.test(html), false);
});

test("a landed card waiting for the install: the Install tile says the owner's install, with no counter and no slow word", () => {
  const html = draw({}, { phase: "install", state: "waiting", wait: "install", with: "Owner" });
  // Designer F2 on #C1299: "Your install" was cut on the phone's 4-a-row track, so the tile is the owner's name with "'s install" as a part hidden under 760 px.
  assert.match(html, /<small class="rs">[^<]+<span class="sl">'s install<\/span><\/small>/);
  // #C1308 (the owner's screenshot): the green wait is the Install tile's. Land and Pack stand done, and no other tile carries the stripes.
  assert.match(html, /<div class="step waits rel" title="Install[^"]*">Install<small class="rs">/, "the Install tile holds the owner's install wait");
  assert.match(html, /<div class="step done[^"]*" title="Land[^"]*">/, "Land is done, not waiting");
  assert.match(html, /<div class="step done[^"]*" title="Pack[^"]*">Pack</, "Pack is solid");
  assert.equal(/class="step waits (rel|proc)" title="(Land|Pack)/.test(html), false, "neither Land nor Pack carries the stripes");
  assert.equal(/data-shipat/.test(html), false, "no running counter");
  assert.equal(/slow \(est\.\)|deploying \(est\.\)|tests \(est\.\)/.test(html), false, "no estimate words");
  assert.equal(/<small class="slow">/.test(html), false, "no slow word");
});

// #C1309 (on #C1308's tile): the green wait names the pack when the reading carries its number: "pc111" alone on a phone, "pc111 · <owner>" on a laptop. No number: the owner's name as before.
test("the waiting Install tile names the pack when the reading has its number, and not otherwise", () => {
  const at = { phase: "install", state: "waiting", wait: "install", with: "Owner" };
  const named = draw({}, { ...at, pack: "pc111" });
  assert.match(named, /<div class="step waits rel" title="Install[^"]*">Install<small class="rs">pc111<span class="sl"> · [^<']+<\/span><\/small>/);
  assert.equal(/pc111<span class="sl"> · [^<]*'s install/.test(named), false, "the long form is gone");
  assert.match(draw({}, { ...at, pack: null }), /<small class="rs">[^<]+<span class="sl">'s install<\/span><\/small>/, "no number: the owner's name as before");
  assert.equal(/class="rs">pc/.test(draw({}, { ...at, pack: "111" })), false, "a number that is not a pc word is not shown");
  assert.equal(/class="rs">pc/.test(draw({}, { ...at, pack: "pc0x" })), false, "nor a malformed one");
});

// Checker 2's F1 on #C1308: once the install is seen the green Install wait goes away (the reading moves on: live phase, or done).
test("a card whose reading is past the install, or live, draws no waiting Install tile", () => {
  assert.match(draw({}, { phase: "install", state: "waiting", wait: "install", with: "Owner", pack: "pc111" }), /class="step waits rel"/, "control: waiting on the install is green");
  for (const [name, over] of [["done", { phase: "live", state: "done", wait: null }], ["live phase, working", { phase: "live", state: "working", wait: null, working: true }]]) {
    const html = draw({}, over);
    assert.equal(/class="step waits rel"/.test(html), false, `${name}: no green Install tile`);
    assert.equal(/'s install<\/span>/.test(html), false, `${name}: no "'s install" word`);
    assert.match(html, /<div class="step done[^"]*" title="Install/, `${name}: Install stands done`);
  }
});

test("still shown: a Release step in progress keeps its counter, and no 'Queued for your install'", () => {
  const html = draw({}, { phase: "ship", state: "working", wait: null, working: true });
  assert.match(html, /data-shipat="1"/);
  assert.match(html, /class="step now"/);
  assert.equal(/'s install<\/span>/.test(html), false);
});

test("still shown: a ship working keeps its counter on a product card, which is never green", () => {
  const product = draw({ repo: "Platform" }, { phase: "ship", state: "working", wait: null, working: true });
  assert.match(product, /data-shipat="1"/, "a product card");
  assert.equal(/'s install<\/span>/.test(product), false);
  assert.equal(/class="step waits rel"/.test(product), false, "a product card is never green");
  // A product card waits for the deploy, not an install: the yellow tile.
  const wait = draw({ repo: "Platform" }, { phase: "ship", state: "waiting", wait: "deploy" });
  assert.match(wait, /class="step waits proc"/);
  assert.equal(/class="step waits rel"/.test(wait), false);
});

test("still shown: a card sent back from its landing is the yellow tile, not queued for an install", () => {
  const html = draw({}, { phase: "ship", state: "rework", wait: "turn", with: "Builder" });
  assert.equal(/'s install<\/span>/.test(html), false);
  assert.match(html, /class="step waits proc"/, "with its owner: yellow");
});

test("still shown: a landing that failed (a red line on the card) is not called queued", () => {
  const failed = drawPage({ initiatives: [card()], waiting: [], messages: [], steps: [], threads: [], derived: [{ id: "all", cards: { "landed-card": { red: ["on ship with nothing on main"] } } }], readings: [readingDoc("landed-card", { phase: "ship", state: "stuck", wait: null, with: "Release" })] }, { host: "store" }).html;
  assert.equal(/'s install<\/span>/.test(failed), false);
  assert.match(failed, /on ship with nothing on main/, "control: the red line is drawn");
});

test("the artifact page (not the store) is unchanged", () => {
  const html = draw({}, { phase: "pack", state: "waiting", wait: "pack" }, null);
  assert.equal(/'s install<\/span>/.test(html), false);
});
