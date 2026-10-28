// A #T link opens its item wherever it is (#C365, the owner in #T974: #T972, a decision under Needs you, did nothing).
// Since #C351 the item may sit in a tab's hidden panel, and an ask with no messages yet has no thread element at all.
// The link now finds the item's row by its id (an ask, a thread row, a card's thread), opens its tab (or scrolls to the
// card), clears a search that hides it, opens its folds and scrolls there. A closed thread opens under Resolved.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const T = Date.now();
const msg = (thread, from, text, at, extra = {}) => ({ id: `m${at}${from}${thread}`, thread, from, text, at, ...extra });
const cards = () => [{ id: "card-a", num: 360, name: "Card A", status: "active", phase: "build" }, { id: "card-done", num: 300, name: "Old card", status: "done", doneAt: T - 9e5 }];
function board() {
  const b = loadNames(["trefPlace", "trefOpen", "showTab", "searchNow", "setInitSearch"]);
  Object.assign(b.state, {
    steps: [], derived: [], todo: [],
    waiting: [
      { id: "go364", kind: "decision", text: "Go for #C364?", options: [{ key: "A", label: "Go" }], since: T - 9e5 },
      { id: "l1", kind: "later", text: "Spanish wording", since: T - 7e5 },
      { id: "pub", kind: "decision", text: "Which one?", options: [{ key: "A", label: "a" }], since: T - 8e5, response: { status: "A", at: T - 6e5 } },
    ],
    initRaw: cards(), initiatives: cards(),
    messages: [
      msg("t-ans", "Owner", "Can it show ETAs?", T - 5e5), msg("t-ans", "Manager", "Yes", T - 4e5),
      msg("t-open", "Owner", "One more thing", T - 3e5),
      msg("t-res", "Owner", "Colours", T - 2e5), msg("t-res", "Manager", "Done", T - 1e5, { resolved: true }),
      msg("card-a", "Owner", "On this card", T - 2e5),
      msg("card-done", "Owner", "Thanks", T - 3e5), msg("card-done", "Manager", "Shipped", T - 2e5),
    ],
    threads: [{ id: "go364", num: 972 }, { id: "t-ans", num: 961 }, { id: "t-open", num: 962 }, { id: "t-res", num: 958 }, { id: "card-done", num: 900 }],
    ideas: [{ id: "idea1", text: "Weekly digest" }],
  });
  return b;
}

test("where each item lives: its tab, or the board for a card in flight", () => {
  const b = board();
  const at = (id) => JSON.stringify(b.trefPlace(id, T));
  assert.equal(at("go364"), '{"tab":"you"}', "#T972: an ask with no messages yet, under Needs you");
  assert.equal(at("l1"), '{"tab":"later"}');
  assert.equal(at("pub"), '{"tab":"lead"}', "answered, not closed: Waiting on Manager");
  assert.equal(at("t-ans"), '{"tab":"you"}', "Manager's word last: Needs you");
  assert.equal(at("t-open"), '{"tab":"lead"}');
  assert.equal(at("t-res"), '{"tab":"resolved"}');
  assert.equal(at("card-done"), '{"tab":"resolved"}', "a done card's thread is closed");
  assert.equal(at("card-a"), '{"card":true}');
  assert.equal(at("idea1"), '{"tab":"ideas"}');
  assert.equal(b.trefPlace("nothing", T), null);
});

// A row as the page draws it: a fold with its id, inside a tab's panel or the board.
function row(id) {
  const r = { tagName: "DETAILS", dataset: { id }, open: false, parentElement: null, scrolled: 0 };
  r.closest = (s) => (s === "details" ? r : null);
  r.scrollIntoView = () => { r.scrolled++; };
  return r;
}
const put = (b, panel, rows) => { b.document.getElementById(panel).querySelectorAll = () => rows; };

test("each tab: the link opens the tab, the row's fold, and scrolls there", () => {
  for (const [id, tab, rid] of [["go364", "you", "go364"], ["l1", "later", "l1"], ["pub", "lead", "pub"], ["t-ans", "you", "th-t-ans"], ["t-open", "lead", "th-t-open"], ["t-res", "resolved", "th-t-res"]]) {
    const b = board(), r = row(rid);
    put(b, "tp-" + tab, [row("other"), r]);
    assert.equal(b.trefOpen(id), r, id);
    assert.ok(b.els.ttabs.innerHTML.includes(`id="tab-${tab}" class="ttab on"`), `${id} opens ${tab}`);
    assert.equal(r.open, true, `${id}: its fold opens`);
    assert.equal(r.scrolled, 1, `${id}: scrolled to`);
  }
});

test("a card's thread: the card's fold on the board, and a cards' search that hides it is cleared", () => {
  const b = board(), r = row("ith-card-a");
  put(b, "board", [r]);
  b.setInitSearch("nothing like it");
  assert.equal(b.trefOpen("card-a"), r);
  assert.equal(b.document.getElementById("isearch").value, "", "the search that hid it is cleared");
  assert.equal(r.open, true);
  assert.equal(r.scrolled, 1);
});

test("a Threads search that hides the row is cleared; a closed thread is searched for under Resolved", () => {
  const b = board(), r = row("go364");
  b.showTab("you");
  b.searchNow("nothing like it");
  let drawn = false;
  b.document.getElementById("tp-you").querySelectorAll = () => (b.document.getElementById("rsearch").value ? [] : (drawn = true, [r]));
  assert.equal(b.trefOpen("go364"), r);
  assert.equal(drawn, true, "drawn again unfiltered");
  const c = board(), res = row("th-t-res");
  put(c, "tp-resolved", [res]);
  c.trefOpen("t-res");
  assert.equal(c.document.getElementById("rsearch").value, "#T958", "#C288: searched by its number, whatever its age");
});

test("the click handler uses it; a number nothing has says so", () => {
  assert.match(page, /if\(!trefOpen\(a\.dataset\.tref\)\)a\.title="That thread is no longer shown on the board"/);
});
