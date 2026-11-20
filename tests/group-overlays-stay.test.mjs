// #C1383 (Manager, on the restating of the group tests): Paused and Blocked stay overlays (the contract keeps them; they are typed, not read). The Worker's reading carries `overlay` for a paused or
// blocked open card and is never working then; the group's tile is the yellow wait whatever the reading under the overlay says (a session on a paused card does not pulse the group), and the
// group row says "Paused" or "Blocked" when that is what every card in the winning tile is.
import test from "node:test";
import assert from "node:assert/strict";
import { readingDocs, groupDocs } from "../worker/compat-reading.mjs";
import { groupReading, tileOf } from "../worker/reading.mjs";
import { loadNames, readingDoc, setReadings } from "./harness.mjs";

const NOW = 1_800_000_000_000;
const view = (cards, agents = {}) => ({ now: NOW, cards, history: [], asks: [], reviewClaims: [], evidence: { agents: { value: agents } } });
const card = (id, over = {}) => ({ id, num: 1, owner_role: "Builder", repo: "flight-board", batch: "g1", created_at: NOW - 1e6, ...over });

test("the Worker serves `overlay` for a paused or blocked open card, never working, and none for others or a closed card", () => {
  const docs = readingDocs(view([card("p", { paused: 1 }), card("b", { blocked_reason: "waiting on a part" }), card("n"), card("d", { paused: 1, done_at: NOW - 1000 })], { Builder: { state: "working", card: "p" } }));
  const by = Object.fromEntries(docs.map((d) => [d.id, d]));
  assert.equal(by.p.overlay, "paused");
  assert.equal(by.p.working, false, "a session on a paused card is not working it");
  assert.equal(by.b.overlay, "blocked");
  assert.equal("overlay" in by.n, false);
  assert.equal("overlay" in by.d, false, "a closed card has no overlay");
});

test("an overlay folds as the yellow wait, under working but above quiet states, and the group's tile follows", () => {
  const paused = { id: "p", phase: "build", state: "working", wait: null, working: true, overlay: "paused" };
  assert.equal(tileOf(paused), "wait");
  const other = { id: "o", phase: "build", state: "waiting", wait: "turn", working: false };
  const g = groupReading([paused, other]);
  assert.equal(g.tiles.build, "wait");
  const working = { id: "w", phase: "build", state: "working", wait: null, working: true };
  assert.equal(groupReading([paused, working]).tiles.build, "working", "a card truly worked still wins the group");
  assert.equal(groupDocs(readingDocs(view([card("p", { paused: 1 }), card("q")])))[0].tiles.build, "wait");
});

test("the group row draws a paused card as the ring with its word, and a session on it does not pulse the group", () => {
  const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(["groupRow", "gates", "enrich", "state"], { document });
  const cards = ["a", "b"].map((id, n) => ({ id, num: n + 1, name: `Card ${id}`, size: "S", level: "Quick", status: n ? "active" : "paused", phase: "build", who: "Builder", repo: "flight-board", batch: "g1", createdAt: NOW + n * 6e4 }));
  Object.assign(b.state, { initRaw: cards, initiatives: cards.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [] });
  const rows = (docs) => { setReadings(b, ...docs); const h = b.groupRow("g1", b.state.initiatives).split('<div class="g-rail">')[0]; return h.match(/<div class="(step[^"]*)" title="Build[^"]*">Build(<small[^>]*>.*?<\/small>)?/); };
  // Only the paused card: it has a session on it in its reading, and the overlay keeps the group still.
  const solo = rows([readingDoc("a", { state: "working", wait: null, working: true, overlay: "paused" }), readingDoc("b", { state: "queued", wait: null })]);
  assert.equal(solo[1], "step waits");
  assert.match(solo[2], /Paused/);
  const bothPaused = rows([readingDoc("a", { overlay: "paused" }), readingDoc("b", { overlay: "paused" })]);
  assert.equal(bothPaused[1], "step waits");
  assert.match(bothPaused[2], /Paused/);
  const blocked = rows([readingDoc("a", { overlay: "blocked" }), readingDoc("b", { overlay: "blocked" })]);
  assert.match(blocked[2], /Blocked/);
  const mixed = rows([readingDoc("a", { overlay: "paused" }), readingDoc("b", { state: "waiting", wait: "turn" })]);
  assert.equal(mixed[1], "step waits proc", "cards in the winning tile do not all say Paused: the plain yellow wait");
});
