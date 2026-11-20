// #C1358 (the owner, 11-20, "why black?": #C1344 and #C1348 were built and sat at Checker reading a black "slow 4.6x" tile with nobody on them, because the group sends ONE READY when
// its last card is built, so no reviewer is meant to be on them yet): in stack mode a card at a review lane whose group still has a card unstarted or at build draws the yellow wait tile
// "Waits for group", never the black stuck tile or a slow word. After the READY (every member at review) a card with nobody on it and over twice the usual time is black as before, and a
// card outside any group or outside the stack is unchanged.
// #C1382: the row draws the Worker's reading, not the evidence. The wait for the group is the reading's `wait: "group"` (the card it waits for is in the reading's `why`, shown on the
// tile's hover); a black tile is the reading's `state: "stuck"`. What the page still does of its own is the slow clock (it starts at the group's READY, #C1358).
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, readingDoc, setReadings } from "./harness.mjs";

const NOW = Date.now(), H = 3600e3;
const NAMES = ["groupRow", "initRow", "gates", "enrich", "state"];
const raw = (id, num, f = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", who: "Boardsmith", repo: "flight-board", batch: "g5-thing", branch: `build/${id}`, createdAt: NOW - 5 * H + num * 60e3, ...f });
// A card at Checker for 3 hours (the usual is 10 minutes), in a stack of two.
const atChecker = (id, num, f = {}) => raw(id, num, { phase: "checker", who: "Checker", stack: { tip: "abcdef012345", size: 2 }, phaseLog: [{ phase: "build", who: "Boardsmith", start: NOW - 5 * H, end: NOW - 3 * H }, { phase: "checker", who: "Checker", start: NOW - 3 * H }], ...f });
// The readings: a member at review that waits for its group, one with nobody on it for too long (stuck), and one still being built.
const groupWait = (why = "waits for #C3 to be built") => ({ phase: "checker", state: "waiting", wait: "group", with: null, why });
const stuck = { phase: "checker", state: "stuck", wait: null, with: "Checker", working: false };
const building = { phase: "build", state: "working", wait: null, with: "Boardsmith", working: true };

function draw(cards, reads) {
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} }), querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(NAMES, { document });
  Object.assign(b.state, { initRaw: cards, initiatives: cards.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [], phaseMed: { build: 30 * 60e3, checker: 10 * 60e3, security: 10 * 60e3 } });
  setReadings(b, ...Object.entries(reads).map(([id, over]) => readingDoc(id, over)));
  const tile = (html, label = "Checker") => { const m = html.match(new RegExp(`<div class="(step[^"]*)" title="${label}([^"]*)">(.*?)</div>`)); return m && { cls: m[1], title: m[2], inner: m[3] }; };
  return { card: (k, label) => tile(b.initRow(b.state.initiatives[k]), label), html: (k) => b.initRow(b.state.initiatives[k]), group: tile(b.groupRow("g5-thing", b.state.initiatives).split('<div class="g-rail">')[0]) };
}

