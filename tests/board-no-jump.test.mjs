// The board holds still while the owner reads or answers (#C504: he wrote in the wrong thread, as the board "keeps moving
// around as answers come in"). The page's real script, a clock of its own and a db whose events the test sends: with a
// box focused, the pointer over a list or a phone just touched, events wait and a bar counts what came; the owner done
// (the box left, the pointer off, the phone still) or a click on the bar draws it once.
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
  const listeners = {}, subs = {}, els = {};
  const fresh = (id) => ({ id, innerHTML: "", textContent: "", value: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener(type, fn) { (this.on ||= {})[type] = fn; }, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0 }) });
  const document = { getElementById: (id) => (els[id] ||= fresh(id)), querySelectorAll: () => [], querySelector: () => null, addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, activeElement: null, createRange: () => ({}) };
  const db = { collection: (name) => ({ onSnapshot: (cb) => { subs[name] = cb; return () => {}; } }) };
  const window = { claude: { use: async (n) => (n === "db" ? db : null) }, scrollBy() {} };
  const ctx = { document, window, console, setInterval() {}, setTimeout: (fn, ms = 0) => { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id; }, clearTimeout: (id) => { const k = timers.findIndex((t) => t.id === id); if (k >= 0) timers.splice(k, 1); }, queueMicrotask() {}, navigator: {}, getSelection: () => ({}), Date: FakeDate, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, URLSearchParams, WeakMap, File, localStorage: { getItem: () => null, setItem() {} } };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  for (let k = 0; k < 10; k++) await null; // the live-data block subscribes
  let renders = 0;
  vm.runInContext("renderAll=()=>{globalThis.__renders();drawnIds=heldIds()}", Object.assign(ctx, { __renders: () => renders++ }));
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
  // An element inside a list (#threads sits in #ownerpart) or outside them all.
  const inList = { closest: (s) => (s.includes("#ownerpart") ? {} : null) }, outside = { closest: () => null };
  const msgs = [];
  const say = (from = "Manager") => { msgs.push({ id: "m" + msgs.length, data: () => ({ thread: "t-1", from, text: "hi", at: now }) }); subs.messages({ docs: msgs }); };
  const box = { tagName: "TEXTAREA", id: "tnote-panel-t-1", closest: () => null };
  return { ctx, document, els, subs, runTo, fire, inList, outside, say, box, get now() { return now; }, get renders() { return renders; } };
}

test("a reply box focused: a new message neither redraws nor moves anything; the bar counts it; leaving the box draws it once", async () => {
  const p = await page();
  p.say(); p.runTo(p.now + 500);
  assert.equal(p.renders, 1, "with nobody there, the event draws as before");
  p.document.activeElement = p.box;
  p.say(); p.say("Checker");
  p.runTo(p.now + 60_000);
  assert.equal(p.renders, 1, "a minute on, still nothing redrawn while the box has focus");
  assert.equal(p.els.holdbar.hidden, false);
  assert.equal(p.els.holdbar.textContent, "2 new: show");
  p.document.activeElement = null; p.fire("focusout"); p.runTo(p.now + 1);
  assert.equal(p.renders, 2, "the box left: one redraw");
  assert.equal(p.els.holdbar.hidden, true);
});

test("the owner's own message isn't counted as new", async () => {
  const p = await page();
  p.say(); p.runTo(p.now + 500);
  p.document.activeElement = p.box;
  const owner = vm.runInContext("OWNER", p.ctx);
  p.say(owner); p.runTo(p.now + 500);
  assert.equal(p.els.holdbar.textContent, "Updated: show", "the owner's own message: not counted as new");
  p.say("Checker"); p.runTo(p.now + 500);
  assert.equal(p.els.holdbar.textContent, "1 new: show", "only the team's message counts");
});

