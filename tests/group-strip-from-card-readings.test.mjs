// #C1402 (the owner, 11-20 7:38 pm MT, a screenshot of #G119: the group's Land tile was yellow "pc123 · <owner>" while all three cards' Land tiles were green with the same label):
// the group row's tile is drawn from its cards' readings only. A landed card waits for install at Land, Pack or Install alike (its reading's phase is whichever the probe holds it at), the
// card's tile is green from the reading's WAIT, and the group's own rule picked green from the phase KEY (Install). The class of a tile is now one function (tileClass) that the card row and
// the group row both ask, and the group has no class rule of its own. Tests: the exact case, then every phase and every kind of reading with all the cards agreeing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames, readingDoc, setReadings } from "./harness.mjs";

const NAMES = ["groupRow", "initRow", "gates", "enrich", "state"];
function board(initRaw, readings) {
  const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(NAMES, { document });
  Object.assign(b.state, { initRaw, initiatives: initRaw.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [] });
  setReadings(b, ...Object.entries(readings).map(([id, over]) => readingDoc(id, over)));
  return { group: () => b.groupRow("g5-thing", b.state.initiatives), card: (id) => b.initRow(b.state.initiatives.find((i) => i.id === id)) };
}
const raw = (id, num, fields = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "ship", who: "Boardsmith", repo: "flight-board", batch: "g5-thing", branch: `build/${id}`, createdAt: 1_800_000_000_000 + num * 60e3, ...fields });
const groupTrack = (html) => html.split('<div class="g-rail">')[0];
// Every tile of a row as { label: [class, inner] }: the label is the title up to its first " |" or ":" (a card's title carries its reason, a group's the count).
function tiles(html) {
  const out = {};
  for (const m of html.matchAll(/<div class="(step[^"]*)" title="([^"]*)">(.*?)<\/div>/g)) out[m[2].split(/ \||:/)[0]] = [m[1], m[3]];
  return out;
}
const ids = ["a", "b", "c"];
const all = (r) => Object.fromEntries(ids.map((id) => [id, r]));
const cards = (over = {}) => ids.map((id, k) => raw(id, k + 1, over));

test("the screenshot: three cards green at Land, waiting for install, give a green Land tile on the group with the cards' own label", () => {
  const r = { phase: "ship", state: "waiting", wait: "install", with: null, pack: "pc123" };
  const { group, card } = board(cards(), all(r));
  const g = tiles(groupTrack(group())).Land, c = tiles(card("a")).Land;
  assert.ok(g && c, "both Land tiles drawn");
  assert.equal(c[0], "step waits rel", "the card's Land tile is the owner's install look");
  assert.equal(g[0], c[0], "the group's Land tile has the card's classes");
  assert.match(g[1], /pc123<span class="sl"> · [^<]+<\/span>/);
  assert.equal(g[1], c[1], "and the card's words");
});

test("the same wait at Pack and at Install: the group tile is the card's at each", () => {
  for (const [phase, label] of [["pack", "Pack"], ["install", "Install"]]) {
    const { group, card } = board(cards({ phase }), all({ phase, state: "waiting", wait: "install", with: null, pack: "pc124" }));
    const g = tiles(groupTrack(group()))[label], c = tiles(card("a"))[label];
    assert.equal(g[0], "step waits rel", `${label}: green`);
    assert.deepEqual(g, c, `${label}: the card's tile`);
  }
});

test("cards that differ keep the group from being green: an install wait and a pack wait, or one product card, give the plain wait", () => {
  const install = { phase: "ship", state: "waiting", wait: "install", with: null, pack: "pc124" }, pack = { phase: "ship", state: "waiting", wait: "pack", with: null };
  const mixed = board(cards().slice(0, 2), { a: install, b: pack }).group();
  assert.equal(tiles(groupTrack(mixed)).Land[0], "step waits proc");
  const product = board([raw("a", 1), raw("b", 2, { repo: "Platform" })], { a: install, b: { phase: "ship", state: "waiting", wait: "deploy", with: null } }).group();
  assert.doesNotMatch(groupTrack(product), /waits rel/);
});

// Every phase a board card draws (Build ... Live) and every kind of reading the Worker serves: with all three cards agreeing, no tile of the group differs in class from the card's.
const PHASES = ["build", "test", "language", "design", "checker", "security", "ship", "pack", "install", "live"];
const KINDS = {
  working: { state: "working", wait: null, with: "Builder", working: true },
  stuck: { state: "stuck", wait: null, with: "Builder" },
  unknown: { state: "unknown", wait: null, with: null },
  queued: { state: "queued", wait: null, with: null },
  rework: { state: "rework", wait: null, with: "Builder" },
  "wait turn": { state: "waiting", wait: "turn", with: "Checker" },
  "wait group": { state: "waiting", wait: "group", with: null },
  "wait land": { state: "waiting", wait: "land", with: null },
  "wait hold": { state: "waiting", wait: "hold", with: null },
  "wait ask": { state: "waiting", wait: "ask", with: null, ask: 7 },
  "wait pack": { state: "waiting", wait: "pack", with: null },
  "wait install": { state: "waiting", wait: "install", with: null, pack: "pc124" },
  "wait deploy": { state: "waiting", wait: "deploy", with: null },
};
test("over every phase and every reading: when all the cards agree, no tile of the group differs in class from the card's", () => {
  let n = 0, unlit = 0;
  for (const phase of PHASES) for (const [name, kind] of Object.entries(KINDS)) {
    const { group, card } = board(cards({ phase }), all({ phase, ...kind }));
    const g = tiles(groupTrack(group())), c = tiles(card("a"));
    for (const [label, [cls]] of Object.entries(g)) {
      if (!(label in c)) continue;
      // The one known difference, and not a colour: a card draws Pack and Install it has no evidence for as "unlit" (a title "no evidence yet"), and the group draws the plain
      // future tile there, whose title counts the cards ("1 of 2 cards future", #C1343/#C1383). It is held here so it cannot widen: only that pair, only at those two tiles.
      if (c[label][0] === "step unlit") { assert.deepEqual([label, cls], [label, "step"], `${phase} / ${name} / ${label}: unlit on the card is plain on the group`); assert.ok(label === "Pack" || label === "Install"); unlit++; continue; }
      assert.equal(cls, c[label][0], `${phase} / ${name} / ${label}: the group's class is the card's`);
      n++;
    }
  }
  assert.ok(n > 900, `compared ${n} tiles`);
  assert.ok(unlit > 0 && unlit < n / 4, `${unlit} unlit tiles held apart`);
  const done = board(cards({ phase: "live" }), all({ phase: "live", state: "done", wait: null, with: null })).group();
  assert.ok(Object.values(tiles(groupTrack(done))).every(([cls]) => /^step done$|^step skip$/.test(cls)), "done cards: every tile done");
});

test("the group has no class rule of its own: no GROUP_CLASS, and groupTile asks tileClass, the card row's function", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.equal(/GROUP_CLASS/.test(html), false, "the group's own class table is gone");
  const g = html.slice(html.indexOf("function groupTile("), html.indexOf("function groupRow("));
  assert.match(g, /tileClass\(t,/);
  assert.equal(/waits rel|waits proc|step now|step here/.test(g), false, "groupTile names no class of its own");
  const c = html.slice(html.indexOf("function cardTile("), html.indexOf("const stale=R.stale===true&&here"));
  assert.match(c, /let c=tileClass\(T,R,i\)/);
});
