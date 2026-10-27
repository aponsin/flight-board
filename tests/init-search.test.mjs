// A search box at the top of "Initiatives in flight" (#C360, the owner in #T966): it filters the open cards as he types,
// matching the #C number (exact), name, summary, next step, who, phase, the #T number and the card's thread messages, in
// any case (#C356's matching). The heading's count reads "N of M" while searching, an empty result says "No matches.",
// and "Done in the last 24 h" is filtered too. Its own box: the Threads box's search is unaffected.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const T = Date.now();
const card = (id, num, fields = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", skip: ["plan"], ...fields });
function board() {
  const b = loadNames(["renderBoard", "setInitSearch", "initHit", "tabCounts"]);
  Object.assign(b.state, {
    initRaw: [], steps: [], waiting: [], derived: [],
    initiatives: [
      card("board-tab-search", 356, { name: "Board: one search box over all six tabs", who: "Boardsmith", nextNote: "With Designer" }),
      card("reports-where-from", 340, { name: "Reports: where visitors come from", who: "Admin", phase: "checker", summary: "A US state tile map" }),
      card("pottery", 287, { name: "Yogamason: pottery photos", who: "Demos" }),
      card("old-done", 300, { name: "Pottery shelf", status: "done", doneAt: T - 3600e3, phase: "live" }),
      card("done-two", 301, { name: "Logo shape", status: "done", doneAt: T - 7200e3, phase: "live" }),
    ],
    messages: [{ id: "m1", thread: "reports-where-from", from: "Owner", text: "Can it show Colorado first?", at: T - 6e5 }],
    threads: [{ id: "pottery", num: 958, title: "Pottery photos" }],
  });
  return b;
}

test("one box in the heading's row, labelled, with a magnifier; the heading itself unchanged", () => {
  assert.match(page, /<div class="init-head"><h2 id="h-init">Initiatives in flight<span class="h-count" id="initcount" hidden><\/span><\/h2><div class="sbox"><svg class="sicon"[^>]*aria-hidden="true">[\s\S]*?<\/svg><input type="search" id="isearch" placeholder="Search cards: #C number, name, who, any word" aria-label="Search initiatives" autocomplete="off"><\/div><\/div>/);
  assert.match(page, /\.sicon\{[^}]*top:50%;[^}]*transform:translateY\(-50%\)/, "Designer on 96fb1bf: the mark centred in the box");
  assert.match(page, /<div class="rsearch" id="tsearch"><div class="sbox"><svg class="sicon"/, "the same mark in the Threads box");
});

test("what a card matches: #C exactly, name, summary, next step, who, phase, #T and its thread", () => {
  const b = board(), [ts, wf, pot] = b.state.initiatives;
  assert.equal(b.initHit(ts, "#C356"), true);
  assert.equal(b.initHit(ts, "#c35"), false, "#C35 is not #C356");
  assert.equal(b.initHit(ts, "SEARCH BOX"), true);
  assert.equal(b.initHit(wf, "tile map"), true, "summary");
  assert.equal(b.initHit(ts, "designer"), true, "next step");
  assert.equal(b.initHit(wf, "admin"), true, "who");
  assert.equal(b.initHit(wf, "checker"), true, "phase");
  assert.equal(b.initHit(pot, "#T958"), true, "its thread's number");
  assert.equal(b.initHit(wf, "colorado"), true, "a message in its thread");
  assert.equal(b.initHit(ts, "colorado"), false);
  assert.equal(b.initHit(ts, ""), true);
});

test("searching filters the open cards and the done ones; the count reads N of M; nothing found says so", () => {
  const b = board();
  b.setInitSearch("pottery");
  assert.match(b.els.board.innerHTML, /Yogamason: pottery photos/);
  assert.doesNotMatch(b.els.board.innerHTML, /search box|where visitors/);
  assert.equal(b.els.initcount.textContent, "1 of 3");
  assert.match(b.els.doneboard.innerHTML, /Pottery shelf/);
  assert.doesNotMatch(b.els.doneboard.innerHTML, /Logo shape/);
  assert.equal(b.els.donesum.textContent, "Done in the last 24 h (1 of 2)");
  b.setInitSearch("nothing like it");
  assert.equal(b.els.board.innerHTML, '<div class="empty">No matches.</div>');
  assert.equal(b.els.initcount.textContent, "0 of 3");
  assert.equal(b.els.initcount.hidden, false);
  b.setInitSearch("");
  assert.equal(b.els.initcount.textContent, "3");
  assert.equal(b.els.donesum.textContent, "Done in the last 24 h (2)");
  assert.match(page, /document\.addEventListener\("input",e=>\{if\(e\.target&&e\.target\.id==="isearch"\)setInitSearch\(e\.target\.value\)\}\)/);
});
