// One search box over all six tabs (#C356, the owner in #T963): under the tab strip, it filters the open tab's list as
// the owner types, with Resolved's matching (name, #T number exactly, item text, any message, any case). While a search
// is typed each tab's count is its matches; Resolved keeps its reach (every resolved thread, any age); the text stays
// when the tab changes; an empty result says "No matches.".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const T = 1_800_000_000_000, DAY = 864e5;
const NAMES = ["setSearch", "qMatch", "tabCounts", "laterHtml", "threadsHtml", "resolvedHtml", "renderWaiting", "renderList", "showTab"];
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
  assert.match(page, /<div class="rsearch" id="tsearch"><input type="search" id="rsearch" placeholder="Search: name, #T number, any word" aria-label="Search the open tab" autocomplete="off"><\/div>/);
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

test("a search filters every tab's list, and each tab's count becomes its matches", () => {
  const b = board();
  b.setSearch("pottery");
  assert.deepEqual(JSON.parse(JSON.stringify(b.tabCounts(T))), { you: 1, later: 1, lead: 0, todo: 1, ideas: 0, resolved: 2 }, "Resolved reaches every age");
  b.renderWaiting();
  assert.match(b.els.waiting.innerHTML, /Show the pottery photos/);
  assert.doesNotMatch(b.els.waiting.innerHTML, /Giovanni/);
  assert.match(b.laterHtml(T), /Renew the pottery domain/);
  assert.doesNotMatch(b.laterHtml(T), /Spanish/);
  assert.equal(b.threadsHtml(T), '<div class="empty">No matches.</div>');
  b.renderList("ideas");
  assert.equal(b.els.ideaslist.innerHTML, '<div class="empty">No matches.</div>');
  b.renderList("todo");
  assert.match(b.els.todolist.innerHTML, /<span class="td-n">2<\/span>[\s\S]*Pottery shelf photos/, "a row keeps its place number in the whole list");
  assert.doesNotMatch(b.els.todolist.innerHTML, /Renew the domain/);
  assert.match(b.resolvedHtml(T), /Pottery colours[\s\S]*Old pottery/);
});

test("the text stays when the tab changes; clearing it brings every list and count back", () => {
  const b = board();
  b.setSearch("#T961");
  b.showTab("lead");
  assert.equal(b.tabCounts(T).lead, 1, "still searching after the tab changed");
  assert.match(b.threadsHtml(T), /ETAs/);
  b.setSearch("");
  assert.deepEqual(JSON.parse(JSON.stringify(b.tabCounts(T))), { you: 2, later: 2, lead: 1, todo: 2, ideas: 1, resolved: 1 }, "Resolved back to its 7 days");
});
