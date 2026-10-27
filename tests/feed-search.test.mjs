// Shipped and reported scrolls inside, and has a search box (#C362, the owner): on a laptop it is never taller than Time
// spent beside it and scrolls inside; on a phone it has a fixed height. It lists every event, of any age, newest first,
// and its own box filters them as he types (#C363's matching and pace: each event's text built once per data update,
// each key waits 150 ms for the next); nothing found says "No matches.". It reads events only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const T = Date.now(), DAY = 864e5;
function board(events) {
  const b = loadNames(["renderFeed", "setFeedSearch", "feedHit"]);
  b.state.events = events;
  return b;
}
const evs = () => [
  { id: "e1", at: T - 600e3, version: "v1.158.8", text: "v1.158.8 shipped (be37e49): #C321 three small look fixes" },
  { id: "e2", at: T - 9 * DAY, text: "Board release ab88a96: #C355 a Check nobody answered shows 'no answer yet'" },
  { id: "e3", at: T - 3 * DAY, text: "Checker passed #C340 'Our story'" },
];

test("every event of any age, newest first", () => {
  const b = board(evs());
  b.renderFeed();
  const h = b.els.feed.innerHTML;
  assert.match(h, /#C321[\s\S]*#C340[\s\S]*#C355/, "newest first, a 9-day-old one too");
  b.state.events = Array.from({ length: 60 }, (_, n) => ({ id: "x" + n, at: T - n * DAY, text: "Release " + n }));
  b.renderFeed();
  assert.equal((b.els.feed.innerHTML.match(/<li>/g) || []).length, 60, "no 25-row cap");
  assert.doesNotMatch(b.els.feed.innerHTML, /Nothing shipped/);
  b.state.events = [];
  b.renderFeed();
  assert.match(b.els.feed.innerHTML, /Nothing shipped yet\./);
});

test("the box filters by version or any word, any case; nothing found says so; the count reads N of M", () => {
  const b = board(evs());
  b.setFeedSearch("AB88A96");
  assert.match(b.els.feed.innerHTML, /#C355/);
  assert.doesNotMatch(b.els.feed.innerHTML, /#C321|#C340/);
  assert.equal(b.els.feedcount.textContent, "1 of 3");
  assert.equal(b.els.feedcount.hidden, false);
  assert.equal(b.feedHit(evs()[0], "v1.158"), true, "the version");
  assert.equal(b.feedHit(evs()[2], "our story"), true);
  assert.equal(b.feedHit({ id: "e4", text: "Pause sits under it (the owner's A on #T953)" }, "#t953"), true, "a #T in an event's words");
  b.setFeedSearch("nothing like it");
  assert.equal(b.els.feed.innerHTML, '<li><span></span><span class="empty" style="padding:0">No matches.</span></li>');
  b.setFeedSearch("");
  assert.equal(b.els.feedcount.hidden, true);
  assert.match(b.els.feed.innerHTML, /#C321[\s\S]*#C355/);
});

test("its own box, at #C363's pace and with its per-update text", () => {
  assert.match(page, /<input type="search" id="fsearch" placeholder="Search: version, #C number, any word" aria-label="Search shipped and reported" autocomplete="off">/);
  assert.match(page, /if\(e\.target&&e\.target\.id==="fsearch"\)\{const v=e\.target\.value;clearTimeout\(feedTimer\);feedTimer=setTimeout\(\(\)=>setFeedSearch\(v\),SEARCH_WAIT\)\}/);
  assert.match(page, /textOnce\("e:"\+e\.id,/);
});

test("it scrolls inside: Time spent sets the row's height on a laptop; a fixed height on a phone", () => {
  assert.match(page, /<section aria-labelledby="h-feed" class="feedsec">/);
  assert.match(page, /<div class="feedwrap"><ul class="feed" id="feed">/);
  assert.match(page, /\.feedsec\{display:flex;flex-direction:column\}/);
  assert.match(page, /\.feedwrap>\.feed\{position:absolute;inset:0;overflow-y:auto/, "its rows don't size the row: Time spent does");
  assert.match(page, /\.feedwrap>\.feed\{[^}]*\}\n@media \(max-width:760px\)\{\.feedpanel\{min-height:0\}\.feedwrap\{flex:none;height:26rem\}\}/, "a fixed height on a phone, after the laptop rules so it wins");
});
