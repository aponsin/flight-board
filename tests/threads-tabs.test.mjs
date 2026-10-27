// The Threads box takes less height (#C351, the owner's pick B in #T958 and the change in #T957): one tabbed box,
// Needs you · Later · Waiting on Manager · To-do · Ideas · Resolved (7 days), each with its count, Needs you open; the
// To-do and Ideas boxes and the Later and Resolved fold-outs are gone into it. The new-thread form is one line plus
// Attach until it is used. On a phone the tab strip scrolls sideways, keeping the open tab in view.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000;
const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const NAMES = ["tabCounts", "tabsHtml", "showTab", "renderTabs", "laterHtml", "resolvedHtml", "TABS"];
const board = (st = {}) => { const b = loadNames(NAMES); Object.assign(b.state, st); return b; };
const msg = (thread, from, text, at, extra = {}) => ({ id: `m${at}${from}`, thread, from, text, at, ...extra });

test("one box: the form, then six tabs in the owner's order, each over its list; the old boxes are gone", () => {
  const panel = page.slice(page.indexOf('id="h-threads"'), page.indexOf('id="h-init"'));
  const at = (s) => panel.indexOf(s);
  assert.ok(at('id="newthread"') > 0 && at('id="newthread"') < at('id="ttabs"'), "the form above the tabs");
  const order = ["tp-you", "tp-later", "tp-lead", "tp-todo", "tp-ideas", "tp-resolved"];
  order.forEach((p, n) => { assert.ok(at(`id="${p}"`) > at('id="ttabs"'), p); if (n) assert.ok(at(`id="${order[n - 1]}"`) < at(`id="${p}"`), p); });
  for (const [p, list] of [["tp-you", "waiting"], ["tp-later", "later"], ["tp-lead", "threads"], ["tp-todo", "todolist"], ["tp-ideas", "ideaslist"], ["tp-resolved", "resolved"]]) {
    const start = at(`id="${p}"`), end = panel.indexOf('<div id="tp-', start + 1);
    assert.ok(panel.slice(start, end < 0 ? undefined : end).includes(`id="${list}"`), `${list} in ${p}`);
  }
  assert.match(panel, /id="tp-you" role="tabpanel" aria-labelledby="tab-you">/, "Needs you shows by default");
  for (const p of order.slice(1)) assert.match(panel, new RegExp(`id="${p}" role="tabpanel" aria-labelledby="tab-${p.slice(3)}" hidden>`), `${p} hidden`);
  assert.doesNotMatch(page, /id="todobox"|id="ideasbox"|id="h-wait"|id="h-onlead"/, "no box or heading of their own any more");
  assert.ok(page.includes('id="todoadd"') && page.includes('id="ideasadd"'), "To-do and Ideas keep their add forms");
});

