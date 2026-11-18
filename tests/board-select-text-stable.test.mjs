// #C1229 (the owner: the board's frequent refresh breaks mouse text selection, so copying worked about one time in five). Two rules, both in the page's real script:
// (1) a redraw leaves every unchanged top-level node alone (patchHtml), so a selection in a step, a message or a cmd box lives through refreshes; (2) a redraw waits while text is
// selected or a pointer is down, and draws once that clears. patchHtml is run on a tiny stand-in DOM (a node is its html), the hold on the page's own script with a clock of its own.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// ---- (1) patchHtml on a stand-in DOM: top-level nodes are split out of the html by tag depth, a node is its outerHTML ----
const fnSrc = script.slice(script.indexOf("function patchHtml("), script.indexOf("// Re-draws a part of the page without losing"));
// A text box: it keeps its own value, cursor, selection and scroll; moving it into another row (replaceWith) takes its twin's place there; focus() makes it the active element of the current page.
let activeDoc = null;
const box = (id) => ({ id, type: "textarea", value: "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none", scrollTop: 0, owner: null,
  replaceWith(b) { const k = this.owner.boxes.indexOf(this); this.owner.boxes[k] = b; b.owner = this.owner; },
  focus() { activeDoc.activeElement = this; },
  setSelectionRange(s, e, d) { this.selectionStart = s; this.selectionEnd = e; this.selectionDirection = d; } });
function split(h) {
  const out = []; let i = 0;
  while (i < h.length) {
    if (h[i] !== "<") { const j = h.indexOf("<", i); const t = h.slice(i, j < 0 ? h.length : j); out.push({ nodeType: 3, textContent: t }); i += t.length; continue; }
    let depth = 0, j = i; const re = /<(\/?)([a-z0-9]+)[^>]*>/gi; re.lastIndex = i; let m;
    while ((m = re.exec(h))) { if (m[1]) depth--; else if (!/^(br|hr|img|input)$/i.test(m[2])) depth++; j = re.lastIndex; if (depth === 0) break; }
    const outer = h.slice(i, j), boxes = [...outer.matchAll(/<(?:textarea|input)[^>]*id="([^"]+)"/g)].map((b) => box(b[1])); const node = { nodeType: 1, outerHTML: outer, boxes, querySelectorAll() { return this.boxes; } }; boxes.forEach((b) => { b.owner = node; }); out.push(node); i = j;
  }
  return out;
}
function dom() {
  const el = { childNodes: [], replaceChild(n, o) { this.childNodes[this.childNodes.indexOf(o)] = n; }, appendChild(n) { this.childNodes.push(n); }, removeChild(n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); } };
  const document = { activeElement: null, createElement: () => ({ content: { get childNodes() { return split(this.h); }, h: "" }, set innerHTML(v) { this.content.h = v; } }) };
  activeDoc = document;
  const ctx = { document }; vm.createContext(ctx); vm.runInContext(fnSrc, ctx);
  return { el, ctx, patch: (h) => vm.runInContext("patchHtml", ctx)(el, h) };
}
const step = (n) => `<details data-id="c${n}"><summary>c${n}</summary><ol class="steps"><li>step ${n}<div class="cmd"><code>node a.mjs ${n}</code><button class="copy" data-copy="x">Copy</button></div></li></ol></details>`;
const msg = (n, t) => `<div class="msg" id="m${n}"><b>Manager</b> ${t}</div>`;

test("an unchanged step, message and cmd box are the same nodes after two refreshes; only the changed one is replaced", () => {
  const { el, patch } = dom();
  const draw = (tick) => step(1) + msg(1, "hello") + step(2) + msg(2, `tick ${tick}`);
  patch(draw(0));
  const [s1, m1, s2, m2] = el.childNodes;
  patch(draw(1)); patch(draw(2));
  assert.equal(el.childNodes[0], s1, "the step (with its cmd box and Copy button) is the same node");
  assert.equal(el.childNodes[1], m1, "the message is the same node");
  assert.equal(el.childNodes[2], s2);
  assert.notEqual(el.childNodes[3], m2, "the row whose words changed is drawn again");
  assert.match(el.childNodes[3].outerHTML, /tick 2/);
});

test("a fold the owner opened (the live node differs from what was drawn) does not make a row look changed; a new row is added and a gone one removed", () => {
  const { el, patch } = dom();
  patch(step(1) + step(2));
  const [a] = el.childNodes;
  a.outerHTML = a.outerHTML.replace("<details ", "<details open ");
  patch(step(1) + step(2));
  assert.equal(el.childNodes[0], a, "kept, open as the owner left it");
  patch(step(1) + step(2) + step(3));
  assert.equal(el.childNodes.length, 3);
  patch(step(2));
  assert.deepEqual(el.childNodes.map((n) => n.outerHTML.match(/data-id="(c\d)"/)[1]), ["c2"], "rows are matched by place: the row at 0 now draws c2");
});

test("a text node and an element in the same place are replaced, never matched", () => {
  const { el, patch } = dom();
  patch("plain");
  const t = el.childNodes[0];
  patch("<p>x</p>");
  assert.notEqual(el.childNodes[0], t);
  assert.equal(el.childNodes[0].outerHTML, "<p>x</p>");
});

