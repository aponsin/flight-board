// #C1310 (Manager, after the owner could not find the product stack switch): the "Stack mode" bar (Board and Product, Turn on or off) was drawn only inside the retired v3
// layout's Crew view, which the store's page never opens (#C723 A4). It now sits on the page the store shows, between the "Initiatives in flight" heading and the open cards,
// and is drawn on every render of the board.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";
const TEMPLATE = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");

function page(host) {
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
  const document = { documentElement: { getAttribute: () => host }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(["stackBar", "stackRow", "renderStackBar"], { document, fetch: async () => ({ ok: true }) });
  Object.assign(b.state, { meta: [{ id: "stackSwitch", rows: [{ repo: "board", stack: true, setBy: "default", setAt: 0 }, { repo: "product", stack: false, setBy: "owner", setAt: Date.now() }] }] });
  return { b, els };
}

test("the store's board draws the stack bar into its own element: Board on, Product off, each with its button", () => {
  const { b, els } = page("store");
  b.renderStackBar();
  const html = els.stackbar.innerHTML;
  assert.match(html, /Stack mode/);
  assert.match(html, /Board: <b>on<\/b><button type="button" data-sw="board" data-on="0">Turn off<\/button>/);
  assert.match(html, /Product: <b>off<\/b><button type="button" data-sw="product" data-on="1">Turn on<\/button>/);
});

test("not on the store (the artifact page) the bar is empty, and with no switch rows there is none", () => {
  const { b, els } = page("artifact");
  b.renderStackBar();
  assert.equal(els.stackbar.innerHTML, "");
  const s = page("store");
  s.b.state.meta = [];
  s.b.renderStackBar();
  assert.equal(s.els.stackbar.innerHTML, "");
});

test("the element is on the page the store shows (v2), under the open-cards heading and above the cards, outside the hidden v3 layout", () => {
  const at = TEMPLATE.indexOf('<div id="stackbar"></div>');
  assert.ok(at > 0, "the element exists");
  assert.ok(at > TEMPLATE.indexOf('<div id="v2">'), "inside the v2 layout, the one the store shows (the v3 layout, with the Crew view, comes before it and stays hidden)");
  assert.ok(at > TEMPLATE.indexOf('id="h-init"'), "after the Initiatives in flight heading");
  assert.ok(at < TEMPLATE.indexOf('id="board" style="margin-top:10px"'), "before the open cards");
});

test("every render of the board redraws the bar, and a phone gets a 44 px button", () => {
  assert.match(TEMPLATE, /function renderBoard\(\)\{\s*renderCrew\(\);renderStackBar\(\);/);
  assert.match(TEMPLATE, /@media \(max-width:760px\)\{\.stkbar button\{min-width:44px;min-height:44px/);
});
