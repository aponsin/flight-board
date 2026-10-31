// Typing never waits behind the board (#C408, the owner on page v112: characters in a thread box sometimes appeared
// late). Profiled on today's board (the mirror: about 7,000 steps, 2,000 messages, 1,000 threads, 960 asks) in Chrome:
// a keystroke's own handlers take under 1 ms, but every db snapshot, of any of the 17 collections, ran renderAll(),
// about 525 ms (median; p95 618), and a keystroke behind one waited for it. Snapshots now ask for one redraw for a burst,
// and it waits while the owner types in a box with text. The guard: 200 characters typed with events arriving, the page's real script, a
// clock of its own, renderAll costing what it costs today; no keystroke may wait over 50 ms.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const RENDER_MS = 525, KEY_EVERY = 80;

async function page() {
  let now = 1_800_000_000_000;
  const timers = [];
  let seq = 0;
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const listeners = {}, subs = {};
  const fresh = (id) => ({ id, innerHTML: "", textContent: "", value: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }) });
  const els = {};
  const document = { getElementById: (id) => (els[id] ||= fresh(id)), querySelectorAll: () => [], querySelector: () => null, addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, activeElement: null, createRange: () => ({}) };
  const db = { collection: (name) => ({ onSnapshot: (cb) => { subs[name] = cb; return () => {}; } }) };
  const window = { claude: { use: async (n) => (n === "db" ? db : null) } };
  const ctx = { document, window, console, setInterval() {}, setTimeout: (fn, ms = 0) => { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id; }, clearTimeout: (id) => { const k = timers.findIndex((t) => t.id === id); if (k >= 0) timers.splice(k, 1); }, queueMicrotask() {}, navigator: {}, getSelection: () => ({}), Date: FakeDate, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, URLSearchParams, WeakMap, File, localStorage: { getItem: () => null, setItem() {} } };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  for (let k = 0; k < 10; k++) await null; // the live-data block subscribes
  let renders = 0;
  ctx.renderAll = () => { renders++; now += RENDER_MS; }; // what a redraw costs on today's board
  // Run every timer due by `until`, each at its time; work they do moves the clock on.
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
  // A keystroke comes from the focused box, which has text (#C517: only that holds a redraw).
  const box = { id: "tnote-panel-t-1", tagName: "TEXTAREA", value: "x" };
  const type = () => { document.activeElement = box; for (const fn of listeners.input ?? []) fn({ target: box }); };
  const fire = (name) => subs[name]?.({ docs: [{ id: "d1", data: () => ({ at: now }) }] });
  return { subs, runTo, type, fire, get now() { return now; }, get renders() { return renders; } };
}

test("200 characters typed while board events arrive: no keystroke waits over 50 ms, one redraw after the pause", async () => {
  const p = await page();
  assert.ok(Object.keys(p.subs).length >= 10, "the page subscribed to the board's collections");
  const names = ["steps", "messages", "ctx", "derived", "waiting", "initiatives"];
  const start = p.now, waits = [];
  for (let i = 0; i < 200; i++) {
    const arrives = start + i * KEY_EVERY;
    p.runTo(arrives); // whatever ran before the key could be handled
    waits.push(p.now - arrives);
    p.type();
    if (i % 4 === 3) p.fire(names[(i >> 2) % names.length]);
  }
  const worst = Math.max(...waits);
  assert.ok(worst <= 50, `a keystroke waited ${worst} ms behind a redraw (${waits.filter((w) => w > 50).length} of 200 over 50 ms)`);
  assert.equal(p.renders, 0, "no redraw while typing");
  p.runTo(p.now + 2000);
  assert.equal(p.renders, 1, "the 50 events share one redraw once the owner pauses");
});

test("with nobody typing, a burst of events is one redraw, 100 ms on; a later event another", async () => {
  const p = await page();
  for (const n of ["steps", "messages", "ctx", "derived", "waiting"]) p.fire(n);
  assert.equal(p.renders, 0, "not inside the snapshot");
  p.runTo(p.now + 99);
  assert.equal(p.renders, 0);
  p.runTo(p.now + 1);
  assert.equal(p.renders, 1, "five events, one redraw");
  p.fire("steps");
  p.runTo(p.now + 200);
  assert.equal(p.renders, 2);
});

test("a redraw put off by typing comes 1.2 s after the last keystroke, not before", async () => {
  const p = await page();
  p.type();
  const typedAt = p.now;
  p.fire("messages");
  p.runTo(typedAt + 1199);
  assert.equal(p.renders, 0);
  p.runTo(typedAt + 1200);
  assert.equal(p.renders, 1);
});
