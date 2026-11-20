// #C1343 (the owner, t-1795185698538, a screenshot of a board group: "still not matching ?"): when every card of a board group has landed and its pack is cut,
// each card's Install tile is the owner's-install look (green stripes, "pc115 · <owner>"); the group row's Install tile was a plain "here" ring with no pack number.
// Now the group tile is the card's tile: the same classes and the same number. A mixed group, a group with no pack yet and a product group keep their own look.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, readingDoc, setReadings } from "./harness.mjs";

const NAMES = ["groupRow", "initRow", "gates", "enrich", "state"];
// #C1382: a card's tile is drawn from its reading (the Worker's), so each card here is given one: `readings` maps a card id to the reading's own fields.
function board(initRaw, readings) {
  const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(NAMES, { document });
  Object.assign(b.state, { initRaw, initiatives: initRaw.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [] });
  setReadings(b, ...Object.entries(readings).map(([id, over]) => readingDoc(id, over)));
  return { group: () => b.groupRow("g5-thing", b.state.initiatives), card: (id) => b.initRow(b.state.initiatives.find((i) => i.id === id)) };
}
const raw = (id, num, fields = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "ship", who: "Boardsmith", repo: "flight-board", batch: "g5-thing", branch: `build/${id}`, createdAt: 1_800_000_000_000 + num * 60e3, ...fields });
// The reading of a card that has landed and waits on the owner's install (pack "pc115" cut), and of one landed with no pack cut yet (waits for the pack).
const installWait = (pack = "pc115") => ({ phase: "install", state: "waiting", wait: "install", with: null, pack });
const packWait = { phase: "pack", state: "waiting", wait: "pack", with: null };
const tileOf = (html, label) => html.match(new RegExp(`<div class="(step[^"]*)" title="(${label}[^"]*)">(.*?)</div>`));
const groupTrack = (html) => html.split('<div class="g-rail">')[0];
const ids = ["a", "b"];
const both = (r) => Object.fromEntries(ids.map((id) => [id, r]));

test("every card waits on the owner's install: the group's Install tile has the card's classes and its pc number and owner word", () => {
  const { group, card } = board(ids.map((id, k) => raw(id, k + 1)), both(installWait()));
  const g = tileOf(groupTrack(group()), "Install"), c = tileOf(card("a"), "Install");
  assert.ok(g && c, "both tiles drawn");
  assert.equal(g[1], "step waits rel");
  assert.equal(g[1], c[1], "the same classes as the card's tile");
  assert.match(g[3], /<small class="rs">pc115<span class="sl"> · [^<]+<\/span><\/small>/);
  assert.equal(g[3], c[3], "the same inner words as the card's tile");
});

test("must still allow: the owner's word without a number when the packs are not the same number or none is read", () => {
  const diff = board(ids.map((id, k) => raw(id, k + 1)), { a: installWait("pc115"), b: installWait("pc116") }).group();
  assert.match(tileOf(groupTrack(diff), "Install")[1], /step waits rel/);
  assert.doesNotMatch(tileOf(groupTrack(diff), "Install")[3], /pc\d/);
  const none = board(ids.map((id, k) => raw(id, k + 1)), both(installWait(null))).group();
  assert.match(tileOf(groupTrack(none), "Install")[3], /<small class="rs">[^<]+<span class="sl">'s install<\/span><\/small>/);
});

test("must still refuse: a mixed group (one card not landed, or one not packed) keeps today's tile", () => {
  const unlanded = board(ids.map((id, k) => raw(id, k + 1)), { a: installWait(), b: { phase: "build", state: "working", wait: null, with: "Builder", working: true } }).group();
  assert.doesNotMatch(groupTrack(unlanded), /waits rel/);
  const unpacked = board(ids.map((id, k) => raw(id, k + 1)), { a: installWait(), b: packWait }).group();
  assert.doesNotMatch(groupTrack(unpacked), /waits rel/);
});

test("must still allow: landed with no pack yet keeps the Pack tile waiting and an unlit Install; once installed, the tile is done", () => {
  const html = board(ids.map((id, k) => raw(id, k + 1)), both(packWait)).group();
  assert.match(tileOf(groupTrack(html), "Pack")[1], /^step waits proc$/, "yellow Queued for pack, as the cards draw it");
  assert.match(tileOf(groupTrack(html), "Pack")[3], /Queued/);
  assert.match(tileOf(groupTrack(html), "Land")[1], /^step done$/, "Land stands done");
  assert.match(tileOf(groupTrack(html), "Install")[1], /^step$/, "#C1383: no card is at Install, so the group row's tile there is the plain future tile");
  const done = board(ids.map((id, k) => raw(id, k + 1)), both({ phase: "live", state: "done", wait: null, with: null, pack: "pc115" })).group();
  assert.doesNotMatch(groupTrack(done), /waits rel/);
  assert.match(tileOf(groupTrack(done), "Install")[1], /^step done$/, "installed: the tile is done");
});

test("must still refuse: a product group is never green", () => {
  // A product card's reading never waits on an install: it ships through Release (wait deploy).
  const shipWait = { phase: "ship", state: "waiting", wait: "deploy", with: null };
  const product = board(ids.map((id, k) => raw(id, k + 1, { repo: "Platform" })), both(shipWait)).group();
  assert.doesNotMatch(groupTrack(product), /waits rel/);
  const mixed = board([raw("a", 1), raw("b", 2, { repo: "Platform" })], { a: installWait(), b: shipWait }).group();
  assert.doesNotMatch(groupTrack(mixed), /waits rel/, "a group with one product card in it is not the owner's install wait");
  // #C1383: the group row no longer reads a card's status, only its reading (the Worker's), so the old "paused card keeps the plain tile" assertion is dropped.
});
