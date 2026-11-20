// #C1343 (the owner, t-1795185698538: the group row's tiles kept disagreeing with the cards' tiles, and he did not want to point out cases one at a time): each phase tile of a group
// row is made FROM its member cards' tiles, drawn by the card row's own function (cardTile). When every card draws the same tile the group draws it; when they differ the group
// draws the first state in TILE_ORDER (the page's one written rule) that any card is in. This is the table of states: one card in each state, then every pair.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const NOW = Date.now();
const NAMES = ["groupRow", "initRow", "gates", "enrich", "probeEvent", "state"];
const raw = (id, num, f = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", who: "Boardsmith", repo: "flight-board", batch: "g5-thing", branch: `build/${id}`, createdAt: 1_800_000_000_000 + num * 60e3, ...f });
const work = (id) => ({ state: "working", card: id, lastActivityAt: NOW, since: NOW - 60e3 });
const idle = { state: "idle", lastActivityAt: NOW - 600e3, since: NOW - 600e3 };
const landed = (more = {}) => ({ phase: "ship", headSha12: "4079cdbd8c9e", onMain: true, seen: ["build", "checker", "ship"], ...more });
// state -> the card fixture (raw fields, the probe's reading of it, whether an agent is on it) and the tile it is read at
const BUILD = {
  stuck: { f: { status: "stuck" } },
  active: { on: true },
  waits: { f: { status: "paused" } },
  "up next": { f: { upNext: true } },
  here: {},
  queued: { f: { branch: undefined }, read: null },
  done: { f: { phase: "checker" }, read: { phase: "checker", seen: ["build", "checker"] } },
};
// The same states, most urgent first: the order the page's TILE_ORDER says for the Build tile (the oracle here is written out, not read from the page).
const BUILD_ORDER = ["stuck", "active", "waits", "up next", "here", "queued", "done"];
const LAND = {
  here: { f: { phase: "ship" }, read: { phase: "ship", headSha12: "522a8532aaaa", onMain: false, seen: ["ship"] } },
  "queued for pack": { f: { phase: "ship" }, read: landed() },
  done: { f: { phase: "ship" }, read: landed({ packed: true, pack: 115 }) },
};
const LAND_ORDER = ["here", "queued for pack", "done"];
const INSTALL = {
  unlit: { f: { phase: "ship" }, read: landed() },
  "owner's install": { f: { phase: "ship" }, read: landed({ packed: true, pack: 115 }) },
  installed: { f: { phase: "ship" }, read: landed({ packed: true, installed: true, pack: 115 }) },
};
const INSTALL_ORDER = ["unlit", "owner's install", "installed"];
// The Ship tile (the owner, t-1795186517593, G96: every card's Ship tile showed queued in yellow stripes and the group's did not): a card queued, held by a wait, with its tests running
// (shipped, not yet on main) and shipping (on main, main's CI run going).
const SHIP = {
  shipping: { f: { phase: "ship", repo: "Platform" }, read: { phase: "ship", headSha12: "4079cdbd8c9e", onMain: true, ci: "running", seen: ["build", "checker", "ship"] } },
  held: { f: { phase: "ship", repo: "Platform", waitingOn: "Manager" }, read: { phase: "ship", headSha12: "522a8532aaaa", onMain: false, seen: ["ship"] } },
  "tests running": { f: { phase: "ship", repo: "Platform", shipAt: NOW - 2 * 60e3 }, read: { phase: "ship", headSha12: "522a8532bbbb", onMain: false, seen: ["ship"] } },
  queued: { f: { phase: "ship", repo: "Platform", status: "queued" }, read: null },
};
const SHIP_ORDER = ["shipping", "held", "tests running", "queued"];

function draw(specs) { // specs: [fixture, ...] -> {group(label), card(k, label)}
  const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(NAMES, { document });
  const cards = specs.map((s, k) => raw(`c${k}`, k + 1, s.f)), reads = {};
  cards.forEach((c, k) => { if (specs[k].read !== null) reads[c.id] = { phase: "build", headSha12: `a1b2c3d4e5f${k}`, onMain: false, seen: ["build"], ...(specs[k].read || {}) }; });
  const onIdx = specs.findIndex((s) => s.on), agents = { Boardsmith: onIdx >= 0 ? work(`c${onIdx}`) : idle, Release: idle };
  Object.assign(b.state, { initRaw: cards, initiatives: cards.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [] });
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: NOW - 20e3 }, cards: reads, agents } } }, {});
  const tile = (html, label) => { const m = html.match(new RegExp(`<div class="(step[^"]*)" title="${label}[^"]*">(.*?)</div>`)); return m && { cls: m[1].replace(/ (norec|together)\b/g, ""), inner: m[2] }; };
  const g = b.groupRow("g5-thing", b.state.initiatives).split('<div class="g-rail">')[0];
  return { html: g, group: (label) => tile(g, label), card: (k, label) => tile(b.initRow(b.state.initiatives[k]), label) };
}
const pairs = (names) => names.flatMap((a, i) => names.slice(i).map((c) => [a, c]));