test("a built card at review, while the group's last card is unstarted, draws the yellow wait tile for its group, not black slow", () => {
  const d = draw([atChecker("c0", 1), atChecker("c1", 2), raw("c2", 3, { branch: undefined })], { c0: groupWait(), c1: groupWait() });
  for (const k of [0, 1]) {
    const t = d.card(k);
    assert.match(t.cls, /\bwaits proc\b/, `card ${k}: ${t.cls}`);
    assert.doesNotMatch(t.cls, /stuck|now|here/);
    assert.match(t.inner, /Waits<span class="sl"> for<\/span> group/);
    assert.match(t.title, /waits for #C3 to be built/, "the hover names the card, from the reading's why");
    assert.doesNotMatch(t.inner, /slow/);
  }
  assert.match(d.group.cls, /\bwaits\b/, `the group row follows its cards: ${d.group.cls}`);
});

test("a card waiting for a member at build says so on its hover, from the reading, and a reading with two members says it too", () => {
  const one = draw([atChecker("c0", 1), raw("c1", 2)], { c0: groupWait("waits for #C2 to be built"), c1: building });
  assert.match(one.card(0).cls, /\bwaits proc\b/);
  assert.match(one.card(0).title, /#C2/);
  const two = draw([atChecker("c0", 1), raw("c1", 2), raw("c2", 3)], { c0: groupWait("waits for 2 cards to be built"), c1: building });
  assert.match(two.card(0).title, /2 cards/);
});

test("must still go black: after the READY every member is at review, and a card the reading calls stuck is the dark stuck tile", () => {
  const d = draw([atChecker("c0", 1), atChecker("c1", 2)], { c0: stuck, c1: stuck });
  for (const k of [0, 1]) assert.match(d.card(k).cls, /^step now stuck$/, `card ${k}: ${d.card(k).cls}`);
});

test("must still go black: a card outside any group, and a card outside the stack, are unchanged", () => {
  const alone = draw([atChecker("c0", 1, { batch: null, stack: undefined }), raw("c1", 2, { batch: null })], { c0: stuck });
  assert.match(alone.card(0).cls, /\bstuck\b/, alone.card(0).cls);
  const outside = draw([atChecker("c0", 1, { stack: { outside: true, branch: "build/x" } }), raw("c1", 2)], { c0: stuck });
  assert.match(outside.card(0).cls, /\bstuck\b/, outside.card(0).cls);
});

// Checker 2's F2: the two guards that keep a card out of the wait. The page no longer decides the wait (the reading does); a card the reading has on main or being built draws no wait.
test("must not wait: a card whose reading is not a group wait (on main, or at build), in a group with an unstarted card", () => {
  const onMain = draw([atChecker("c0", 1), raw("c1", 2)], { c0: { phase: "ship", state: "waiting", wait: "land", with: null } });
  assert.doesNotMatch(onMain.card(0, "Checker").inner, /Waits<span/, "a card on main waits for nobody's build");
  const atBuild = draw([raw("c0", 1, { stack: { tip: "abcdef012345", size: 2 } }), raw("c1", 2)], { c0: building });
  assert.doesNotMatch(atBuild.card(0, "Build").inner, /Waits<span/, "a card still being built has no wait for the group");
  assert.doesNotMatch(atBuild.card(0, "Build").cls, /\bwaits\b/);
});

// Checker 2's F1: the slow clock starts at the group's READY (the last member's arrival at review), so an early member is not black the moment the last one is built.
// The page keeps this clock (tileCtx): a stuck tile carries the "slow" word only once the usual time has passed since the READY.
test("the clock starts at the READY: a member built hours ago has no slow word when the last member only just reached review, and has it once the usual time passes from then", () => {
  const log = (mins) => [{ phase: "build", who: "Boardsmith", start: NOW - 5 * H, end: NOW - 3 * H }, { phase: "checker", who: "Checker", start: NOW - mins * 60e3 }];
  const fresh = draw([atChecker("c0", 1), atChecker("c1", 2, { phaseLog: log(2) })], { c0: stuck, c1: stuck });
  for (const k of [0, 1]) assert.doesNotMatch(fresh.card(k).inner, /slow/, `card ${k} 2 min after the READY: ${fresh.card(k).inner}`);
  const late = draw([atChecker("c0", 1), atChecker("c1", 2, { phaseLog: log(40) })], { c0: stuck, c1: stuck });
  for (const k of [0, 1]) assert.match(late.card(k).inner, /slow/, `card ${k} 40 min after the READY (the usual is 10): ${late.card(k).inner}`);
});

// Designer's finding on 9ff81820: inside the open card the group wait read as a red STALLED, "No step logged for 3 h" and "Waiting for Checker".
test("the open card of a card waiting for its group reads the wait: a yellow pill, the group named; a stuck reading after the READY is Stuck, in the red pill", () => {
  const waiting = draw([atChecker("c0", 1), raw("c1", 2, { branch: undefined })], { c0: groupWait("waits for #C2 to be built") }).html(0);
  assert.match(waiting, /<span class="state queued">Waits for group<\/span>/);
  assert.doesNotMatch(waiting, /Stalled|class="state stalled"|No step logged/);
  assert.doesNotMatch(waiting, /Waiting for Checker/);
  const ready = draw([atChecker("c0", 1), atChecker("c1", 2)], { c0: stuck, c1: stuck }).html(0);
  assert.match(ready, /<span class="state stalled">Stuck<\/span>/);
});
