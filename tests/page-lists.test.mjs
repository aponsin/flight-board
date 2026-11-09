import test from "node:test";
import assert from "node:assert/strict";
import { openAsks, openListRows, shownListRows, doneListRows, pageHtml } from "../worker/page.mjs";

test("the page lists an ask as open only while it is neither answered nor closed (Security on v10)", () => {
  const asks = [{ id: "a" }, { id: "b", answered_at: 5 }, { id: "c", closed_at: 6 }, { id: "d", answered_at: 5, closed_at: 6 }];
  assert.deepEqual(openAsks(asks).map((a) => a.id), ["a"]);
});

test("the To-do and Ideas rows counted open are the open rows of that list", () => {
  const lists = [{ id: "1", kind: "todo", done: 0 }, { id: "2", kind: "todo", done: 1 }, { id: "3", kind: "idea", done: 0 }];
  assert.deepEqual(openListRows(lists, "todo").map((l) => l.id), ["1"]);
  assert.deepEqual(openListRows(lists, "idea").map((l) => l.id), ["3"]);
  assert.deepEqual(openListRows(undefined, "todo"), []);
});

test("a row marked done stays a tile (greyed, with Undo) until its window ends, then moves under done (Designer on v11)", () => {
  const lists = [{ id: "1", kind: "todo", done: 0 }, { id: "2", kind: "todo", done: 1 }, { id: "3", kind: "todo", done: 1 }, { id: "4", kind: "idea", done: 1 }];
  const pending = { 2: 10000, 4: 10000 };
  assert.deepEqual(shownListRows(lists, "todo", pending, 9999).map((l) => l.id), ["1", "2"]);
  assert.deepEqual(doneListRows(lists, "todo", pending, 9999).map((l) => l.id), ["3"]);
  assert.deepEqual(shownListRows(lists, "todo", pending, 10000).map((l) => l.id), ["1"]);
  assert.deepEqual(doneListRows(lists, "todo", pending, 10000).map((l) => l.id), ["2", "3"]);
  assert.deepEqual(shownListRows(lists, "idea", {}, 0), []);
  assert.deepEqual(shownListRows(undefined, "todo", undefined, 0), []);
});

test("the served page has one tab per list, 44 px buttons, an Undo window, and embeds the same functions the tests run", () => {
  const html = pageHtml({ version: "1" });
  assert.match(html, /id="tab-todo"[^>]*role="tab"/);
  assert.match(html, /id="tab-idea"[^>]*role="tab"/);
  assert.match(html, /id="tab-cards"[^>]*role="tab"/);
  assert.ok(html.indexOf('id="tab-cards"') < html.indexOf('id="tab-todo"') && html.indexOf('id="tab-todo"') < html.indexOf('id="tab-idea"'), "Cards is the first tab");
  assert.match(html, /<div id="cards"><\/div><div id="todo"><\/div><div id="ideas"><\/div>/);
  assert.ok(html.includes('let tab = "cards"'), "Cards opens by default");
  assert.ok(!html.includes("min-height:40px") && html.includes("min-height:44px"));
  assert.ok(html.includes("Done · Undo") && html.includes("UNDO_MS = 5000"));
  assert.ok(html.includes("fb-list-tab") && /try \{ const s = localStorage/.test(html));
  for (const f of [openAsks, openListRows, shownListRows, doneListRows]) assert.ok(html.includes(f.toString()));
  assert.ok(html.includes("/api/list"));
  assert.ok(html.includes("done by "));
  // Checker on v12: the 1 s redraw rebuilt the done list closed. Whether it is open lives in doneOpen (set on toggle, applied on rebuild).
  assert.ok(html.includes("doneOpen = {}") && html.includes("d.open = !!doneOpen[kind]") && html.includes("d.ontoggle = () => { doneOpen[kind] = d.open; }"));
});
