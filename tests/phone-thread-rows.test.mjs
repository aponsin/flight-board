// A phone's thread rows (#C430, Designer): under 480 px every Needs-you row puts its kind label and a short age ("7 min",
// no "ago") on one line, and the title and its body take the full width under them; the header's "Live now: v…"
// never breaks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];

test("under 480 px: kind and age on one line, the text on its own full-width line, 'ago' dropped", () => {
  const phone = css.match(/@media \(max-width:480px\)\{([^\n]*)\}/);
  assert.ok(phone, "a 480 px rule");
  assert.match(phone[1], /\.w-row\{grid-template-columns:auto 1fr\}/);
  assert.match(phone[1], /\.w-row>\.w-text\{grid-column:1\/-1;grid-row:2\}/);
  assert.match(phone[1], /\.w-row>\.age\{justify-self:end\}/);
  assert.match(phone[1], /\.age \.ago\{display:none\}/);
  assert.match(css, /\.w-row\{display:grid;grid-template-columns:auto 1fr auto;/, "a laptop's three columns stay");
});

test("a thread row's age keeps 'ago' in its own span, so a phone can drop it and a laptop reads as before", () => {
  const T = Date.now();
  const b = loadNames(["threadRow"]);
  Object.assign(b.state, { steps: [], derived: [], todo: [], ideas: [], waiting: [], initiatives: [], events: [], threads: [{ id: "t-1", num: 7, title: "A thread" }], messages: [{ id: "m1", thread: "t-1", from: "Manager", at: T - 7 * 60e3, text: "Hi" }] });
  const row = b.threadRow("t-1", T);
  assert.match(row, /<span class="age">7 min<span class="ago"> ago<\/span> <span class="caret"/);
  assert.equal(row.replace(/<[^>]+>/g, "").match(/7 min ago/)?.[0], "7 min ago", "as text, the same words as before");
});

test("the header's 'Live now: v…' never breaks", () => {
  assert.match(css, /\.livever\{[^}]*white-space:nowrap/);
});
