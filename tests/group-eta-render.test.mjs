// #C1099, Checker 2's F2 MEDIUM on b7263bff: the page's renderBoard must hand each group row the adjusted live time (groupEtas over EVERY open card, so a search does
// not move it), not the group's own time. The unit tests call groupEtas directly; these draw the board and read the time the row carries (data-eta).
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const NAMES = ["groupEtas", "groupLabel", "groupShort", "groupOrderRows", "groupRankOf", "groupCmp", "groupMoveButtons", "groupList", "groupFacts", "groupRow", "pulledTag", "pillClass", "renderBoard", "setInitSearch", "initHit", "initRow", "gates", "enrich", "PHASES", "MIN_LEFT"];
const MIN = 60e3, NOW = 1_800_000_000_000;
function board(initRaw, order) {
  const els = {}, el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", value: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }) });
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(NAMES, { document, documentElement: document.documentElement, fetch: async () => ({ ok: true }), setTimeout: () => 0 });
  Object.assign(b.state, { initRaw, initiatives: initRaw.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [], meta: [{ id: "groupOrder", rows: order.map((batch, k) => ({ batch, pos: k + 1 })) }] });
  return { ...b, els };
}
// A card whose time is the declared one (etaLive), so each group's own time is exactly what the test says.
const card = (id, num, batch, etaLive, fields = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "checker", who: "Boardsmith", batch, etaLive, createdAt: NOW + num * MIN, ...fields });
const rowEta = (html, group) => {
  const at = html.indexOf(`data-group="${group}"`);
  assert.ok(at >= 0, `${group} is drawn`);
  const m = /data-eta="(\d+)"/.exec(html.slice(at));
  return m ? Number(m[1]) : null;
};
const raw = () => [card("a", 1, "g10-small-rules", NOW + 112 * MIN), card("b", 2, "g6-probe", NOW + 54 * MIN)];
const ORDER = ["g10-small-rules", "g6-probe"];

test("the drawn row of a lower group of the same agent carries the time after the higher group's, not its own", () => {
  const b = board(raw(), ORDER);
  b.renderBoard();
  const html = b.els.board.innerHTML;
  assert.equal(rowEta(html, "g10-small-rules"), NOW + 112 * MIN, "the higher group keeps its own time");
  assert.equal(rowEta(html, "g6-probe"), NOW + 112 * MIN + b.MIN_LEFT, "the lower one is drawn with at least the higher's time + MIN_LEFT, not NOW + 54 min");
});

test("a search that hides the higher group does not move the lower group's time", () => {
  const b = board(raw(), ORDER);
  b.setInitSearch("Card 2");
  b.renderBoard();
  const html = b.els.board.innerHTML;
  assert.doesNotMatch(html, /data-group="g10-small-rules"/, "the higher group is out of the search");
  assert.equal(rowEta(html, "g6-probe"), NOW + 112 * MIN + b.MIN_LEFT, "its time is still worked out from every open card");
});
