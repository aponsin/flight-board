// A search box at the top of the Done list (#C395, the owner in t-1793170014758): like the cards' box (#C360/#C365):
// #C number, name, who, any word, with the same × clear. While it has text it searches every done card, of any age (the
// list shows the last 24 hours only), newest first, the first 20 drawn; the cards' box filters the open cards only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const T = Date.now(), H = 3600e3;
const card = (id, num, fields = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "done", phase: "live", skip: ["plan"], ...fields });
function board(extra = []) {
  const b = loadNames(["renderBoard", "setInitSearch", "setDoneSearch", "initHit", "cardOpen", "showClear"]);
  Object.assign(b.state, {
    initRaw: [], steps: [], waiting: [], derived: [], messages: [], threads: [],
    initiatives: [
      { ...card("board-tab-search", 356, { name: "Board: one search box", who: "Boardsmith" }), status: "active", phase: "build" },
      card("pottery-shelf", 300, { name: "Pottery shelf", who: "Demos", doneAt: T - H }),
      card("logo-shape", 301, { name: "Logo shape", who: "Designer", doneAt: T - 2 * H }),
      card("old-pottery", 250, { name: "Pottery photos, first pass", who: "Demos", doneAt: T - 72 * H }),
      ...extra,
    ],
  });
  return b;
}

test("a box at the top of the Done list, inside it, like the cards' box: magnifier, label, × clear", () => {
  assert.match(page, /<details class="done-list panel" id="donebox" hidden style="margin-top:10px"><summary id="donesum">Done<\/summary><div class="dhead"><div class="sbox clr"><svg class="sicon"[^>]*aria-hidden="true">[\s\S]*?<\/svg><input type="search" id="dsearch" placeholder="Search done cards: #C number, name, who, any word" aria-label="Search done cards" autocomplete="off"><button type="button" class="sclear" data-sclear="dsearch" aria-label="Clear the search" title="Clear the search" hidden>×<\/button><\/div><\/div><div class="board" id="doneboard"><\/div><\/details>/);
  assert.match(page, /\.dhead\{[^}]*padding:0 16px 10px/);
  assert.match(page, /const SCLEAR=\{[^}]*dsearch:q=>setDoneSearch\(q\)/, "the same one-click clear");
  assert.match(page, /if\(e\.target&&e\.target\.id==="dsearch"\)\{const v=e\.target\.value;clearTimeout\(doneTimer\);doneTimer=setTimeout\(\(\)=>setDoneSearch\(v\),SEARCH_WAIT\)\}/, "#C363's pace");
});

test("it searches every done card, any age, by #C number, name, who or any word; the summary says how many", () => {
  const b = board();
  b.renderBoard();
  assert.equal(b.els.donesum.textContent, "Done in the last 24 h (2)");
  assert.doesNotMatch(b.els.doneboard.innerHTML, /first pass/, "older than a day: out of view");
  b.setDoneSearch("pottery");
  assert.match(b.els.doneboard.innerHTML, /Pottery shelf[\s\S]*Pottery photos, first pass/, "newest first, a 3-day-old one too");
  assert.doesNotMatch(b.els.doneboard.innerHTML, /Logo shape/);
  assert.equal(b.els.donesum.textContent, "Done: 2 found, any age");
  b.setDoneSearch("#C250");
  assert.match(b.els.doneboard.innerHTML, /first pass/);
  assert.doesNotMatch(b.els.doneboard.innerHTML, /Pottery shelf/, "#C exactly");
  b.setDoneSearch("designer");
  assert.match(b.els.doneboard.innerHTML, /Logo shape/, "who");
  b.setDoneSearch("nothing like it");
  assert.equal(b.els.doneboard.innerHTML, '<div class="empty">No matches.</div>');
  assert.equal(b.els.donesum.textContent, "Done: 0 found, any age");
  b.setDoneSearch("");
  assert.equal(b.els.donesum.textContent, "Done in the last 24 h (2)");
});

test("the first 20 matches are drawn, and it says so when there are more", () => {
  const many = Array.from({ length: 25 }, (_, k) => card(`p-${k}`, 500 + k, { name: `Pottery ${k}`, doneAt: T - (k + 3) * H }));
  const b = board(many);
  b.setDoneSearch("pottery");
  assert.equal((b.els.doneboard.innerHTML.match(/data-card=/g) || []).length, 20);
  assert.match(b.els.doneboard.innerHTML, /<div class="empty">The newest 20 of 27 shown: add a word to narrow it\.<\/div>$/);
});

test("with no card done in the last day the box stays, so older ones can be found; none done at all, no list", () => {
  const b = board();
  b.state.initiatives = b.state.initiatives.filter((i) => i.id !== "pottery-shelf" && i.id !== "logo-shape");
  b.renderBoard();
  assert.equal(b.els.donebox.hidden, false);
  assert.equal(b.els.donesum.textContent, "Done in the last 24 h (0)");
  assert.equal(b.els.doneboard.innerHTML, '<div class="empty">Nothing done in the last 24 h: search for older cards.</div>');
  b.state.initiatives = b.state.initiatives.filter((i) => i.status !== "done");
  b.renderBoard();
  assert.equal(b.els.donebox.hidden, true);
});

test("the two boxes are apart: the cards' box filters the open cards only, the Done box the done ones only", () => {
  const b = board();
  b.setInitSearch("pottery");
  assert.equal(b.els.donesum.textContent, "Done in the last 24 h (2)", "the cards' box leaves Done alone");
  assert.match(b.els.doneboard.innerHTML, /Logo shape/);
  b.setInitSearch("");
  b.setDoneSearch("search box");
  assert.match(b.els.board.innerHTML, /one search box/, "the Done box leaves the open cards alone");
  assert.doesNotMatch(b.els.doneboard.innerHTML, /one search box/, "and never lists an open card");
});

test("a card's number clears the Done box's search when it hides that card, and only then", () => {
  const b = board();
  b.setDoneSearch("logo");
  b.cardOpen("pottery-shelf");
  assert.equal(b.els.dsearch.value, "", "it hid the card: cleared");
  b.setDoneSearch("pottery");
  b.cardOpen("pottery-shelf");
  assert.equal(b.els.dsearch.value, "pottery", "it showed the card: kept");
});