test("a click on the bar draws now, while the box keeps its focus", async () => {
  const p = await page();
  p.say(); p.runTo(p.now + 500);
  p.document.activeElement = p.box;
  p.say(); p.runTo(p.now + 500);
  assert.equal(p.renders, 1);
  let prevented = false;
  p.els.holdbar.on.mousedown({ preventDefault: () => { prevented = true; } });
  p.els.holdbar.on.click();
  assert.equal(p.renders, 2);
  assert.ok(prevented, "the press doesn't take focus from the box");
});

test("the pointer over a list holds; off the lists, one redraw", async () => {
  const p = await page();
  p.fire("pointerover", { pointerType: "mouse", target: p.inList });
  p.say(); p.runTo(p.now + 30_000);
  assert.equal(p.renders, 0);
  p.fire("pointerover", { pointerType: "mouse", target: p.outside }); p.runTo(p.now + 1);
  assert.equal(p.renders, 1);
  p.fire("pointerover", { pointerType: "mouse", target: p.inList });
  p.say(); p.runTo(p.now + 500);
  p.fire("pointerout", { pointerType: "mouse", relatedTarget: null }); p.runTo(p.now + 1);
  assert.equal(p.renders, 2, "the pointer leaving the window counts as off");
});

test("the pointer resting on a list while a card moves on, no message: the bar says Updated (Checker)", async () => {
  const p = await page();
  p.fire("pointerover", { pointerType: "mouse", target: p.inList });
  p.subs.initiatives({ docs: [{ id: "c-1", data: () => ({ name: "A card", status: "active", phase: "checker" }) }] });
  p.runTo(p.now + 30_000);
  assert.equal(p.renders, 0, "held while the pointer rests");
  assert.equal(p.els.holdbar.hidden, false, "but never without a sign");
  assert.equal(p.els.holdbar.textContent, "Updated: show");
  p.els.holdbar.on.click();
  assert.equal(p.renders, 1);
  assert.equal(p.els.holdbar.hidden, true);
});

test("a ship starting while held shows at once, as a pill that moves nothing; it goes when the ship ends (#C505, Checker)", async () => {
  const p = await page();
  p.say(); p.runTo(p.now + 500);
  p.document.activeElement = p.box;
  p.ctx.__live = (state) => ({ v: 1, board: { at: p.now - 10e3 }, cards: { "c-1": { phase: "ship", headSha12: "a1b2c3d4e5f6" } }, agents: { Release: { state, card: "c-1", since: p.now - 60e3 } } });
  vm.runInContext('state.initRaw=[{id:"c-1",num:499,status:"active"}];probeEvent({type:"data",result:{payload:__live("working")}})', p.ctx);
  p.runTo(p.now + 500);
  assert.equal(p.renders, 1, "still held: nothing redrawn");
  assert.equal(p.els.shipnote.hidden, false);
  assert.equal(p.els.shipnote.textContent, "Don't restart: shipping");
  vm.runInContext('probeEvent({type:"data",result:{payload:__live("idle")}})', p.ctx);
  p.runTo(p.now + 500);
  assert.equal(p.els.shipnote.hidden, true, "the ship over: the pill goes");
  p.document.activeElement = null; p.fire("focusout"); p.runTo(p.now + 1);
  assert.equal(p.els.shipnote.hidden, true, "after the hold, the page's own line is the one");
});

test("a phone: a touch holds for 4 s of stillness, then the redraw comes by itself", async () => {
  const p = await page();
  p.fire("touchstart", { target: p.inList });
  const touched = p.now;
  p.say(); p.runTo(touched + 3_999);
  assert.equal(p.renders, 0);
  p.runTo(touched + 4_000);
  assert.equal(p.renders, 1);
  p.fire("touchstart", { target: p.inList }); p.runTo(p.now + 2_000);
  p.fire("scroll"); const scrolled = p.now;
  p.say(); p.runTo(scrolled + 3_999);
  assert.equal(p.renders, 1, "a scroll after a touch is reading too");
  p.runTo(scrolled + 4_000);
  assert.equal(p.renders, 2);
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
