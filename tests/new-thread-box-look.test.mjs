// The new-thread box stands out from search (#C385, the owner in t-1793165968424, the owner's pick A with Designer's label):
// both were the same grey field. The new-thread box is now a white field with an accent outline under a visible
// "Start a thread" label, and keeps the compose boxes' focus ring; search is an unfilled box. Reply boxes in threads
// are unchanged, so the top box is the one that stands out.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const css = page.match(/<style>([\s\S]*?)<\/style>/)[1];

test("the label shows, above the box, in the accent", () => {
  assert.ok(page.includes('<form class="newthread" id="newthread" data-reply="new"><label class="nt-label" for="nttext">Start a thread</label><div class="cbox">'));
  assert.match(css, /\.newthread \.nt-label\{font:600 \.78rem var\(--body\);color:var\(--accent\)\}/);
});

test("the new-thread box is white with an accent outline, and still shows focus", () => {
  assert.match(css, /\.newthread \.cbox\{background:var\(--panel\);border:1\.5px solid var\(--accent\)\}/);
  assert.match(css, /\.cbox:focus-within\{border-color:var\(--accent\);box-shadow:0 0 0 3px var\(--accent-soft\)\}/, "the focus ring every compose box has");
  assert.match(css, /\.cbox\{[^}]*background:var\(--bg\)\}/, "reply boxes keep the grey");
});

test("search is an unfilled box", () => {
  assert.match(css, /\.sbox input\{[^}]*border:1px solid var\(--line\);border-radius:6px;background:transparent;/);
  assert.match(css, /\.rsearch input\{[^}]*background:transparent;/);
});
