// #C1299 (the owner's pick A on the group controls): the page draws a group as "#G12 · its name" with a Rename on the store page; the open list is ONE order list where a single
// card the owner placed sits between groups and has its own arrows; every open card has a Move to... (the open groups of its repository, then "New group...") whose answers are asked in
// a dialog: a name for a new group, "Move anyway" or "Cancel" for a group in review. All of it is the store page's only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";
const TEMPLATE = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");

const NAMES = ["groupLabel", "groupNameRows", "groupNameOf", "groupOrderRows", "groupCmp", "groupMoveButtons", "slotKey", "groupList", "groupRow", "singleControls", "moveToSelect", "groupsForMove", "askDialog", "renderBoard", "initRow", "gates", "enrich"];
function board(initRaw, meta = [], host = "store", answers = {}) {
  const els = {}, listeners = {}, calls = [], dialogs = [];
  const el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", value: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }) });
  // A fake dialog: the page's askDialog builds it with createElement and appends it; the test presses a button by calling the dialog's click listener.
  const createElement = () => { const d = { dataset: {}, innerHTML: "", handlers: {}, input: null, setAttribute() {}, addEventListener(t, f) { d.handlers[t] = f; }, remove() { d.removed = true; }, focus() {}, querySelector(s) { if (s !== "input") return { focus() {} }; return /<input/.test(d.innerHTML) ? (d.input ||= { value: answers.name ?? "", focus() {} }) : null; } }; dialogs.push(d); return d; };
  const document = { documentElement: { getAttribute: () => host }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener(t, f) { (listeners[t] ||= []).push(f); }, activeElement: null, createRange: () => ({}), createElement, body: { appendChild(d) { d.appended = true; } } };
  const replies = [];
  const fetch = async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); const r = replies.length ? replies.shift() : { status: 200, j: { ok: true } }; return { ok: r.status < 300, status: r.status, json: async () => r.j }; };
  const b = loadNames(NAMES, { document, fetch, setTimeout: () => 0 });
  Object.assign(b.state, { initRaw, initiatives: initRaw.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [], meta });
  return { ...b, els, listeners, calls, dialogs, replies };
}
const card = (id, num, fields = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", who: "Boardsmith", repo: "flight-board", createdAt: 1_800_000_000_000 + num * 60e3, ...fields });
const names = (...rows) => ({ id: "groupNames", rows: rows.map(([batch, num, name]) => ({ batch, num, name })) });
const order = (...keys) => ({ id: "groupOrder", rows: keys.map((batch, i) => ({ batch, pos: i + 1 })) });
const press = (d, what) => d.handlers.click({ target: { closest: (s) => (s === `[data-${what}]` ? {} : null) } });
// A change on a Move to select, as the page's own listener reads it.
const choose = async (b, id, value) => { const s = { dataset: { moveto: id }, value, disabled: false, options: [{ textContent: "Move to…" }], closest() { return this; } }; for (const f of b.listeners.change ?? []) await f({ target: s }); return s; };
const tick = () => new Promise((r) => setImmediate(r));

test("a group with a name reads '#G12 · name', one with only a number keeps its batch words, and the owner's text is escaped everywhere", () => {
  const b = board([card("a", 1, { batch: "g3-urgent" }), card("b", 2, { batch: "g4-other" }), card("c", 3, { batch: "plain" })], [names(["g3-urgent", 7, "Fix <b>it</b> now"], ["g4-other", 8, null], ["plain", 9, null])]);
  assert.equal(b.groupLabel("g3-urgent"), "#G7 · Fix <b>it</b> now");
  assert.equal(b.groupLabel("g4-other"), "#G8 · Other");
  assert.equal(b.groupLabel("plain"), "#G9 · plain");
  assert.equal(b.groupLabel("g9-unknown-to-the-store"), "G9 · Unknown to the store", "a group the store has not numbered reads as before");
  b.renderBoard();
  const h = b.els.board.innerHTML;
  assert.doesNotMatch(h, /<b>it<\/b>/, "the name is never markup");
  assert.match(h, /Fix &lt;b&gt;it&lt;\/b&gt; now/);
});

test("the open list is ONE order list: a single card the owner placed sits between groups, a card with no place of its own stays last", () => {
  const b = board([card("a", 1, { batch: "g1-a" }), card("b", 2, { batch: "g2-b" }), card("s", 3), card("u", 4)], [order("g1-a", "c:s", "g2-b")]);
  const list = b.groupList(b.state.initiatives);
  assert.deepEqual([...list.map((x) => x.group ?? x.card.id)], ["g1-a", "s", "g2-b", "u"]);
  assert.equal(list[1].slot, "c:s");
  assert.equal(list[3].slot, undefined, "u has no place of its own");
  const none = board([card("a", 1, { batch: "g1-a" }), card("s", 3)], []);
  assert.deepEqual([...none.groupList(none.state.initiatives).map((x) => x.group ?? x.card.id)], ["g1-a", "s"], "with no order set it is as before: groups, then loose cards");
});

test("a single card has its own arrows and a Move to; the first and last places disable their arrow; a card with no place has no down; the artifact page has none", () => {
  const cards = [card("a", 1, { batch: "g1-a" }), card("s", 3), card("u", 4), card("b", 2, { batch: "g2-b" })];
  const b = board(cards, [order("g1-a", "c:s", "g2-b")]);
  b.renderBoard();
  const h = b.els.board.innerHTML;
  assert.match(h, /data-gmove="c:s" data-dir="up" aria-label="Move card #C3 up, it goes live earlier">/);
  assert.match(h, /data-gmove="c:s" data-dir="down"[^>]*>/);
  assert.doesNotMatch(h, /data-gmove="c:s" data-dir="up"[^>]*disabled/, "the middle place can go up");
  assert.match(h, /data-gmove="c:u" data-dir="down"[^>]*disabled/, "a card with no place has no down");
  assert.doesNotMatch(h, /data-gmove="c:u" data-dir="up"[^>]*disabled/, "but its up puts it at the end of the list and moves it");
  assert.match(h, /data-gmove="g1-a" data-dir="up"[^>]*disabled/, "the first place cannot go up");
  assert.match(h, /data-gmove="g2-b" data-dir="down"[^>]*disabled/, "the last placed place cannot go down");
  assert.match(h, /<span class="g-place">2 of 3<\/span>/, "groups and placed single cards count as one list");
  const art = board(cards, [order("g1-a", "c:s", "g2-b")], "artifact");
  art.renderBoard();
  assert.doesNotMatch(art.els.board.innerHTML, /data-gmove|data-moveto|data-gren/, "the artifact page has none of the controls");
});

test("Move to lists the open groups of the card's repository (not its own, not another repository's), then New group...; every open card has one on the store page", () => {
  const cards = [card("a", 1, { batch: "g1-a" }), card("b", 2, { batch: "g2-b" }), card("p", 3, { batch: "g5-prod", repo: "platform" }), card("s", 4), card("d", 5, { status: "done" })];
  const b = board(cards, [names(["g1-a", 1, "Alpha"], ["g2-b", 2, null], ["g5-prod", 3, null])]);
  assert.deepEqual([...b.groupsForMove(b.state.initiatives.find((i) => i.id === "a"))], ["g2-b"]);
  assert.deepEqual([...b.groupsForMove(b.state.initiatives.find((i) => i.id === "s"))], ["g1-a", "g2-b"], "a single card can join either board group");
  const sel = b.moveToSelect(b.state.initiatives.find((i) => i.id === "s"));
  assert.match(sel, /<option value="g1-a">#G1 · Alpha<\/option><option value="g2-b">#G2 · B<\/option><option value="__new">New group…<\/option>/);
  assert.doesNotMatch(sel, /g5-prod/, "another repository's group is not offered");
  assert.equal(b.moveToSelect(b.state.initiatives.find((i) => i.id === "d")), "", "a done card has none");
  b.renderBoard();
  const h = b.els.board.innerHTML;
  assert.equal((h.match(/data-moveto="/g) || []).length, 4, "a, b, p and s; not the done card");
});

test("choosing a group posts {id, batch}; New group... asks a name first and posts {id, new_name}; an empty or cancelled name posts nothing", async () => {
  const b = board([card("s", 4), card("a", 1, { batch: "g1-a" })], [], "store", { name: "Solo work" });
  await choose(b, "s", "g1-a");
  assert.deepEqual(b.calls, [["/api/move-to-group", { id: "s", batch: "g1-a" }]]);
  const t = choose(b, "s", "__new");
  await tick();
  assert.equal(b.dialogs.length, 1);
  assert.match(b.dialogs[0].innerHTML, /Name the new group/);
  assert.match(b.dialogs[0].innerHTML, /maxlength="60"/);
  press(b.dialogs[0], "yes");
  await t;
  assert.deepEqual(b.calls[1], ["/api/move-to-group", { id: "s", new_name: "Solo work" }]);
  const c = board([card("s", 4)], [], "store", { name: "" });
  const t2 = choose(c, "s", "__new");
  await tick();
  press(c.dialogs[0], "yes");
  await t2;
  assert.deepEqual(c.calls, [], "an empty name posts nothing");
  const d = board([card("s", 4)], [], "store", { name: "x" });
  const t3 = choose(d, "s", "__new");
  await tick();
  press(d.dialogs[0], "no");
  await t3;
  assert.deepEqual(d.calls, [], "Cancel posts nothing");
});

test("a group in review answers 409: the dialog says so, Move anyway posts again with confirm, Cancel posts nothing more", async () => {
  const warn = { status: 409, j: { ok: false, warn: "in-review", message: "This group is in review: adding a card restarts its review" } };
  const b = board([card("s", 4), card("a", 1, { batch: "g1-a" })]);
  b.replies.push(warn);
  const t = choose(b, "s", "g1-a");
  await tick();
  assert.match(b.dialogs[0].innerHTML, /This group is in review: adding a card restarts its review/);
  assert.match(b.dialogs[0].innerHTML, /Move anyway/);
  assert.match(b.dialogs[0].innerHTML, /Cancel/);
  press(b.dialogs[0], "yes");
  await t;
  assert.deepEqual(b.calls, [["/api/move-to-group", { id: "s", batch: "g1-a" }], ["/api/move-to-group", { id: "s", batch: "g1-a", confirm: true }]]);
  const c = board([card("s", 4), card("a", 1, { batch: "g1-a" })]);
  c.replies.push(warn);
  const t2 = choose(c, "s", "g1-a");
  await tick();
  press(c.dialogs[0], "no");
  await t2;
  assert.equal(c.calls.length, 1, "Cancel leaves it at the first, refused post");
});

test("Rename asks for the name (prefilled with the current one) and posts {batch, name}; the group header carries the Rename button on the store page only", async () => {
  const b = board([card("a", 1, { batch: "g1-a" })], [names(["g1-a", 1, "Alpha"])], "store", { name: "Beta" });
  b.renderBoard();
  assert.match(b.els.board.innerHTML, /<button type="button" class="g-ren" data-gren="g1-a" aria-label="Rename group #G1 · Alpha">Rename<\/button>/);
  const click = b.listeners.click.find((f) => /data-gren/.test(String(f)));
  assert.ok(click, "the page listens for it");
  const btn = { dataset: { gren: "g1-a" }, disabled: false, textContent: "Rename" };
  const t = click({ target: { closest: (s) => (s === "[data-gren]" ? btn : null) } });
  await tick();
  assert.match(b.dialogs[0].innerHTML, /value="Alpha"/, "prefilled with the current name");
  press(b.dialogs[0], "yes");
  await t;
  assert.deepEqual(b.calls, [["/api/group-rename", { batch: "g1-a", name: "Beta" }]]);
  const art = board([card("a", 1, { batch: "g1-a" })], [names(["g1-a", 1, "Alpha"])], "artifact");
  art.renderBoard();
  assert.doesNotMatch(art.els.board.innerHTML, /data-gren/);
});

test("the dialog's one innerHTML sink writes the owner's text escaped: a group named with markup and quotes shows as text in the Rename box and in the label", async () => {
  const hostile = `A"><img src=x onerror=1> & <b>`;
  const b = board([card("a", 1, { batch: "g1-a" })], [names(["g1-a", 1, hostile])]);
  b.renderBoard();
  const h = b.els.board.innerHTML;
  assert.doesNotMatch(h, /<img/);
  assert.doesNotMatch(h, /aria-label="Rename group [^"]*"[^>]*onerror/);
  const click = b.listeners.click.find((f) => /data-gren/.test(String(f)));
  const t = click({ target: { closest: (s) => (s === "[data-gren]" ? { dataset: { gren: "g1-a" }, disabled: false, textContent: "Rename" } : null) } });
  await tick();
  assert.doesNotMatch(b.dialogs[0].innerHTML, /<img|<b>/, "no raw markup in the dialog");
  assert.match(b.dialogs[0].innerHTML, /value="A&quot;&gt;&lt;img src=x onerror=1&gt; &amp; &lt;b&gt;"/);
  press(b.dialogs[0], "no");
  await t;
  assert.deepEqual(b.calls, []);
});

test("Designer's trim: the 'Waiting on <decision>' words sit in .wo with their full text as the title, and a phone shows one line of about 60 characters with an ellipsis", () => {
  const m = /@media \(max-width:760px\)\{select\.mv\{max-width:100%\}[\s\S]*?\.i-meta \.wo b\{([^}]*)\}/.exec(TEMPLATE);
  assert.ok(m, "the phone rule for .i-meta .wo b is in the page");
  for (const part of ["max-width:min(60ch,100%)", "overflow:hidden", "text-overflow:ellipsis", "white-space:nowrap"]) assert.ok(m[1].includes(part), part);
  assert.match(TEMPLATE, /<span class="wo">Waiting on <b title="\$\{esc\(i\.waitingOn\)\}">\$\{esc\(i\.waitingOn\)\}<\/b><\/span>/);
});
