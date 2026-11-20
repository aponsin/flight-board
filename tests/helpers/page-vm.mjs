// The page's real script, run in a vm with a stand-in document, and a board-sized fixture (#C1350). Used by the render budget test and by anyone profiling a redraw.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../../page/board.template.html", import.meta.url), "utf8");
export const SCRIPT = html.match(/<script>([\s\S]*?)<\/script>/)[1];
export const T0 = 1_800_000_000_000;
const DAY = 864e5, MIN = 60e3;

export async function loadPage({ now = T0, script = SCRIPT } = {}) {
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const listeners = {}, subs = {};
  const fresh = (id) => ({ id, innerHTML: "", textContent: "", value: "", hidden: false, children: [], style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [], querySelector: () => null, closest: () => null, dataset: {}, setAttribute() {}, getAttribute: () => null, appendChild() {}, append() {}, prepend() {}, remove() {}, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 0, width: 0 }), contains: () => false });
  const els = {};
  const document = { documentElement: { getAttribute: () => "store" }, body: fresh("body"), getElementById: (id) => (els[id] ||= fresh(id)), querySelectorAll: () => [], querySelector: () => null, addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, activeElement: null, createRange: () => ({}), createElement: () => fresh("x") };
  const db = { collection: (name) => ({ onSnapshot: (cb) => { subs[name] = cb; return () => {}; } }) };
  const window = { claude: { use: async (n) => (n === "db" ? db : null) }, innerHeight: 900, scrollBy() {}, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  const timers = [];
  const ctx = { document, window, console, setInterval() {}, setTimeout: (fn) => timers.push(fn), clearTimeout() {}, queueMicrotask() {}, navigator: {}, getSelection: () => ({}), Date: FakeDate, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, URLSearchParams, WeakMap, WeakSet, File, performance, RegExp, Promise, Symbol, Error, localStorage: { getItem: () => null, setItem() {} }, history: { replaceState() {} }, location: { hash: "", search: "", href: "https://board.test/" } };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  for (let k = 0; k < 10; k++) await null;
  return { ctx, els, timers, run: (code) => vm.runInContext(code, ctx), setNow: (t) => { now = t; }, listeners, subs };
}

// A board the size of the live one on 2026-11-20 (Manager's measure: about 1,000 threads, 2,000 to 3,000 messages, about 960 asks, 7,000 steps, 300 cards), fictional text.
export function fixture({ threads = 1000, perThread = 3, asks = 960, cards = 300, steps = 7000, now = T0 } = {}) {
  const messages = [], waiting = [], initRaw = [], stepRows = [];
  for (let i = 0; i < cards; i++) {
    const open = i >= cards - 30, id = `card-${i}`;
    initRaw.push({ id, num: 1000 + i, name: `Card number ${i} of the board`, size: "S", level: "Quick", status: open ? "active" : "done", phase: open ? "build" : "live", who: "Boardsmith", repo: "flight-board", batch: open ? `g${1 + (i % 4)}-group` : null, branch: open ? `build/${id}` : null, createdAt: now - (cards - i) * 3600e3, doneAt: open ? null : now - (cards - i) * 1800e3, version: open ? null : `v1.${i}`, thread: `t-${1_799_000_000_000 + i}` });
  }
  for (let i = 0; i < asks; i++) {
    const done = i < asks - 25;
    waiting.push({ id: `ask-${i}`, kind: i % 5 === 0 ? "action" : "decision", text: `Ask ${i}: which way, A or B?`, since: now - (asks - i) * 20 * MIN, done, ...(done ? { doneAt: now - (asks - i) * 10 * MIN, response: { status: "answered", at: now - (asks - i) * 10 * MIN } } : {}), initiative: `card-${i % cards}`, thread: i % 7 === 0 ? `t-${1_799_000_000_000 + (i % threads)}` : undefined });
  }
  const ids = [];
  for (let i = 0; i < threads; i++) {
    const id = i < asks ? `ask-${i}` : `t-${1_799_000_000_000 + i}`; ids.push(id);
    const at0 = now - (threads - i) * 40 * MIN, open = i >= threads - 12;
    for (let k = 0; k < perThread; k++) messages.push({ id: `m${i}-${k}`, thread: id, from: k % 2 ? "Manager" : "Owner", text: `message ${k} of thread ${i}: some words about the card`, at: at0 + k * 1000, ...(k === perThread - 1 && !open ? { resolved: true } : {}) });
  }
  for (let i = 0; i < steps; i++) stepRows.push({ id: `s${i}`, init: `card-${i % cards}`, phase: ["build", "checker", "security", "ship"][i % 4], who: "Boardsmith", kind: i % 2 ? "end" : "start", at: now - (steps - i) * 5 * MIN, wait: "busy" });
  return { messages, waiting, initRaw, steps: stepRows, todo: [], ideas: [], threads: ids.map((id, i) => ({ id, num: 100 + i, title: `Thread ${i}` })) };
}

export function load(p, data) { p.ctx.__fx = data; p.run("Object.assign(state, __fx)"); }
