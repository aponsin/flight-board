// The board's redraws while the owner reads or answers (#C517, after #C504's hold: his comments and files "taking a super
// long time to refresh/clear", and "I don't want to have to press this to refresh the board"). The page's real script, a
// clock of its own and a db whose events the test sends: no bar, ever; a redraw waits only while he types in a box that
// has text, and comes by itself after the pause; a focused empty box, the pointer and a phone's touch hold nothing; his
// own writes redraw at once.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

async function page() {
  let now = 1_800_000_000_000;
  const timers = [];
  let seq = 0;
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const listeners = {}, subs = {}, els = {}, written = [];
  const fresh = (id) => ({ id, innerHTML: "", textContent: "", value: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener(type, fn) { (this.on ||= {})[type] = fn; }, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0 }) });
  const document = { getElementById: (id) => (els[id] ||= fresh(id)), querySelectorAll: () => [], querySelector: () => null, addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, activeElement: null, createRange: () => ({}) };
  const doc = (path) => ({ set: async (d) => { written.push(path); }, update: async (d) => { written.push(path); } });
  const db = { collection: (name) => ({ onSnapshot: (cb) => { subs[name] = cb; return () => {}; } }), doc };
  const window = { claude: { use: async (n) => (n === "db" ? db : null) }, scrollBy() {} };
  const ctx = { document, window, console, setInterval() {}, setTimeout: (fn, ms = 0) => { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id; }, clearTimeout: (id) => { const k = timers.findIndex((t) => t.id === id); if (k >= 0) timers.splice(k, 1); }, queueMicrotask() {}, navigator: {}, getSelection: () => ({}), Date: FakeDate, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, URLSearchParams, WeakMap, File, localStorage: { getItem: () => null, setItem() {} } };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  for (let k = 0; k < 10; k++) await null; // the live-data block subscribes
  let renders = 0;
  vm.runInContext("renderAll=()=>{globalThis.__renders()}", Object.assign(ctx, { __renders: () => renders++ }));
  const runTo = (until) => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = timers[0];
      if (!t || t.at > until) break;
      timers.shift();
      now = Math.max(now, t.at);
      t.fn();
    }
    now = Math.max(now, until);
  };
  const fire = (type, ev = {}) => { for (const fn of listeners[type] ?? []) fn(ev); };
  const inList = { closest: (s) => (s.includes("details") ? null : {}) };
  const msgs = [];
  const say = (from = "Manager") => { msgs.push({ id: "m" + msgs.length, data: () => ({ thread: "t-1", from, text: "hi", at: now }) }); subs.messages({ docs: msgs }); };
  const box = { tagName: "TEXTAREA", id: "tnote-panel-t-1", value: "", closest: () => null };
  const type = (text = "draft") => { box.value = text; fire("input", { target: box }); };
  return { ctx, document, els, subs, runTo, fire, inList, say, box, type, written, get now() { return now; }, get renders() { return renders; } };
}

test("no bar, ever: the page has no hold bar or ship pill (#C517)", () => {
  assert.ok(!/id="holdbar"|id="shipnote"|class="holdwrap"/.test(html), "the bar and the pill are gone");
  assert.ok(/id="shipline"/.test(html), "the ship line stays");
});

test("typing in a box with text holds; a pause redraws by itself within 2 s", async () => {
  const p = await page();
  p.say(); p.runTo(p.now + 500);
  assert.equal(p.renders, 1, "with nobody there, the event draws as before");
  p.document.activeElement = p.box;
  p.type();
  p.say(); p.say("Checker");
  for (let k = 0; k < 10; k++) { p.runTo(p.now + 500); p.type("draft " + k); }
  assert.equal(p.renders, 1, "five seconds of typing: nothing redrawn under him");
  const paused = p.now;
  p.runTo(paused + 2_000);
  assert.equal(p.renders, 2, "the pause: one redraw, by itself, with the box still focused");
});

test("leaving the box redraws within 2 s", async () => {
  const p = await page();
  p.document.activeElement = p.box;
  p.type();
  p.say(); p.runTo(p.now + 500);
  assert.equal(p.renders, 0);
  p.document.activeElement = null; p.fire("focusout");
  p.runTo(p.now + 2_000);
  assert.equal(p.renders, 1);
});

