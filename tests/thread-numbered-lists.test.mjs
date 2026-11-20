// #C1297 (the owner: a numbered list in a thread message, with a blank line between its items, showed "1." on every item and the numbers sat over the first letters of the text).
// Cause: a blank line closed the list, so each item was an <ol> of its own, and every <ol> counts from 1; the list also had too little room (1.4em) for its numbers.
// Now a blank line between items of the same kind keeps one list, each numbered item keeps the number it was written with, and the list has room for two digits and the dot.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const b = loadNames(["askText", "threadHtml", "state"]);
const lis = (html) => [...html.matchAll(/<li(?: value="(\d+)")?>([^<]*)<\/li>/g)].map((m) => `${m[1] ?? ""}:${m[2]}`);
const lists = (html) => (html.match(/<ol class="w-list">/g) || []).length;

test("a numbered list with blank lines between its items is one list that counts up", () => {
  const html = b.askText("Three things:\n\n1. first point\n\n2. second point\n\n3. third point");
  assert.equal(lists(html), 1, "one <ol>, not one per item");
  assert.deepEqual(lis(html), ["1:first point", "2:second point", "3:third point"]);
});

test("each item keeps the number it was written with, so a list that starts at 3 or skips one reads as written", () => {
  assert.deepEqual(lis(b.askText("intro\n3. third\n\n5. fifth")), ["3:third", "5:fifth"]);
});

test("a list with no blank lines is unchanged (one list), and so is a bulleted list with blank lines", () => {
  assert.equal(lists(b.askText("a\n1. one\n2. two")), 1);
  const bullets = b.askText("a\n- one\n\n- two");
  assert.equal((bullets.match(/<ul class="w-list">/g) || []).length, 1, "one <ul>");
  assert.deepEqual([...bullets.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]), ["one", "two"]);
});

test("a blank line still separates a list from the text after it, and a numbered list from a bulleted one", () => {
  const html = b.askText("1. one\n\n2. two\n\nthen some words\n\n- bullet");
  assert.equal(lists(html), 1);
  assert.match(html, /<\/ol><span class="pgap"><\/span>then some words/);
  assert.match(html, /<span class="pgap"><\/span><ul class="w-list"><li>bullet<\/li><\/ul>/);
});

test("in a thread message the list reaches the page as one list", () => {
  b.state.messages = [{ id: "m1", thread: "t-1", from: "Manager", text: "Options:\n\n1. alpha\n\n2. beta", at: Date.now() - 1000 }];
  b.state.threads = [{ id: "t-1", num: 1 }];
  const html = b.threadHtml("t-1", "x");
  assert.equal(lists(html), 1);
  assert.deepEqual(lis(html), ["1:alpha", "2:beta"]);
});

test("the list has room for its numbers: at least 2em on the left, numbers outside the text", () => {
  const css = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  const pad = /\.w-list\{margin:6px 0;padding-left:([\d.]+)em\}/.exec(css);
  assert.ok(pad && Number(pad[1]) >= 2, "padding-left of the list");
  assert.ok(/ol\.w-list\{list-style-position:outside\}/.test(css), "numbers sit outside the text");
});
