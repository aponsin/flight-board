// #C1343 (the owner, t-1795185698538: the group row's tiles kept disagreeing with the cards' tiles, and he did not want to point out cases one at a time): each phase tile of a group
// row is made FROM its member cards. When every card is in the same tile the group draws it; when they differ the group draws the first tile in TILE_ORDER that any card is in.
// #C1383 restated it over READINGS: the group row draws the Worker's `groups` row, groupReading(members' readings) of worker/reading.mjs, and the page never reads the classes of
// drawn card tiles. This is the table of states (one reading per state), then every pair, asserted on what the group row DRAWS (its classes and its title "n of m cards <tile>").
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, readingDoc, setReadings } from "./harness.mjs";
import { groupReading, TILE_ORDER, STRIP } from "../worker/reading.mjs";

const NAMES = ["groupRow", "initRow", "gates", "enrich", "state"];
const raw = (id, num, f = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", who: "Boardsmith", repo: "flight-board", batch: "g5-thing", branch: `build/${id}`, createdAt: 1_800_000_000_000 + num * 60e3, ...f });

// The oracle is written out here, not read from the code under test: the order the rule of #C1343 says, and the look of each tile (the contract's "Tile looks").
const ORDER = ["stuck", "working", "unknown", "ask", "wait", "queued", "future", "afterwork", "done"];
const LOOK = { done: "step done", working: "step now", stuck: "step now stuck", unknown: "step here", ask: "step waits ask", wait: "step waits proc", queued: "step now queued", future: "step", afterwork: "step waits proc" };
// afterwork is green ("the owner's install") on the Install phase of a board card only.
const lookOf = (tile, phase, product) => (tile === "afterwork" && phase === "install" && !product ? "step waits rel" : LOOK[tile]);

// One reading per state, put at `phase`. future: the card is one phase before it; done: it is one phase past it (or finished).
// afterwork is a card that has done all it can and waits on a pack, an install or a deploy; wait is a turn, a group, the landing queue or a hold.
const STATES = {
  stuck: { state: "stuck" },
  working: { state: "working", working: true, with: "Boardsmith" },
  unknown: { state: "unknown", wait: null, with: null },
  ask: { state: "waiting", wait: "ask" },
  "wait (turn)": { state: "waiting", wait: "turn", tile: "wait" },
  "wait (group)": { state: "waiting", wait: "group", tile: "wait" },
  "wait (land)": { state: "waiting", wait: "land", tile: "wait" },
  "wait (hold)": { state: "waiting", wait: "hold", tile: "wait" },
  queued: { state: "queued", wait: null },
  "afterwork (pack)": { state: "waiting", wait: "pack", tile: "afterwork" },
  "afterwork (install)": { state: "waiting", wait: "install", tile: "afterwork" },
  "afterwork (deploy)": { state: "waiting", wait: "deploy", tile: "afterwork" },
};
const tileOfName = (n) => STATES[n]?.tile ?? n;
// #C1404: the words a group tile's hover counts its cards in (the oracle is written out here, not read from the page): never the tile's internal name. An afterwork tile says which wait when every card in it waits for the same.
const PLAIN = { done: "done", working: "working", stuck: "stuck", unknown: "not read yet", ask: "waiting on you", wait: "waiting", queued: "queued", future: "not started yet", afterwork: "waiting for pack or install" };
const PLAIN_WAIT = { pack: "waiting for pack", install: "waiting for install", deploy: "waiting for deploy" };
const plain = (tile, names) => {
  if (tile !== "afterwork") return PLAIN[tile];
  const waits = [...new Set(names.filter((n) => tileOfName(n) === "afterwork").map((n) => STATES[n].wait))];
  return waits.length === 1 ? PLAIN_WAIT[waits[0]] : PLAIN.afterwork;
};
// A reading of a card that sits in the given state at `phase`.
const at = (name, phase, extra = {}) => {
  const k = STRIP.indexOf(phase);
  if (name === "future") return { phase: STRIP[k - 1], state: "working", wait: null, working: true, with: "Boardsmith", ...extra };
  if (name === "done") return { phase: STRIP[k + 1], state: "working", wait: null, working: true, with: "Boardsmith", ...extra };
  const { tile, ...r } = STATES[name];
  return { phase, wait: null, with: null, working: false, ...r, ...extra };
};
const prod = (r) => ({ f: { phase: "ship", repo: "Platform" }, r });

function draw(specs) { // specs: [{ f, r }, ...] -> {html, group(label)}
  const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(NAMES, { document });
  const cards = specs.map((s, k) => raw(`c${k}`, k + 1, s.f));
  Object.assign(b.state, { initRaw: cards, initiatives: cards.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [] });
  const docs = specs.map((s, k) => readingDoc(`c${k}`, s.r));
  setReadings(b, ...docs);
  const tile = (html, label) => { const m = html.match(new RegExp(`<div class="(step[^"]*)" title="(${label}[^"]*)">(.*?)</div>`)); return m && { cls: m[1].replace(/ (norec|together)\b/g, ""), title: m[2], inner: m[3] }; };
  const g = b.groupRow("g5-thing", b.state.initiatives).split('<div class="g-rail">')[0];
  return { html: g, docs, group: (label) => tile(g, label) };
}
const pairs = (names) => names.flatMap((a, i) => names.slice(i).map((c) => [a, c]));

// The rows: the tile label on the group's strip, the phase it draws, and the cards (product: a product card's track, whose Ship tile is the release).
const ROWS = [
  { label: "Build", phase: "build", names: ["stuck", "working", "unknown", "ask", "wait (turn)", "wait (group)", "wait (land)", "wait (hold)", "queued", "afterwork (pack)", "afterwork (deploy)", "done"], card: (r) => ({ r }) },
  { label: "Land", phase: "ship", names: ["stuck", "working", "unknown", "ask", "wait (turn)", "wait (land)", "queued", "future", "afterwork (pack)", "done"], card: (r) => ({ r }) },
  { label: "Pack", phase: "pack", names: ["stuck", "working", "ask", "wait (turn)", "queued", "future", "afterwork (pack)", "done"], card: (r) => ({ r }) },
  { label: "Install", phase: "install", names: ["stuck", "working", "unknown", "wait (turn)", "queued", "future", "afterwork (install)", "done"], card: (r) => ({ r }) },
  { label: "Ship", phase: "ship", product: true, names: ["stuck", "working", "wait (hold)", "queued", "future", "afterwork (deploy)", "done"], card: (r) => prod(r) },
];

test("the oracle is the rule's order: the page's module says the same TILE_ORDER, and the states below cover every tile", () => {
  assert.deepEqual(TILE_ORDER, ORDER);
  assert.deepEqual([...new Set(Object.keys(STATES).map(tileOfName).concat("future", "done"))].sort(), [...ORDER].sort());
});

for (const row of ROWS) {
  const title = `${row.label} tile`;
  const drawn = (names, extra) => draw(names.map((n) => row.card(at(n, row.phase, extra))));
  const look = (tile) => lookOf(tile, row.phase, row.product);

  test(`${title}: a group of cards that are all in one state draws that state's look, and it is groupReading's tile`, () => {
    for (const name of row.names) {
      const d = drawn([name, name]), g = d.group(row.label), tile = tileOfName(name);
      assert.ok(g, `${name}: drawn`);
      assert.equal(g.cls, look(tile), `${name}: the group draws the look of ${tile}`);
      assert.equal(groupReading(d.docs).tiles[row.phase], tile, `${name}: groupReading says ${tile}`);
      assert.equal(g.title, row.label, `${name}: the cards agree, so the title names no count`);
    }
  });

  test(`${title}: every pair of states draws the tile that comes first in the written order, and says how many cards are in it`, () => {
    for (const [a, b] of pairs(row.names)) {
      const [ta, tb] = [tileOfName(a), tileOfName(b)], winner = ORDER.indexOf(ta) <= ORDER.indexOf(tb) ? ta : tb;
      for (const names of [[a, b], [b, a]]) {
        const d = drawn(names), g = d.group(row.label);
        assert.equal(g.cls, look(winner), `${a} with ${b} (either order): the group draws ${winner}`);
        assert.equal(groupReading(d.docs).tiles[row.phase], winner, `${a} with ${b}: it is groupReading's tile`);
        if (ta === tb) assert.equal(g.title, row.label, `${a} with ${b}: the same tile, no count`);
        else assert.equal(g.title, `${row.label}: 1 of 2 cards ${plain(winner, names)}`, `${a} with ${b}: the title counts the cards in ${winner}, in plain words (#C1404)`);
      }
    }
  });
}

test("three cards: the title counts every card in the winning tile, and the others do not change the draw", () => {
  const w = at("working", "build"), q = at("queued", "build");
  const d = draw([{ r: w }, { r: w }, { r: q }]).group("Build");
  assert.equal(d.title, "Build: 2 of 3 cards working");
  assert.equal(d.cls, "step now");
});

test("a group whose every card is queued at Ship draws the yellow queued tile, as the G96 screenshot's cards did", () => {
  const d = draw([prod(at("queued", "ship")), prod(at("queued", "ship"))]);
  assert.equal(d.group("Ship").cls, "step now queued");
  assert.match(d.group("Ship").inner, /queued/);
});

test("the states differ from one another, so the table is not comparing one tile with itself", () => {
  for (const row of ROWS) {
    const names = row.names.filter((n) => !n.startsWith("wait (") || n === "wait (turn)").filter((n) => !n.startsWith("afterwork") || row.names.filter((m) => m.startsWith("afterwork"))[0] === n);
    const cls = names.map((n) => draw([row.card(at(n, row.phase)), row.card(at(n, row.phase))]).group(row.label).cls);
    // wait and afterwork look alike (the grey "waits proc") by the contract; every other tile has its own look.
    const distinct = new Set(cls.map((c) => c)).size;
    assert.ok(distinct >= names.length - 1, `${row.label}: ${cls.join(" | ")}`);
  }
});

test("the words: a pack number shows only when the cards in the winning tile agree on it, and Queued for pack shows as the cards say it", () => {
  const rel = (pack) => ({ r: at("afterwork (install)", "install", { pack }) });
  assert.match(draw([rel("pc115"), rel("pc115")]).group("Install").inner, /pc115/);
  const mixed = draw([rel("pc115"), rel("pc116")]).group("Install").inner;
  assert.doesNotMatch(mixed, /pc11\d/);
  assert.match(mixed, /'s install/);
  const land = { r: at("wait (land)", "ship") };
  assert.match(draw([land, land]).group("Land").inner, /Queued/);
  const pk = { r: at("afterwork (pack)", "pack") };
  assert.match(draw([pk, pk]).group("Pack").inner, /Queued<span class="sl"> for pack/, "Queued for pack on the Pack tile");
});

test("must still allow: a product group is never green, and one product card among board cards keeps the group from the owner's-install look", () => {
  const rel = prod(at("afterwork (deploy)", "ship")); // a product card ships through Release: its reading never waits on an install
  const d = draw([rel, rel]);
  assert.equal(d.group("Install"), null, "a product track has no Install tile");
  assert.doesNotMatch(d.html, /waits rel/);
  const board = { r: at("afterwork (install)", "install", { pack: "pc115" }) };
  const mixed = draw([board, rel]);
  assert.doesNotMatch(mixed.html, /waits rel/, "the product card's reading is at Ship, so the group's Install tile is not the owner's install");
});
