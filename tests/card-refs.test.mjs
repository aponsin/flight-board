// A card's number in text is a link (#C367, the owner in #T978): "#C356" in a message, an ask, a card's summary or an
// event opens the card (opening Done, or clearing a cards' search that hides it); a number no card has stays text.
// Hovering it, or focusing it by keyboard, shows a bubble: the card's name, then its phase and who, its ETA and its next
// step. On a phone a tap goes straight to the card. All text escaped; no new data.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const T = Date.now();
const cards = () => [
  { id: "card-a", num: 356, name: "Tabs <search>", size: "M", status: "active", phase: "build", who: "Boardsmith", branch: "board-tabs", etaLive: T + 2 * 36e5, createdAt: T - 9e5, nextNote: "Build the tabs & the box", nextNoteAt: T - 6e4 },
  { id: "card-done", num: 300, name: "Pill count", size: "S", status: "done", phase: "live", doneAt: T - 36e5, version: "v3.15.2" },
  { id: "card-old", num: 200, name: "Old one", size: "S", status: "done", phase: "live", doneAt: T - 5 * 864e5 },
];
function board() {
  const b = loadNames(["linkify", "cardLinks", "cardBubble", "cardOpen", "initRow", "renderFeed", "renderBoard", "setInitSearch", "withLine"]);
  Object.assign(b.state, { steps: [], derived: [], todo: [], ideas: [], waiting: [], messages: [], threads: [{ id: "t-5", num: 5 }], initRaw: cards(), initiatives: cards(), events: [] });
  return b;
}
const link = (id, n) => `<a href="#" class="t-ref c-ref" data-cref="${id}">#C${n}</a>`;

test("#C356 in text links to its card; a number no card has stays text; never inside a web address", () => {
  const b = board();
  const h = b.linkify("Two reasons: #C356 and #C999 (#T5); see https://x.dev/a#C356");
  assert.ok(h.includes(`Two reasons: ${link("card-a", 356)} and #C999 (<a href="#" class="t-ref" data-tref="t-5">#T5</a>)`), h);
  assert.match(h, /<a href="https:\/\/x\.dev\/a#C356" target="_blank" rel="noopener">https:\/\/x\.dev\/a#C356<\/a>/, "the address stays whole");
  assert.equal(b.linkify("x#C356 &#C356"), "x#C356 &amp;#C356", "only a number standing on its own");
  assert.equal(b.cardLinks("for #C300 &lt;b&gt;"), `for ${link("card-done", 300)} &lt;b&gt;`, "on text already escaped");
});

test("in a card's summary and in Shipped and reported", () => {
  const b = board();
  const c = { ...cards()[0], summary: "After #C300 <ships>" };
  assert.match(b.initRow(c), new RegExp(`<div class="w-sub">After ${link("card-done", 300).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} &lt;ships&gt;</div>`));
  b.state.events = [{ id: "e1", at: T, version: "v3.16", text: "#C356 live <now>" }];
  b.renderFeed();
  assert.ok(b.els.feed.innerHTML.includes(`${link("card-a", 356)} live &lt;now&gt;`), b.els.feed.innerHTML);
});

test("the bubble: name, then phase and who, ETA and next step; escaped", () => {
  const b = board();
  const h = b.cardBubble(b.state.initiatives[0], T);
  assert.match(h, /^<b>#C356 Tabs &lt;search&gt;<\/b><br>Build · Boardsmith · due ~\d.* · Next: Build the tabs &amp; the box$/);
  assert.match(b.cardBubble(b.state.initiatives[1], T), /^<b>#C300 Pill count<\/b><br>Live v3\.15\.2 · \d/);
  const long = b.cardBubble({ ...cards()[0], nextNote: "x".repeat(200) }, T);
  assert.ok(long.length < 260, "the next step is cut, so it stays two lines");
});

// A card's row as the page draws it, in the board or the Done fold.
function row(id) { const r = { dataset: { card: id }, scrolled: 0, closest: () => null }; r.scrollIntoView = () => { r.scrolled++; }; return r; }
test("a click opens the card: on the board, or in Done (opened); a search that hides it is cleared", () => {
  const b = board(), r = row("card-a");
  b.document.getElementById("board").querySelectorAll = () => (b.document.getElementById("isearch").value ? [] : [row("x"), r]);
  b.setInitSearch("nothing like it");
  assert.equal(b.cardOpen("card-a"), r);
  assert.equal(b.document.getElementById("isearch").value, "", "cleared");
  assert.equal(r.scrolled, 1);
  const c = board(), d = row("card-done");
  c.document.getElementById("doneboard").querySelectorAll = () => [d];
  assert.equal(c.cardOpen("card-done"), d);
  assert.equal(c.document.getElementById("donebox").open, true, "Done opened");
  assert.equal(c.cardOpen("card-old"), null, "a card the board no longer draws");
  assert.equal(c.cardOpen("nope"), null);
});

test("wiring: rows carry their card, the click opens it, the bubble shows on hover or focus only", () => {
  const b = board();
  assert.match(b.initRow(b.state.initiatives[0]), /^<div class="i-row"><div data-card="card-a">/, "inside the row: the fixtures reader splits on the row's exact tag");
  assert.match(b.withLine("t-x"), /^$/, "nothing for a thread with no card");
  assert.match(page, /<div class="cbub" id="cbub" role="tooltip" hidden><\/div>/);
  assert.match(page, /closest\("\[data-cref\]"\);if\(!a\)return;e\.preventDefault\(\);cbubHide\(\);\s*if\(!cardOpen\(a\.dataset\.cref\)\)a\.title="That card is no longer shown on the board"/);
  assert.match(page, /addEventListener\("mouseover",e=>\{if\(!HOVER\(\)\)return;/, "a phone's tap goes straight to the card");
  assert.match(page, /addEventListener\("focusin",/);
});