test("without a DOM to patch (a bare element), the html is written as before", () => {
  const ctx = { document: {} }; vm.createContext(ctx); vm.runInContext(fnSrc, ctx);
  const el = { innerHTML: "" };
  vm.runInContext("patchHtml", ctx)(el, "<b>x</b>");
  assert.equal(el.innerHTML, "<b>x</b>");
});

test("the busy parts draw through patchHtml: the board, the done list, the threads, Needs you, the team notes and the resolved list", () => {
  for (const re of [/patchHtml\(\$\("board"\)/, /patchHtml\(\$\("doneboard"\)/, /patchHtml\(el,threadsHtml/, /patchHtml\(el,queueHtml/, /patchHtml\(el,teamHtml/, /patchHtml\(el,resolvedHtml/]) assert.match(script, re, String(re));
});

// ---- (2) the hold, on the page's own script ----
async function page() {
  let now = 1_800_000_000_000, seq = 0;
  const timers = [], listeners = {}, subs = {}, els = {};
  let selection = { rangeCount: 0, isCollapsed: true };
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const fresh = (id) => ({ id, innerHTML: "", textContent: "", value: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0 }) });
  const document = { getElementById: (id) => (els[id] ||= fresh(id)), querySelectorAll: (s) => (s === "details[data-id]" ? rows : []), querySelector: () => null, addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, activeElement: null, createRange: () => ({}) };
  const db = { collection: (name) => ({ onSnapshot: (cb) => { subs[name] = cb; return () => {}; } }), doc: () => ({ set: async () => {}, update: async () => {} }) };
  const rows = [], scrolls = [], window = { innerHeight: 800, claude: { use: async (n) => (n === "db" ? db : null) }, scrollBy(x, y) { scrolls.push(y); } }; let onRender = null;
  const ctx = { document, window, console, setInterval() {}, setTimeout: (fn, ms = 0) => { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id; }, clearTimeout: (id) => { const k = timers.findIndex((t) => t.id === id); if (k >= 0) timers.splice(k, 1); }, queueMicrotask() {}, navigator: {}, getSelection: () => selection, Date: FakeDate, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, URLSearchParams, WeakMap, File, localStorage: { getItem: () => null, setItem() {} } };
  vm.createContext(ctx); vm.runInContext(script, ctx);
  for (let k = 0; k < 10; k++) await null;
  let renders = 0;
  vm.runInContext("renderAll=()=>{globalThis.__renders()}", Object.assign(ctx, { __renders: () => { renders++; if (onRender) onRender(); } }));
  const runTo = (until) => { for (;;) { timers.sort((a, b) => a.at - b.at || a.id - b.id); const t = timers[0]; if (!t || t.at > until) break; timers.shift(); now = Math.max(now, t.at); t.fn(); } now = Math.max(now, until); };
  const fire = (type, ev = {}) => { for (const fn of listeners[type] ?? []) fn(ev); };
  const msgs = [];
  const say = () => { msgs.push({ id: "m" + msgs.length, data: () => ({ thread: "t-1", from: "Manager", text: "hi", at: now }) }); subs.messages({ docs: msgs }); };
  return { runTo, fire, say, select: (on) => { selection = on ? { rangeCount: 1, isCollapsed: false } : { rangeCount: 0, isCollapsed: true }; }, get now() { return now; }, get renders() { return renders; }, ctx, rows, scrolls, onRender: (f) => { onRender = f; } };
}

test("a redraw waits while text is selected, and draws once the selection clears", async () => {
  const p = await page();
  p.select(true); p.say(); p.runTo(p.now + 5000);
  assert.equal(p.renders, 0, "nothing redrawn under a selection, however long it stays");
  p.select(false); p.runTo(p.now + 300);
  assert.equal(p.renders, 1, "drawn once, with the newest state, when the selection clears");
});

test("a redraw waits while a pointer is down (a drag in progress), and draws after the pointer is up", async () => {
  const p = await page();
  p.fire("pointerdown"); p.say(); p.runTo(p.now + 3000);
  assert.equal(p.renders, 0, "no redraw mid-drag");
  p.fire("pointerup"); p.runTo(p.now + 300);
  assert.equal(p.renders, 1);
});

test("a pointer that was cancelled or whose window lost focus does not hold the board for ever", async () => {
  for (const end of ["pointercancel", "mouseup", "dragend", "blur"]) {
    const p = await page();
    p.fire("mousedown"); p.say(); p.runTo(p.now + 1000);
    assert.equal(p.renders, 0, end);
    p.fire(end); p.runTo(p.now + 300);
    assert.equal(p.renders, 1, `${end} lets the redraw go`);
  }
});

test("a collapsed caret (a click, no selection) holds nothing: the board redraws as before", async () => {
  const p = await page();
  p.say(); p.runTo(p.now + 500);
  assert.equal(p.renders, 1);
});

// ---- (3) a text box in a row that did change ----
const row = (n, word) => `<div data-id="t${n}"><b>${word}</b><textarea id="note-t${n}"></textarea></div>`;

test("a text box with focus, or with unsent text, in a row that changed is the same element afterwards: value, cursor, selection and scroll intact, still focused", () => {
  const { el, ctx, patch } = dom();
  patch(row(1, "one") + row(2, "x") + row(3, "z"));
  const [r1, r2, r3] = el.childNodes;
  const focused = r1.boxes[0], unsent = r2.boxes[0];
  Object.assign(focused, { value: "line one\nline two\nline three", selectionStart: 4, selectionEnd: 13, selectionDirection: "backward", scrollTop: 40 });
  unsent.value = "unsent words";
  ctx.document.activeElement = focused;
  patch(row(1, "two") + row(2, "y") + row(3, "z"));
  assert.notEqual(el.childNodes[0], r1, "the row did change, so it is drawn again");
  assert.equal(el.childNodes[0].boxes[0], focused, "the box with focus is the very same element in the new row");
  assert.equal(ctx.document.activeElement, focused, "and it still has focus");
  assert.deepEqual([focused.value, focused.selectionStart, focused.selectionEnd, focused.selectionDirection, focused.scrollTop], ["line one\nline two\nline three", 4, 13, "backward", 40], "value, cursor, selection and scroll are as they were");
  assert.equal(el.childNodes[1].boxes[0], unsent, "a box with unsent text is carried too");
  assert.equal(unsent.value, "unsent words");
  assert.equal(el.childNodes[2], r3, "the unchanged row was not touched at all");
});

test("an empty box without focus is not carried (the fresh one is used), and a box whose twin is gone is left behind", () => {
  const { el, patch } = dom();
  patch(row(1, "one") + row(2, "x"));
  const [r1, r2] = el.childNodes, empty = r1.boxes[0], full = r2.boxes[0];
  full.value = "typed";
  patch(row(1, "two") + `<div data-id="t2"><b>y</b></div>`);
  assert.notEqual(el.childNodes[0].boxes[0], empty, "nothing to keep in an empty, unfocused box");
  assert.equal(el.childNodes[1].boxes.length, 0, "the new row has no such box, so nothing is carried into it");
});

test("the keep() and Needs you restores do not set a value or the focus again when the box is already as it was", () => {
  assert.match(script, /if\(t\.value!==v\)t\.value=v;fitBox\(t\)/);
  assert.match(script, /if\(t&&document\.activeElement!==t\)\{t\.focus\(\)/);
  assert.match(script, /if\(x\.value!==v\)x\.value=v;fitBox\(x\)/);
  assert.match(script, /if\(x&&document\.activeElement!==x\)\{x\.focus\(\)/);
});

// ---- (4) the page does not jump: the row being read keeps its place on screen when content above it grows ----
const fakeRow = (id, top, height = 300) => ({ dataset: { id }, offsetParent: {}, isConnected: true, top, getBoundingClientRect() { return { top: this.top, bottom: this.top + height }; }, closest() { return null; } });

test("a redraw that adds content above the viewport scrolls by the same amount: the row in view keeps its screen position", async () => {
  const p = await page();
  const above = fakeRow("c1", -500), reading = fakeRow("c2", 120);
  p.rows.push(above, reading);
  p.onRender(() => { reading.top += 160; }); // a row above grew by 160 px: what he reads moved down
  p.say(); p.runTo(p.now + 500);
  assert.equal(p.renders, 1);
  assert.deepEqual(p.scrolls, [160], "scrolled by exactly the shift, so the row is back where it was");
});

test("the anchor is the row he last pointed at while it is on screen, else the topmost row in view (never one scrolled off)", async () => {
  const p = await page();
  const off = fakeRow("c1", -900), top = fakeRow("c2", -50), under = fakeRow("c3", 400);
  p.rows.push(off, top, under);
  p.onRender(() => { off.top += 100; top.top += 100; under.top += 100; });
  p.say(); p.runTo(p.now + 500);
  assert.deepEqual(p.scrolls, [100], "the topmost row in view (c2, partly scrolled) is the anchor, not c1 which is off screen");
  p.fire("pointerover", { target: { closest: () => under } });
  p.onRender(() => { top.top += 30; under.top += 70; });
  p.say(); p.runTo(p.now + 500);
  assert.deepEqual(p.scrolls, [100, 70], "the row under the pointer is the one kept in place");
  under.top = 2000;
  p.onRender(() => { top.top += 25; under.top += 5; });
  p.say(); p.runTo(p.now + 500);
  assert.deepEqual(p.scrolls, [100, 70, 25], "off screen, so the topmost row in view anchors again");
});

test("a redraw that moves nothing does not scroll", async () => {
  const p = await page();
  p.rows.push(fakeRow("c1", 120));
  p.say(); p.runTo(p.now + 500);
  assert.equal(p.renders, 1);
  assert.deepEqual(p.scrolls, []);
});

test("the ship redraw every 15 s is anchored too", () => {
  assert.match(script, /anchored\(renderBoard\)/);
  assert.match(script, /function renderAnchored\(\)\{anchored\(renderAll\)\}/);
});
