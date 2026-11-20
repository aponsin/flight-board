// #C1383 (Manager, on Designer's early look at #C1382): the "no fresh reading" mark is the reading's own, on the card row, its group row and (#C1384) its badge alike, so no view keeps the old path.
// A group row is greyed, with the time of the OLDEST last good read among its open stale members, when a member's reading is stale; a group of fresh readings has none, whatever the derived copy
// of a card says.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, readingDoc, setReadings } from "./harness.mjs";

const NOW = 1_800_000_000_000;
function board(readings, derived = []) {
  const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(["groupRow", "gates", "enrich", "state", "hhmm"], { document });
  const cards = ["a", "b"].map((id, n) => ({ id, num: n + 1, name: `Card ${id}`, size: "S", level: "Quick", status: "active", phase: "build", who: "Builder", repo: "flight-board", batch: "g1-thing", createdAt: NOW + n * 6e4 }));
  Object.assign(b.state, { initRaw: cards, initiatives: cards.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived, messages: [], threads: [] });
  setReadings(b, ...Object.entries(readings).map(([id, over]) => readingDoc(id, over)));
  return { b, html: b.groupRow("g1-thing", b.state.initiatives) };
}
const head = (html) => html.split('<div class="g-rail">')[0];

test("a group with a stale member is greyed and names the oldest last good read; a group of fresh readings has no mark", () => {
  const stale = board({ a: { stale: true, staleSince: NOW - 600e3 }, b: { stale: true, staleSince: NOW - 1800e3 } });
  assert.match(stale.html, /^<div class="i-row g-row read-stale" data-group="g1-thing">/);
  const h = stale.b.hhmm(NOW - 1800e3).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(head(stale.html), new RegExp(`<span class="stale-read"[^>]*>No fresh reading since ${h}</span>`), "the oldest of the members' last good reads");
  const one = board({ a: { stale: true }, b: {} });
  assert.match(one.html, /class="i-row g-row read-stale"/, "one stale member is enough");
  assert.match(head(one.html), /<span class="stale-read"[^>]*>No fresh reading<\/span>/, "never read fresh: no time");
  const fresh = board({ a: {}, b: {} });
  assert.match(fresh.html, /^<div class="i-row g-row" data-group="g1-thing">/);
  assert.doesNotMatch(head(fresh.html), /stale-read/);
});

test("the derived copy's old mark is not read: fresh readings, a derived row that says stale, no mark on the group", () => {
  const derived = [{ id: "all", at: NOW, cards: { a: { phase: "build", stale: true, staleSince: NOW - 3600e3 }, b: { phase: "build", stale: true } } }];
  const { html } = board({ a: {}, b: {} }, derived);
  assert.doesNotMatch(head(html), /stale-read|read-stale/);
});

test("a done member's stale mark is not the group's: only open members grey the row", () => {
  const dropped = board({ a: { stale: true, staleSince: NOW - 600e3 }, b: {} });
  dropped.b.state.initiatives.find((i) => i.id === "a").status = "done";
  const html = dropped.b.groupRow("g1-thing", dropped.b.state.initiatives);
  assert.doesNotMatch(html, /^<div class="i-row g-row read-stale"/);
});
