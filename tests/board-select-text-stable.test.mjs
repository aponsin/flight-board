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
function split(h) {
  const out = []; let i = 0;
  while (i < h.length) {
    if (h[i] !== "<") { const j = h.indexOf("<", i); const t = h.slice(i, j < 0 ? h.length : j); out.push({ nodeType: 3, textContent: t }); i += t.length; continue; }
    let depth = 0, j = i; const re = /<(\/?)([a-z0-9]+)[^>]*>/gi; re.lastIndex = i; let m;
    while ((m = re.exec(h))) { if (m[1]) depth--; else if (!/^(br|hr|img|input)$/i.test(m[2])) depth++; j = re.lastIndex; if (depth === 0) break; }
    out.push({ nodeType: 1, outerHTML: h.slice(i, j) }); i = j;
  }
  return out;
}
function dom() {
  const el = { childNodes: [], replaceChild(n, o) { this.childNodes[this.childNodes.indexOf(o)] = n; }, appendChild(n) { this.childNodes.push(n); }, removeChild(n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); } };
  const document = { createElement: () => ({ content: { get childNodes() { return split(this.h); }, h: "" }, set innerHTML(v) { this.content.h = v; } }) };
  const ctx = { document }; vm.createContext(ctx); vm.runInContext(fnSrc, ctx);
  return { el, patch: (h) => vm.runInContext("patchHtml", ctx)(el, h) };
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
  const document = { getElementById: (id) => (els[id] ||= fresh(id)), querySelectorAll: () => [], querySelector: () => null, addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, activeElement: null, createRange: () => ({}) };
  const db = { collection: (name) => ({ onSnapshot: (cb) => { subs[name] = cb; return () => {}; } }), doc: () => ({ set: async () => {}, update: async () => {} }) };
  const window = { claude: { use: async (n) => (n === "db" ? db : null) }, scrollBy() {} };
  const ctx = { document, window, console, setInterval() {}, setTimeout: (fn, ms = 0) => { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id; }, clearTimeout: (id) => { const k = timers.findIndex((t) => t.id === id); if (k >= 0) timers.splice(k, 1); }, queueMicrotask() {}, navigator: {}, getSelection: () => selection, Date: FakeDate, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, URLSearchParams, WeakMap, File, localStorage: { getItem: () => null, setItem() {} } };
  vm.createContext(ctx); vm.runInContext(script, ctx);
  for (let k = 0; k < 10; k++) await null;
  let renders = 0;
  vm.runInContext("renderAll=()=>{globalThis.__renders()}", Object.assign(ctx, { __renders: () => renders++ }));
  const runTo = (until) => { for (;;) { timers.sort((a, b) => a.at - b.at || a.id - b.id); const t = timers[0]; if (!t || t.at > until) break; timers.shift(); now = Math.max(now, t.at); t.fn(); } now = Math.max(now, until); };
  const fire = (type, ev = {}) => { for (const fn of listeners[type] ?? []) fn(ev); };
  const msgs = [];
  const say = () => { msgs.push({ id: "m" + msgs.length, data: () => ({ thread: "t-1", from: "Manager", text: "hi", at: now }) }); subs.messages({ docs: msgs }); };
  return { runTo, fire, say, select: (on) => { selection = on ? { rangeCount: 1, isCollapsed: false } : { rangeCount: 0, isCollapsed: true }; }, get now() { return now; }, get renders() { return renders; }, ctx };
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
