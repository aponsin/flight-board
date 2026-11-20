// #C1343 (the owner, t-1795185698538: the group row's tiles kept disagreeing with the cards' tiles, and he did not want to point out cases one at a time): each phase tile of a group
// row is made FROM its member cards' tiles, drawn by the card row's own function (cardTile). When every card draws the same tile the group draws it; when they differ the group
// draws the first state in TILE_ORDER (the page's one written rule) that any card is in. This is the table of states: one card in each state, then every pair.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames, readingDoc, setReadings } from "./harness.mjs";

const NAMES = ["groupRow", "initRow", "gates", "enrich", "state"];
const raw = (id, num, f = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", who: "Boardsmith", repo: "flight-board", batch: "g5-thing", branch: `build/${id}`, createdAt: 1_800_000_000_000 + num * 60e3, ...f });
// #C1382: a card's tile is drawn from its reading (the Worker's), so each state below is a reading: { phase, state, wait, with, working, pack } (the card's raw fields in `f`).
// state -> the card fixture and the tile it is read at. `r` absent: the card has no reading (it draws the plain ring).
const rd = (phase, state, wait = null, more = {}) => ({ r: { phase, state, wait, with: state === "working" ? "Boardsmith" : null, working: state === "working", ...more } });
const BUILD = {
  stuck: rd("build", "stuck"),
  active: rd("build", "working"),
  waits: rd("build", "waiting", "turn"),
  here: rd("build", "unknown"),
  queued: rd("build", "queued"),
  done: rd("checker", "working"),
};
// The same states, most urgent first: the order the page's TILE_ORDER says for the Build tile (the oracle here is written out, not read from the page).
// ("up next" is no tile a card row draws any more: the reading has no up-next state.)
const BUILD_ORDER = ["stuck", "active", "waits", "here", "queued", "done"];
const LAND = {
  working: rd("ship", "working"),
  "queued to land": rd("ship", "waiting", "land"),
  "not reached": rd("build", "working"),
  done: rd("pack", "waiting", "pack"),
};
const LAND_ORDER = ["working", "queued to land", "not reached", "done"];
const INSTALL = {
  unlit: rd("ship", "waiting", "land"),
  "owner's install": rd("install", "waiting", "install", { pack: "pc115" }),
  installed: rd("live", "done"),
};
const INSTALL_ORDER = ["unlit", "owner's install", "installed"];
// The Ship tile (the owner, t-1795186517593, G96: every card's Ship tile showed queued in yellow stripes and the group's did not): a card queued, held, waiting for the ship, and shipping.
const prod = (x) => ({ f: { phase: "ship", repo: "Platform" }, ...x });
const SHIP = {
  shipping: prod(rd("ship", "working")),
  held: prod(rd("ship", "waiting", "hold")),
  "queued for the ship": prod(rd("ship", "waiting", "deploy")),
  queued: prod(rd("ship", "queued")),
};
const SHIP_ORDER = ["shipping", "held", "queued for the ship", "queued"];

function draw(specs) { // specs: [fixture, ...] -> {group(label), card(k, label)}
  const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(NAMES, { document });
  const cards = specs.map((s, k) => raw(`c${k}`, k + 1, s.f));
  Object.assign(b.state, { initRaw: cards, initiatives: cards.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [] });
  setReadings(b, ...specs.flatMap((s, k) => (s.r ? [readingDoc(`c${k}`, s.r)] : [])));
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
  assert.equal(new Set(LAND_ORDER.map((n) => draw([LAND[n], LAND[n]]).card(0, "Land").cls)).size, LAND_ORDER.length);
  assert.equal(new Set(INSTALL_ORDER.map((n) => draw([INSTALL[n], INSTALL[n]]).card(0, "Install").cls)).size, 3);
});

test("the words: a pack number shows only when the cards in the winning state agree on it, and Queued for pack shows as the cards say it", () => {
  const rel = (pack) => rd("install", "waiting", "install", { pack });
  assert.match(draw([rel("pc115"), rel("pc115")]).group("Install").inner, /pc115/);
  const mixed = draw([rel("pc115"), rel("pc116")]).group("Install").inner;
  assert.doesNotMatch(mixed, /pc11\d/);
  assert.match(mixed, /'s install/);
  assert.match(draw([LAND["queued to land"], LAND["queued to land"]]).group("Land").inner, /Queued/);
  const pk = rd("pack", "waiting", "pack");
  assert.match(draw([pk, pk]).group("Pack").inner, /Queued<span class="sl"> for pack/, "Queued for pack on the Pack tile");
});

test("must still allow: a product group is never green, and one product card among board cards keeps the group from the owner's-install look", () => {
  const rel = prod(rd("ship", "waiting", "deploy")); // a product card ships through Release: its reading never waits on an install
  const d = draw([rel, rel]);
  assert.equal(d.group("Install"), null, "a product track has no Install tile");
  assert.doesNotMatch(d.html, /waits rel/);
  const board = rd("install", "waiting", "install", { pack: "pc115" });
  const mixed = draw([board, rel]);
  assert.doesNotMatch(mixed.html, /waits rel/, "the product card's tile is never the owner's install, so the group is not green");
});

test("the rule is written once, in the page, and the page names every state the table covers", () => {
  const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  for (const word of ["stuck", "active", "checking", "waits", "up next", "here", "queued", "not reached", "waiting on pack or install", "done seen", "done", "skip"]) assert.ok(page.includes(`["${word}",`), `TILE_ORDER names ${word}`);
  assert.equal((page.match(/const TILE_ORDER=/g) || []).length, 1);
});