test("a focused empty box doesn't hold, even right after typing (the text deleted)", async () => {
  const p = await page();
  p.document.activeElement = p.box;
  p.runTo(p.now + 60_000);
  p.say(); p.runTo(p.now + 500);
  assert.equal(p.renders, 1, "focus alone holds nothing");
  p.type(""); p.say(); p.runTo(p.now + 500);
  assert.equal(p.renders, 2, "an empty box: no hold");
});

test("a box with text but no typing for a while doesn't hold", async () => {
  const p = await page();
  p.document.activeElement = p.box;
  p.type(); p.runTo(p.now + 5_000);
  p.say(); p.runTo(p.now + 500);
  assert.equal(p.renders, 1);
});

test("a thread's rename box holds while focused, paused or not; leaving it draws", async () => {
  const p = await page();
  p.document.activeElement = { tagName: "INPUT", value: "New na", closest: (s) => (s === "[data-thead]" ? {} : null) };
  p.say(); p.runTo(p.now + 30_000);
  assert.equal(p.renders, 0, "the half-typed name isn't wiped by a redraw");
  p.document.activeElement = null; p.fire("focusout"); p.runTo(p.now + 2_000);
  assert.equal(p.renders, 1);
});

test("the pointer over a list and a phone's touch or scroll hold nothing", async () => {
  const p = await page();
  p.fire("pointerover", { pointerType: "mouse", target: p.inList });
  p.say(); p.runTo(p.now + 500);
  assert.equal(p.renders, 1, "pointer over a list: drawn");
  p.fire("touchstart", { target: p.inList }); p.fire("scroll");
  p.say(); p.runTo(p.now + 500);
  assert.equal(p.renders, 2, "a phone just touched and scrolled: drawn");
});

test("the owner's own write redraws at once, even while he types in another box", async () => {
  const p = await page();
  p.document.activeElement = p.box;
  p.type();
  p.say(); p.runTo(p.now + 300);
  assert.equal(p.renders, 0, "held while typing");
  await vm.runInContext('applyWrites([{op:"set",path:"messages/x1",data:{from:OWNER}}])', p.ctx);
  p.runTo(p.now);
  assert.deepEqual(p.written, ["messages/x1"]);
  assert.equal(p.renders, 1, "his own write: drawn on the next tick, not after the pause");
  p.runTo(p.now + 5_000);
  assert.equal(p.renders, 1, "and the waiting redraw went with it");
});

test("keep(): the focused box keeps its focus through a redraw even while empty", () => {
  const ta = { tagName: "TEXTAREA", id: "tnote-panel-t-9", value: "", focus() { focused = this; } };
  let focused = null;
  const el = { querySelectorAll: (s) => (s === "textarea[id]" ? [ta] : []), contains: (x) => x === ta, scrollTop: 0 };
  const document = { getElementById: (id) => (id === ta.id ? ta : null), querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: ta, createRange: () => ({}) };
  const fresh = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }) });
  document.getElementById = (id) => (id === ta.id ? ta : fresh());
  const ctx = { document, window: { scrollY: 0, scrollTo() {} }, console, setInterval() {}, setTimeout() {}, clearTimeout() {}, queueMicrotask() {}, navigator: {}, getSelection: () => ({}), Date, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, URLSearchParams, WeakMap, File };
  vm.createContext(ctx);
  vm.runInContext(script + "\n;globalThis.__keep=keep;", ctx);
  ctx.__keep(el, () => {});
  assert.equal(focused, ta, "the empty box got its focus back");
});

test("keep(): a box's status line survives the redraw of the owner's own write", () => {
  const old = { id: "tmsg-panel-t-9", innerHTML: "Sent to Manager." }, drawn = { id: "tmsg-panel-t-9", innerHTML: "" };
  const el = { querySelectorAll: (s) => (s === ".msg[id]" ? [old] : []), contains: () => false, scrollTop: 0 };
  const fresh = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }) });
  const document = { getElementById: (id) => (id === drawn.id ? drawn : fresh()), querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const ctx = { document, window: { scrollY: 0, scrollTo() {} }, console, setInterval() {}, setTimeout() {}, clearTimeout() {}, queueMicrotask() {}, navigator: {}, getSelection: () => ({}), Date, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, URLSearchParams, WeakMap, File };
  vm.createContext(ctx);
  vm.runInContext(script + "\n;globalThis.__keep=keep;", ctx);
  ctx.__keep(el, () => {});
  assert.equal(drawn.innerHTML, "Sent to Manager.");
});
