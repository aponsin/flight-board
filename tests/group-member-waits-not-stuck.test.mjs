// #C1358 (the owner, 11-20, "why black?": #C1344 and #C1348 were built and sat at Checker reading a black "slow 4.6x" tile with nobody on them, because the group sends ONE READY when
// its last card is built, so no reviewer is meant to be on them yet): in stack mode a card at a review lane whose group still has a card unstarted or at build draws the yellow wait tile
// "Waits for #C1357", never the black stuck tile or a slow word. After the READY (every member at review) a card with nobody on it and over twice the usual time is black as before, and a
// card outside any group or outside the stack is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const NOW = Date.now(), H = 3600e3;
const NAMES = ["groupRow", "initRow", "gates", "enrich", "probeEvent", "state"];
const raw = (id, num, f = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", who: "Boardsmith", repo: "flight-board", batch: "g5-thing", branch: `build/${id}`, createdAt: NOW - 5 * H + num * 60e3, ...f });
const idle = { state: "idle", lastActivityAt: NOW - 600e3, since: NOW - 600e3 };
// A card at Checker for 3 hours (the usual is 10 minutes), in a stack of two.
const atChecker = (id, num, f = {}) => raw(id, num, { phase: "checker", who: "Checker", stack: { tip: "abcdef012345", size: 2 }, phaseLog: [{ phase: "build", who: "Boardsmith", start: NOW - 5 * H, end: NOW - 3 * H }, { phase: "checker", who: "Checker", start: NOW - 3 * H }], ...f });
const read = (f = {}) => ({ phase: "checker", headSha12: "a1b2c3d4e5f6", onMain: false, seen: ["build", "checker"], ...f });

function draw(cards, reads) {
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} }), querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(NAMES, { document });
  Object.assign(b.state, { initRaw: cards, initiatives: cards.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [], phaseMed: { build: 30 * 60e3, checker: 10 * 60e3, security: 10 * 60e3 } });
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: NOW - 20e3 }, cards: reads, agents: { Boardsmith: idle, Checker: idle, Release: idle } } } }, {});
  const tile = (html, label = "Checker") => { const m = html.match(new RegExp(`<div class="(step[^"]*)" title="${label}[^"]*">(.*?)</div>`)); return m && { cls: m[1], inner: m[2] }; };
  return { card: (k, label) => tile(b.initRow(b.state.initiatives[k]), label), html: (k) => b.initRow(b.state.initiatives[k]), group: tile(b.groupRow("g5-thing", b.state.initiatives).split('<div class="g-rail">')[0]) };
}

