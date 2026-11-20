// #C937 (the owner, 11-11: 13 landed cards showed an active blue Ship cell with a counter and "slow", so they looked stuck while they only waited for his install):
// a card of the board's repository that is on main and waits only for the owner's install has a quiet Ship cell, "Queued for your install", no counter, no slow word.
import test from "node:test";
import assert from "node:assert/strict";
import { drawPage } from "./helpers/draw-page.mjs";

const MIN = 60e3;
const card = (extra = {}) => ({ id: "landed-card", num: 937, name: "A landed card", status: "active", phase: "ship", size: "S", level: "Quick", who: "Release", customerText: false, skip: ["plan"], repo: "Flight-Board", createdAt: Date.now() - 5 * 3600e3, shipAt: Date.now() - 30 * MIN, etaLive: Date.now() + 40 * MIN, lastStepAt: Date.now() - 5 * MIN, ...extra });
const probe = (c = {}) => ({ v: 1, board: { at: Date.now() - 20e3 }, cards: { "landed-card": { headSha12: "a1b2c3d4e5f6", onMain: true, phase: "ship", shipping: false, ...c } }, agents: {} });
const draw = (cardExtra = {}, probeExtra = {}, host = "store") => drawPage({ initiatives: [card(cardExtra)], waiting: [], messages: [], steps: [], derived: [], threads: [] }, { probe: probe(probeExtra), host }).html;

// #C1300: with no pack cut yet the landed card waits on the normal process (yellow, "Queued for pack"); the install is the owner's only once the pack is cut.
test("a landed card with no pack yet says 'Queued for pack' on the yellow stripes, not the install's green", () => {
  const html = draw();
  assert.match(html, /Queued<span class="sl"> for pack<\/span>/);
  assert.equal(/'s install<\/span>/.test(html), false);
  assert.match(html, /class="step waits proc"/);
  assert.equal(/class="step waits rel"/.test(html), false);
});

test("a landed card waiting for the install: the Ship cell says 'Queued for your install', with no counter and no slow word", () => {
  const html = draw({}, { packed: true });
  // Designer F2 on #C1299: "Your install" was cut to "YOUR INST…" on the phone's 4-a-row track, so the tile is the owner's name with "'s install" as a part hidden under 760 px.
  assert.match(html, /<small class="rs">[^<]+<span class="sl">'s install<\/span><\/small>/);
  assert.match(html, /class="step waits rel"/);
  // #C1308 (the owner's screenshot): the green wait is the Install tile's. Land and Pack stand done, and no other tile carries the stripes.
  assert.match(html, /<div class="step waits rel" title="Install: [^"]*">Install<small class="rs">/, "the Install tile holds the owner's install wait");
  assert.match(html, /<div class="step done[^"]*" title="Land[^"]*">/, "Land is done, not waiting");
  assert.match(html, /<div class="step done seen" title="Pack: [^"]*">Pack</, "Pack is solid");
  assert.equal(/class="step waits (rel|proc)" title="(Land|Pack)/.test(html), false, "neither Land nor Pack carries the stripes");
  assert.equal(/title="Land[^"]*">Land<small[^>]*>[^<]*install/i.test(html), false, "Land says no install word");
  assert.equal(/data-shipat/.test(html), false, "no running counter");
  assert.equal(/slow \(est\.\)|deploying \(est\.\)|tests \(est\.\)/.test(html), false, "no estimate words");
});

// #C1309 (on #C1308's tile): the green wait names the pack when the probe read its number: "pc111" alone on a phone, "pc111 · <owner>'s install" on a laptop. No number: the owner's name as before.
test("the waiting Install tile names the pack when its number is read, and not otherwise", () => {
  const named = draw({}, { packed: true, pack: 111 });
  // Designer F1 on #C1309: "pc111 · <owner>'s install" is 127 px in a 107 px laptop tile and clipped; the name alone ("pc111 · <owner>", about 72 px) fits.
  assert.match(named, /<div class="step waits rel" title="Install: [^"]*">Install<small class="rs">pc111<span class="sl"> · [^<']+<\/span><\/small>/);
  assert.equal(/pc111<span class="sl"> · [^<]*'s install/.test(named), false, "the long form is gone");
  assert.match(draw({}, { packed: true }), /<small class="rs">[^<]+<span class="sl">'s install<\/span><\/small>/, "no number read: the owner's name as before");
  assert.equal(/class="rs">pc/.test(draw({}, { packed: true, pack: "111" })), false, "a number that is not an integer is not shown");
  assert.equal(/class="rs">pc/.test(draw({}, { packed: true, pack: 0 })), false, "nor zero");
});

// Checker 2's F1 on #C1308: once the install is seen (the live reading says installed, or has seen the Live phase) the green Install wait goes away.
test("a packed, landed card whose live reading is installed, or has seen Live, draws no waiting Install tile", () => {
  assert.match(draw({}, { packed: true }), /class="step waits rel"/, "control: packed and not installed waits green");
  for (const [name, extra] of [["installed:true", { installed: true }], ["seen:[live]", { seen: ["live"] }]]) {
    const html = draw({}, { packed: true, ...extra });
    assert.equal(/class="step waits rel"/.test(html), false, `${name}: no green Install tile`);
    assert.equal(/'s install<\/span>/.test(html), false, `${name}: no "'s install" word`);
  }
});

test("still shown: a Release step in progress keeps its counter, and no 'Queued for your install'", () => {
  const html = draw({}, { shipping: true });
  assert.match(html, /data-shipat="1"/);
  assert.equal(/'s install<\/span>/.test(html), false);
});

test("still shown: a card not yet on main keeps its counter, and a product card keeps its deploy timing", () => {
  assert.match(draw({}, { onMain: false }), /data-shipat="1"/, "not on main");
  const product = draw({ repo: "Platform" });
  assert.match(product, /data-shipat="1"/, "a product card");
  assert.equal(/'s install<\/span>/.test(product), false);
  // Checker 2's F2 on a0e01b87: green is only the owner's install, never a product card, even when the repository reads the install wait for it.
  const wait = (repo) => drawPage({ initiatives: [card({ repo })], waiting: [], messages: [], steps: [], threads: [], derived: [{ id: "all", cards: { "landed-card": { wait: "install" } } }] }, { probe: probe(), host: "store" }).html;
  assert.match(wait("Flight-Board"), /class="step waits rel"/, "control: the board's own card waiting on the install is green");
  assert.equal(/class="step waits rel"/.test(wait("Platform")), false, "a product card is never green");
});

test("still shown: a landing that failed (a red line on the card) is not called queued", () => {
  const failed = drawPage({ initiatives: [card()], waiting: [], messages: [], steps: [], threads: [], derived: [{ id: "all", cards: { "landed-card": { red: ["on ship with nothing on main"] } } }] }, { probe: probe(), host: "store" }).html;
  assert.equal(/'s install<\/span>/.test(failed), false);
  assert.match(failed, /on ship with nothing on main/, "control: the red line is drawn");
});

test("the artifact page (not the store) is unchanged", () => {
  const html = draw({}, {}, null);
  assert.equal(/'s install<\/span>/.test(html), false);
});
