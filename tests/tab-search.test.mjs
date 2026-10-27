// One search box over the tabs (#C356, the owner in #T963; #C363, the owner on the live board: it filtered every tab at
// once and was slow): under the tab strip, it filters the open tab's list only as the owner types, with Resolved's
// matching (name, #T number exactly, item text, any message, any case); every count stays its real total and the row
// says the open tab's matches; switching tabs clears it; Resolved keeps its reach (every resolved thread, any age); an
// empty result says "No matches.". Each key waits 150 ms for the next and redraws the open tab only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const T = 1_800_000_000_000, DAY = 864e5;
const NAMES = ["searchNow", "qMatch", "tabCounts", "tabsHtml", "laterHtml", "threadsHtml", "resolvedHtml", "renderWaiting", "renderList", "showTab"];
const msg = (thread, from, text, at, extra = {}) => ({ id: `m${at}${from}`, thread, from, text, at, ...extra });
function board() {
  const b = loadNames(NAMES);
  Object.assign(b.state, {
    waiting: [
      { id: "pots", kind: "decision", text: "Show the pottery photos?", options: [{ key: "A", label: "a" }, { key: "B", label: "b" }], since: T - 9e5 },
      { id: "pub", kind: "action", text: "Press Publish for Giovanni", steps: ["x"], since: T - 8e5 },
      { id: "l1", kind: "later", text: "Spanish wording on the intake form", since: T - 7e5 },
      { id: "l2", kind: "later", text: "Renew the pottery domain", since: T - 6e5 },
    ],
    messages: [msg("t-1", "Owner", "Can the board show ETAs?", T - 4e5), msg("t-2", "Owner", "Pottery colours", T - 2 * DAY), msg("t-2", "Manager", "Done", T - 2 * DAY + 1, { resolved: true }),
      msg("t-3", "Owner", "Old pottery question", T - 30 * DAY), msg("t-3", "Manager", "Answered", T - 30 * DAY + 1, { resolved: true })],
    threads: [{ id: "t-1", num: 961, title: "ETAs" }, { id: "t-2", num: 958, title: "Pottery colours" }, { id: "t-3", num: 77, title: "Old pottery" }],
    todo: [{ id: "x1", text: "Renew the domain", rank: 1 }, { id: "x2", text: "Pottery shelf photos", rank: 2 }],
    ideas: [{ id: "i1", text: "Weekly digest", rank: 1 }],
  });
  return b;
}

test("one box under the tab strip, above every tab; Resolved no longer holds its own", () => {
  const at = (s) => page.indexOf(s);
  assert.ok(at('id="ttabs"') < at('id="tsearch"') && at('id="tsearch"') < at('id="tp-you"'));
  assert.doesNotMatch(board().resolvedHtml(T), /<input/);
});

test("Resolved's matching: an exact #T number, or any text in the name, the item or a message, any case", () => {
  const b = board();
  assert.equal(b.qMatch("Pottery photos", "POTTERY", "x"), true);
  assert.equal(b.qMatch("anything", "", "x"), true, "no search: everything");
  assert.equal(b.qMatch("anything", "  ", "x"), true);
  assert.equal(b.qMatch("pottery", "glaze", "x"), false);
  assert.equal(b.qMatch("", "#T958", "t-2"), true);
  assert.equal(b.qMatch("", "#t95", "t-2"), false, "#T95 is not #T958");
});

test("#C363: a search filters the open tab's list only; the other tabs draw their whole lists", () => {
  const b = board();
  b.showTab("later");
  b.searchNow("pottery");
  assert.match(b.laterHtml(T), /Renew the pottery domain/);
  assert.doesNotMatch(b.laterHtml(T), /Spanish/, "the open tab: filtered");
  b.renderWaiting();
  assert.match(b.els.waiting.innerHTML, /Giovanni/, "Needs you isn't open: whole");
  b.renderList("todo");
  assert.match(b.els.todolist.innerHTML, /Renew the domain/, "To-do isn't open: whole");
  assert.match(b.resolvedHtml(T), /Pottery colours/);
  assert.doesNotMatch(b.resolvedHtml(T), /Old pottery/, "Resolved isn't open: its 7 days");
});

test("#C363: every count stays its real total while searching; the row says the open tab's matches", () => {
  const b = board();
  b.showTab("todo");
  b.searchNow("pottery");
  assert.match(b.tabsHtml(T), /Needs you <span class="tcount hot">2<\/span>/);
  assert.match(b.tabsHtml(T), /To-do <span class="tcount">2<\/span>/, "To-do's total, not its 1 match");
  assert.doesNotMatch(b.tabsHtml(T), /match|title=/);
  assert.equal(b.els.tstat.innerHTML, '1 match · <button type="button" class="tclear" data-tclear>Clear</button>');
  b.renderList("todo");
  assert.match(b.els.todolist.innerHTML, /<span class="td-n">2<\/span>[\s\S]*Pottery shelf photos/, "a row keeps its place number in the whole list");
  assert.doesNotMatch(b.els.todolist.innerHTML, /Renew the domain/);
  assert.match(b.els.todolist.innerHTML, /data-td="up"[^>]*disabled title="Clear the search to reorder"/, "▲▼ off while its list is filtered");
  b.searchNow("nothing like it");
  assert.equal(b.els.tstat.innerHTML, 'No matches. · <button type="button" class="tclear" data-tclear>Clear</button>');
  b.searchNow("");
  assert.equal(b.els.tstat.innerHTML, "", "nothing typed: nothing to say");
});

test("#C363: switching tabs clears the box, and the tab it filtered is drawn whole again", () => {
  const b = board();
  b.els.rsearch = { value: "" };
  b.showTab("later");
  b.searchNow("pottery");
  assert.equal(b.els.rsearch.value, "pottery");
  b.showTab("lead");
  assert.equal(b.els.rsearch.value, "", "cleared");
  assert.match(b.laterHtml(T), /Spanish/, "Later whole again");
  assert.match(b.threadsHtml(T), /ETAs/);
  assert.match(page, /if\(q\)\{showTab\("resolved"\);searchNow\(q\);all=find\(\)\}/, "a #T link to an old thread opens Resolved, then searches it");
});

test("#C363: each key waits for the next (one redraw for a word typed quickly), and the search text is built once per data update", () => {
  assert.match(page, /const SEARCH_WAIT=150;/);
  assert.match(page, /function setSearch\(q\)\{clearTimeout\(searchTimer\);searchTimer=setTimeout\(\(\)=>searchNow\(q\),SEARCH_WAIT\)\}/);
  assert.match(page, /function renderAll\(\)\{qText\.clear\(\);/, "every data update builds it again");
  const b = loadNames(["threadText"]);
  Object.assign(b.state, { messages: [msg("t-1", "Owner", "First", T)], threads: [] });
  assert.match(b.threadText("t-1"), /first/);
  b.state.messages.push(msg("t-1", "Manager", "Second", T + 1));
  assert.doesNotMatch(b.threadText("t-1"), /second/, "the same data update: built once, not again per key");
});
