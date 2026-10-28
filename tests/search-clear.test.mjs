// A one-click clear in the cards' search box (Designer on 7ce1632), and in Shipped and reported's (#C362), to match the
// Threads row's "· Clear": a × inside the box on the right while it has text, with a 28 px tap area; clicking it empties
// the box, redraws at once and keeps the focus there. On a phone (below 600 px) the cards' box drops under the heading,
// full width.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const X = (id) => `<button type="button" class="sclear" data-sclear="${id}" aria-label="Clear the search" title="Clear the search" hidden>×</button>`;

test("a × in the cards' box and the feed's, after the input, hidden until there's text", () => {
  assert.ok(page.includes(`autocomplete="off">${X("isearch")}</div>`), "the cards' box");
  assert.ok(page.includes(`autocomplete="off">${X("fsearch")}</div>`), "the feed's box");
  assert.match(page, /<div class="sbox clr"><svg class="sicon"[^>]*>[\s\S]*?<\/svg><input type="search" id="isearch"/);
  assert.match(page, /\.sbox \.sclear\{[^}]*position:absolute;right:2px;[^}]*width:28px;height:28px/);
  assert.match(page, /\.sbox\.clr input\{padding-right:30px\}/, "text never runs under the ×");
  assert.match(page, /\.sbox\.clr input::-webkit-search-cancel-button\{-webkit-appearance:none;appearance:none\}/, "one clear, not two");
});

function wired() {
  const b = loadNames(["setInitSearch", "setFeedSearch", "showClear"]);
  Object.assign(b.state, { initRaw: [], steps: [], waiting: [], derived: [], messages: [], threads: [], initiatives: [], events: [] });
  const btn = { dataset: { sclear: "isearch" }, hidden: true };
  b.document.querySelector = (s) => (s === '[data-sclear="isearch"]' ? btn : null);
  return { b, btn };
}

test("the × shows as he types, and one click clears, redraws and keeps the focus", () => {
  const { b, btn } = wired();
  const box = b.document.getElementById("isearch");
  let focused = 0;
  box.focus = () => focused++;
  box.value = "pot";
  for (const fn of b.listeners.input) fn({ target: box });
  assert.equal(btn.hidden, false, "shown on the key, not after the 150 ms wait");
  b.setInitSearch("pot");
  for (const fn of b.listeners.click) fn({ target: { closest: (s) => (s === "[data-sclear]" ? btn : null) } });
  assert.equal(box.value, "");
  assert.equal(btn.hidden, true);
  assert.equal(focused, 1);
  assert.equal(b.els.initcount.hidden, true, "redrawn at once: no N of M");
});

test("Security's nit on 0aac0d2: an id like 'constructor' is no box of SCLEAR's", () => {
  const { b } = wired();
  const odd = { id: "constructor", value: "x" };
  for (const fn of b.listeners.input) fn({ target: odd });
  assert.match(page, /if\(e\.target&&Object\.hasOwn\(SCLEAR,e\.target\.id\)\)showClear\(e\.target\.id\)/);
  assert.match(page, /const id=x\.dataset\.sclear;if\(!Object\.hasOwn\(SCLEAR,id\)\)return;/);
});

test("on a phone the cards' box drops under the heading, full width", () => {
  assert.match(page, /\.init-head \.sbox\{flex:1 1 16rem\}\n@media \(max-width:600px\)\{\.init-head \.sbox\{flex:1 1 100%\}\}/);
});

test("#C365, the owner in #T975: on a laptop the cards' box fills the whole width right of the heading", () => {
  assert.doesNotMatch(page, /\.init-head \.sbox\{[^}]*28rem/, "no cap");
  assert.match(page, /\.init-head h2\{margin:0;flex:none\}/, "the heading keeps its width; the box takes the rest");
});
