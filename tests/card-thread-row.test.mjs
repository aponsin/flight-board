// #C1263: the row under a card's counts (Details, then the thread's fold) stays one tidy line. While a thread's answer is on its way
// to Manager the sending dots used to land in the card's thread summary as a block box: a stray marker, a grey box holding only the dots,
// and "Thread (N)" stacked under it. These tests list what the row must still show, then pin the fix.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const css = html.slice(html.indexOf("<style"), html.indexOf("</style>"));

// The card's thread fold, as the template builds it (the line that makes `const thread=`).
const threadLine = html.split("\n").find((l) => l.includes('const thread=`<details class="i-thread"'));
const detLine = html.split("\n").find((l) => l.includes('<details class="i-det"'));

test("the row still shows its label: Thread (N), Thread, or Start a thread, in the fold's own summary", () => {
  assert.ok(threadLine, "the card's thread fold is still built in the row");
  assert.match(threadLine, /<summary>\$\{tn\?`Thread \(\$\{tn\}\)`:asks\.length\?"Thread":"Start a thread"\}/);
});

test("the row still shows the closed-asks count, the with-the-team badge and the unanswered tag after the label", () => {
  assert.match(threadLine, /closed ask\$\{asks\.length>1\?"s":""\}/);
  assert.match(threadLine, /badge\(on\)\+lateTag\(i\.id,Date\.now\(\)\)/);
});

test("the row still shows Details before the thread fold, both in the one actions row", () => {
  assert.ok(detLine, "the Details fold is still built");
  assert.match(detLine, /<summary>Details<\/summary>/);
  assert.match(html, /<div class="i-acts">\$\{det\}\$\{thread\}<\/div>/);
});

test("the count is still the thread's messages: this card does not change what is counted", () => {
  assert.match(html, /const tn=threadOf\(i\.id\)\.length,/);
});

test("the sending dots in a card's thread summary sit inline, on the label's line, not as a block box above it", () => {
  assert.match(css, /\.i-thread>summary>\.sdots\{[^}]*display:inline-flex/, "inline-flex, so the label stays beside them");
  assert.match(css, /\.i-thread>summary>\.sdots\{[^}]*vertical-align:middle/);
  assert.match(css, /\.i-thread>summary>\.sdots\{[^}]*padding:0/, "no box padding of its own");
});

test("a sending card thread does not turn its summary into a grey box, and keeps its label visible", () => {
  assert.match(css, /\.i-thread\.sending>summary\{background:none\}/);
  assert.ok(!/\.i-thread[^{]*\{[^}]*display:none/.test(css), "the label is never hidden for the card's fold (a reader and the owner both need it)");
});

test("the fix is for the card's folds only: the ask and thread rows keep their dots in the label's place", () => {
  assert.match(css, /details\.sending>summary>\.kind\{display:none\}/);
  assert.match(css, /\.sdots\{position:relative;display:flex;gap:4px;align-items:center;padding:2px 7px;min-height:1\.4rem\}/);
});

test("the Details fold never takes the dots: its data-id is not a thread's, so the sending key never matches it", () => {
  assert.match(detLine, /data-id="idet-\$\{esc\(i\.id\)\}"/);
  assert.match(html, /const foldKey=d=>String\(d\.dataset\.id\|\|""\)\.replace\(\/\^i\?th-\/,""\)/);
});