function table(title, label, states, order) {
  test(`${title}: a group of cards that all draw one state draws exactly the card's tile`, () => {
    for (const name of order) {
      const d = draw([states[name], states[name]]), g = d.group(label), c = d.card(0, label);
      assert.ok(g && c, `${name}: both drawn`);
      assert.equal(g.cls, c.cls, `${name}: the group's classes are the card's`);
      assert.equal(g.inner.replace(/<small[^>]*>.*<\/small>/, ""), c.inner.replace(/<small[^>]*>.*<\/small>/, ""), `${name}: the same label`);
    }
  });
  test(`${title}: every pair of states draws the state that comes first in the written order`, () => {
    for (const [a, b] of pairs(order)) {
      const winner = order.indexOf(a) <= order.indexOf(b) ? a : b;
      for (const specs of [[states[a], states[b]], [states[b], states[a]]]) {
        const d = draw(specs), want = draw([states[winner], states[winner]]).card(0, label);
        assert.equal(d.group(label).cls, want.cls, `${a} with ${b} (either order): the group draws ${winner}`);
      }
    }
  });
}

table("Build tile", "Build", BUILD, BUILD_ORDER);
table("Land tile", "Land", LAND, LAND_ORDER);
table("Install tile", "Install", INSTALL, INSTALL_ORDER);
table("Ship tile", "Ship", SHIP, SHIP_ORDER);
test("a group whose every card is queued at Ship draws the cards' yellow queued tile, as the G96 screenshot's cards did", () => {
  const d = draw([SHIP.queued, SHIP.queued]);
  assert.match(d.card(0, "Ship").cls, /\bnow queued\b/);
  assert.equal(d.group("Ship").cls, d.card(0, "Ship").cls);
  assert.match(d.group("Ship").inner, /queued/);
});

test("the states differ from one another, so the table is not comparing one tile with itself", () => {
  const cls = BUILD_ORDER.map((n) => draw([BUILD[n], BUILD[n]]).card(0, "Build").cls);
  assert.equal(new Set(cls).size, cls.length - 0, `each Build state has its own classes: ${cls.join(" | ")}`);
  assert.equal(new Set(["here", "queued for pack", "done"].map((n) => draw([LAND[n], LAND[n]]).card(0, "Land").cls)).size, 3);
  assert.equal(new Set(INSTALL_ORDER.map((n) => draw([INSTALL[n], INSTALL[n]]).card(0, "Install").cls)).size, 3);
});

test("the words: a pack number shows only when the cards in the winning state agree on it, and Queued for pack shows as the cards say it", () => {
  const rel = (pack) => ({ f: { phase: "ship" }, read: landed({ packed: true, pack }) });
  assert.match(draw([rel(115), rel(115)]).group("Install").inner, /pc115/);
  const mixed = draw([rel(115), rel(116)]).group("Install").inner;
  assert.doesNotMatch(mixed, /pc11\d/);
  assert.match(mixed, /'s install/);
  assert.match(draw([LAND["queued for pack"], LAND["queued for pack"]]).group("Land").inner, /Queued/);
});

test("must still allow: a product group is never green, and one product card among board cards keeps the group from the owner's-install look", () => {
  const rel = { f: { phase: "ship", repo: "Platform" }, read: landed({ packed: true, pack: 115 }) };
  const d = draw([rel, rel]);
  assert.equal(d.group("Install"), null, "a product track has no Install tile");
  assert.doesNotMatch(d.html, /waits rel/);
  const board = { f: { phase: "ship" }, read: landed({ packed: true, pack: 115 }) };
  const mixed = draw([board, rel]);
  assert.doesNotMatch(mixed.html, /waits rel/, "the product card's tile is never the owner's install, so the group is not green");
});

test("the rule is written once, in the page, and the page names every state the table covers", () => {
  const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  for (const word of ["stuck", "active", "checking", "waits", "up next", "here", "queued", "not reached", "waiting on pack or install", "done seen", "done", "skip"]) assert.ok(page.includes(`["${word}",`), `TILE_ORDER names ${word}`);
  assert.equal((page.match(/const TILE_ORDER=/g) || []).length, 1);
});