test("the tabs and their counts, Needs you first and open, in red when something needs the owner", () => {
  const b = board({
    waiting: [{ id: "a1", kind: "action", text: "Press it", steps: ["x"], since: T - 5 }, { id: "d1", kind: "decision", text: "Pick", options: [{ key: "A", label: "a" }, { key: "B", label: "b" }], since: T - 4 },
      { id: "l1", kind: "later", text: "Some day", since: T - 3 }, { id: "w1", kind: "decision", text: "Which?", options: [{ key: "A", label: "a" }, { key: "B", label: "b" }], since: T - 9e6, response: { status: "chose", choice: "A", at: T - 6e5 } }],
    messages: [msg("t-1", "Owner", "A question", T - 100), msg("t-2", "Owner", "Board colours", T - 864e5), msg("t-2", "Manager", "Done", T - 864e5 + 1, { resolved: true })],
    todo: [{ id: "x1", text: "Tidy", rank: 1 }, { id: "x2", text: "Gone", rank: 2, done: true }],
    ideas: [{ id: "i1", text: "Maps", rank: 1 }, { id: "i2", text: "Video", rank: 2 }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(b.tabCounts(T))), { you: 2, later: 1, lead: 2, todo: 1, ideas: 2, resolved: 1 });
  const html = b.tabsHtml(T);
  assert.deepEqual([...html.matchAll(/data-tab="(\w+)">([^<]+) <span/g)].map((m) => [m[1], m[2]]), [["you", "Needs you"], ["later", "Later"], ["lead", "Waiting on Manager"], ["todo", "To-do"], ["ideas", "Ideas"], ["resolved", "Resolved, 7 days"]]);
  assert.match(html, /id="tab-you" class="ttab on" aria-selected="true"[^>]*>Needs you <span class="tcount hot">2<\/span>/);
  assert.match(html, /id="tab-later" class="ttab" aria-selected="false"[^>]*>Later <span class="tcount">1<\/span>/);
  assert.match(board().tabsHtml(T), /Needs you <span class="tcount">0<\/span>/, "nothing needs the owner: no red");
});

test("a tab opens its own list only, and comes into view in the strip (it scrolls sideways on a phone)", () => {
  const b = board();
  const scrolled = [];
  b.els["tab-ideas"] = { scrollIntoView: (o) => scrolled.push(o), dataset: {} };
  b.showTab("ideas");
  assert.equal(b.els["tp-ideas"].hidden, false);
  for (const k of ["you", "later", "lead", "todo", "resolved"]) assert.equal(b.els[`tp-${k}`].hidden, true, k);
  assert.match(b.els.ttabs.innerHTML, /id="tab-ideas" class="ttab on" aria-selected="true"/);
  assert.deepEqual(JSON.parse(JSON.stringify(scrolled)), [{ block: "nearest", inline: "nearest" }]);
  b.showTab("nonsense");
  assert.equal(b.els["tp-ideas"].hidden, false, "an unknown tab changes nothing");
  assert.match(page, /\.ttabs\{[^}]*overflow-x:auto/, "the strip scrolls sideways");
  assert.match(page, /\.ttab\{[^}]*white-space:nowrap/, "a tab's label stays on one line");
});

test("Later is a plain list, and an empty tab says so on one line", () => {
  const b = board({ waiting: [{ id: "l1", kind: "later", text: "Some day", since: T }] });
  const html = b.laterHtml(T + 1);
  assert.match(html, /Some day/);
  assert.doesNotMatch(html, /<details class="w-item w-later"|Later \(/, "no fold-out of its own");
  assert.equal(board().laterHtml(T), '<div class="empty">Nothing for later.</div>');
});

test("Resolved holds the search box and the last 7 days' list, with no fold; empty, the search still finds older ones", () => {
  const b = board({ messages: [msg("t-2", "Owner", "Board colours", T - 864e5), msg("t-2", "Manager", "Done", T - 864e5 + 1, { resolved: true })], threads: [{ id: "t-2", num: 2, title: "Colours" }] });
  const html = b.resolvedHtml(T);
  assert.match(html, /^<div class="rsearch"><input type="search" id="rsearch"/);
  assert.match(html, /Colours/);
  assert.doesNotMatch(html, /data-id="__resolved"|Resolved threads, last 7 days/, "no fold of its own; each thread is still its own row");
  assert.match(board().resolvedHtml(T), /id="rsearch"[\s\S]*<div class="empty">None in the last 7 days\. Search finds older ones\.<\/div>/);
});

test("the form is one line plus Attach until it is used, then today's form: its hint, files and Send", () => {
  const form = page.slice(page.indexOf('<form class="newthread"'), page.indexOf("</form>", page.indexOf('<form class="newthread"')));
  assert.match(form, /<textarea id="nttext" rows="1" placeholder="Start a thread: ask Manager something, or share an idea">/);
  assert.match(page, /\.newthread:not\(:focus-within\):not\(\.has\) :is\(label,\.keys,\.btns,\.fchip,\.hint\)\{display:none\}/, "folded: no label, hint, chips or Send");
  assert.match(page, /\.newthread:not\(:focus-within\):not\(\.has\)\{flex-direction:row/, "folded: one row, the input then Attach");
  assert.match(page, /classList\.toggle\("has",!!\(String\(t\.value\|\|""\)\.trim\(\)\|\|\(pendingFiles\.get\("new"\)\|\|\[\]\)\.length\)\)/, "typed text or a file keeps it open");
});
