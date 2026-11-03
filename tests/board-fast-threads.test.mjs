// A tab switch on a board with hundreds of resolved threads (#C643, the owner: switching thread tabs is sluggish, 444
// resolved threads and about 13.3k messages): the page indexed nothing, so each thread's state scanned every message, and
// a switch asked for every thread's state (1.6 s measured). Messages are now indexed by thread once per data update, and
// the Resolved list shows the newest rows with "Show older". Fictional threads.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";
const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");

const T = 1_800_000_000_000, DAY = 864e5;
const NAMES = ["tabCounts", "tabsHtml", "resolvedHtml", "showTab", "threadOf", "threadIds", "searchNow"];
// The page's clock is the test's: the click handler reads Date.now().
class FakeDate extends Date { static now() { return T; } }
function board(n = 500, per = 30) {
  const b = loadNames(NAMES, { Date: FakeDate });
  const messages = [], threads = [];
  for (let i = 0; i < n; i++) {
    const id = `t-${1_799_000_000_000 + i}`, at0 = T - (i + 1) * 0.4 * DAY;
    threads.push({ id, num: 100 + i, title: `Thread ${i}` });
    for (let k = 0; k < per; k++) messages.push({ id: `m${i}-${k}`, thread: id, from: k % 2 ? "Manager" : "Owner", text: `message ${k} of thread ${i}`, at: at0 + k * 1000, ...(k === per - 1 ? { resolved: true } : {}) });
  }
  Object.assign(b.state, { messages, threads, waiting: [], todo: [], ideas: [], initRaw: [], initiatives: [] });
  return b;
}
const ms = (f) => { const s = performance.now(); f(); return performance.now() - s; };

test("a tab switch with 500 resolved threads (15k messages) is fast: it was 1.6 s on 444", () => {
  const b = board();
  b.tabCounts(T); // the first look builds the index
  assert.ok(ms(() => b.showTab("resolved")) < 300, "a switch");
  assert.ok(ms(() => b.showTab("lead")) < 300, "another switch");
  assert.ok(ms(() => b.tabCounts(T)) < 300, "the counts of every tab");
  assert.ok(ms(() => b.resolvedHtml(T)) < 300, "the Resolved list");
});

test("the thread index: same threads and order as a scan, and a new message shows at once", () => {
  const b = board(3, 4);
  assert.equal(b.threadIds().length, 3);
  const id = b.threadIds()[0];
  assert.deepEqual([...b.threadOf(id)].map((m) => m.id), [0, 1, 2, 3].map((k) => `m0-${k}`));
  b.state.messages.push({ id: "late", thread: id, from: "Owner", text: "one more", at: T + 5 });
  assert.equal(b.threadOf(id).at(-1).id, "late", "a longer list is indexed again");
  b.state.messages = b.state.messages.filter((m) => m.thread !== id);
  assert.equal(b.threadOf(id).length, 0, "another list is indexed again");
  assert.equal(b.threadIds().length, 2);
  b.state.messages.push({ id: "x", thread: "t-9", from: "Owner", text: "no time" }, { id: "y", thread: 7, from: "Owner", text: "bad thread", at: 1 });
  assert.equal(b.threadIds().length, 2, "a message with no time or no thread name makes no thread");
});

test("Resolved: the newest rows, then Show older, 50 at a time; a search starts over", () => {
  const b = board();
  const click = () => b.listeners.click.forEach((f) => f({ target: { closest: (s) => (s === "[data-rmore]" ? {} : null) } }));
  const rows = (html) => (html.match(/<details class="w-item"/g) || []).length;
  let html = b.resolvedHtml(T);
  const week = Math.ceil(7 / 0.4) - 1;
  assert.equal(rows(html), week, "the last 7 days");
  assert.match(html, /data-rmore>Show older</, "older ones exist: the button says so");
  click();
  html = b.resolvedHtml(T);
  assert.equal(rows(html), 50, "the older ones, newest first, 50 rows");
  assert.match(html, /data-rmore>Show 50 more<\/button> \(450 left\)/);
  click(); click();
  assert.equal(rows(b.resolvedHtml(T)), 150);
  b.searchNow("thread 4");
  assert.ok(rows(b.resolvedHtml(T)) <= 50, "a search starts over at 50 rows");
});

// Designer on 0cb4dea: the button is tap-sized, and focus follows the redraw.
test("Show older: a 44 px tap target of its own, and focus moves to the first row it added", () => {
  assert.match(page, /\.tmore\{[^}]*padding:12px 0;min-height:44px/);
  assert.match(page, /<button type="button" class="tmore" data-rmore>/);
  assert.match(page, /renderResolved\(\);\s*const t=document\.querySelectorAll\("#resolved \.w-item > summary"\)\[had\]\|\|document\.querySelector\("#resolved \[data-rmore\]"\);if\(t&&t\.focus\)t\.focus\(\)/);
});