test("a built card at review, while the group's last card is unstarted, draws the yellow wait tile naming that card, not black slow", () => {
  const d = draw([atChecker("c0", 1), atChecker("c1", 2), raw("c2", 3, { branch: undefined })], { c0: read(), c1: read({ headSha12: "b1b2c3d4e5f6" }) });
  for (const k of [0, 1]) {
    const t = d.card(k);
    assert.match(t.cls, /\bwaits proc\b/, `card ${k}: ${t.cls}`);
    assert.doesNotMatch(t.cls, /stuck|now|here/);
    assert.match(t.inner, /Waits<span class="sl"> for<\/span> #C3/);
    assert.doesNotMatch(t.inner, /slow/);
  }
  assert.match(d.group.cls, /\bwaits\b/, `the group row follows its cards: ${d.group.cls}`);
});

test("a card waiting for a member at build names it too, and two members read as a count", () => {
  const one = draw([atChecker("c0", 1), raw("c1", 2)], { c0: read(), c1: read({ phase: "build", seen: ["build"], headSha12: "b1b2c3d4e5f6" }) });
  assert.match(one.card(0).inner, /#C2/);
  const two = draw([atChecker("c0", 1), raw("c1", 2), raw("c2", 3)], { c0: read(), c1: read({ phase: "build", seen: ["build"], headSha12: "b1b2c3d4e5f6" }) });
  assert.match(two.card(0).inner, /2<span class="sl"> cards|2 cards/);
});

test("must still go black: after the READY every member is at review, and a slow card with nobody on it is the dark stuck tile", () => {
  const d = draw([atChecker("c0", 1), atChecker("c1", 2)], { c0: read(), c1: read({ headSha12: "b1b2c3d4e5f6" }) });
  for (const k of [0, 1]) assert.match(d.card(k).cls, /\bstuck\b/, `card ${k}: ${d.card(k).cls}`);
});

test("must still go black: a card outside any group, and a card outside the stack, are unchanged", () => {
  const alone = draw([atChecker("c0", 1, { batch: null, stack: undefined }), raw("c1", 2, { batch: null })], { c0: read() });
  assert.match(alone.card(0).cls, /\bstuck\b/, alone.card(0).cls);
  const outside = draw([atChecker("c0", 1, { stack: { outside: true, branch: "build/x" } }), raw("c1", 2)], { c0: read() });
  assert.match(outside.card(0).cls, /\bstuck\b/, outside.card(0).cls);
});

// Checker 2's F2: the two guards that keep a card out of the wait.
test("must not wait: a card already on main, and a card at build (not at a review lane), in a group with an unstarted card", () => {
  const onMain = draw([atChecker("c0", 1), raw("c1", 2)], { c0: read({ onMain: true }) });
  assert.doesNotMatch(onMain.card(0).inner, /Waits<span/, "a card on main waits for nobody's build");
  const atBuild = draw([raw("c0", 1, { stack: { tip: "abcdef012345", size: 2 } }), raw("c1", 2)], { c0: read({ phase: "build", seen: ["build"] }) });
  assert.doesNotMatch(atBuild.card(0, "Build").inner, /Waits<span/, "a card still being built has no wait for the group");
  assert.doesNotMatch(atBuild.card(0, "Build").cls, /\bwaits\b/);
});

// Checker 2's F1: the slow clock starts at the group's READY (the last member's arrival at review), so an early member is not black the moment the last one is built.
test("the clock starts at the READY: a member built hours ago is not black when the last member only just reached review, and is black once the usual time passes from then", () => {
  const log = (mins) => [{ phase: "build", who: "Boardsmith", start: NOW - 5 * H, end: NOW - 3 * H }, { phase: "checker", who: "Checker", start: NOW - mins * 60e3 }];
  const fresh = draw([atChecker("c0", 1), atChecker("c1", 2, { phaseLog: log(2) })], { c0: read(), c1: read({ headSha12: "b1b2c3d4e5f6" }) });
  for (const k of [0, 1]) assert.doesNotMatch(fresh.card(k).cls, /\bstuck\b/, `card ${k} 2 min after the READY: ${fresh.card(k).cls}`);
  const late = draw([atChecker("c0", 1), atChecker("c1", 2, { phaseLog: log(40) })], { c0: read(), c1: read({ headSha12: "b1b2c3d4e5f6" }) });
  for (const k of [0, 1]) assert.match(late.card(k).cls, /\bstuck\b/, `card ${k} 40 min after the READY (the usual is 10): ${late.card(k).cls}`);
});

// Designer's finding on 9ff81820: inside the open card the group wait read as a red STALLED, "No step logged for 3 h" and "Waiting for Checker".
test("the open card of a card waiting for its group reads the wait: a yellow pill, no red no-step line, the card it waits for; after the READY it is Stalled as before", () => {
  const waiting = draw([atChecker("c0", 1), raw("c1", 2, { branch: undefined })], { c0: read() }).html(0);
  assert.match(waiting, /<span class="state queued">Waits for #C2<\/span>/);
  assert.doesNotMatch(waiting, /Stalled|class="state stalled"|No step logged/);
  assert.match(waiting, /Waiting for #C2/, "the version note names the card, not the reviewer");
  assert.doesNotMatch(waiting, /Waiting for Checker/);
  const ready = draw([atChecker("c0", 1), atChecker("c1", 2)], { c0: read(), c1: read({ headSha12: "b1b2c3d4e5f6" }) }).html(0);
  assert.match(ready, /<span class="state stalled">Stalled<\/span>/);
  assert.match(ready, /No step logged/);
});
