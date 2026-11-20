// Loads the flight board's own script from page/board.template.html and exposes its pure functions for tests.
// No browser: window.claude is absent, so the page's live-data block stops at "offline".
import { readFileSync, rmSync } from "node:fs";
import vm from "node:vm";
// #C1367: removes a temp folder a test made. Under a loaded machine rmSync can meet ENOTEMPTY (git or the OS still writing into the folder as it is removed:
// tests/landing-refuses-data-md-edit.test.mjs failed this way once and passed alone), so a busy folder is tried again, up to `tries` times, 50 ms apart; any other
// error, and the last busy one, is thrown. `rm` and `wait` are the seams for the test.
const BUSY = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function rmTemp(dir, { rm = rmSync, tries = 5, wait = sleep } = {}) {
  for (let i = 1; ; i++) {
    try { return rm(dir, { recursive: true, force: true }); } catch (e) {
      if (i >= tries || !BUSY.has(e?.code)) throw e;
      wait(50);
    }
  }
}
const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1], templateScript = script;
// els: a Map to keep each element by id, so a test can read what a render wrote; by default every lookup is a new one.
export function loadBoard({ els = null } = {}) {
  const fresh = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }) });
  const el = (id) => (els ? els.get(id) ?? els.set(id, fresh()).get(id) : fresh());
  const document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const ctx = { document, window: {}, console, setInterval() {}, setTimeout() {}, clearTimeout() {}, queueMicrotask() {}, navigator: {}, getSelection: () => ({}), Date, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(script + "\n;globalThis.__b={state,enrich,gates,initRow,linkify,phaseIndex,PHASES,waitBoxes,phaseTimes,renderAll,replyBox,dur,askText,gaps,waitGaps,liveGap,stalled,fileCheck,pingText,probeEvent};", ctx);
  return ctx.__b;
}
// #C1277: a tile is active (blue, blinking) only from a probe reading that shows an agent on the card, so a test that wants an active tile says so:
// a fresh reading in which `agent` is working on card `id`. `card` overlays the card's own part of the reading.
export function probeWorking(b, id, agent = "Builder", card = {}) {
  const at = Date.now() - 12e3;
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { boardId: "TestBoard42xyz", at, probe: null, pageVersion: null },
    cards: { [id]: { num: 1, phase: "build", headSha12: "a1b2c3d4e5f6", signed: [], onMain: false, ci: "passed", ciMin: 4, liveVersion: null, at, ...card } },
    agents: { [agent]: { state: "working", lastActivityAt: at, tool: "Read", card: id, since: Date.now() - 5 * 60e3 } } } } }, {});
}
// A step event, as agents log them.
export const step = (init, phase, who, kind, at, extra = {}) => ({ init, phase, who, kind, at, ...extra });
// Renders the Waiting on Owner list for the given asks and returns its HTML.
export function renderWaitingHtml(asks, opts = {}) {
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }) });
  const document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null };
  const ctx = { document, window: {}, console, setInterval() {}, setTimeout() {}, clearTimeout() {}, queueMicrotask() {}, navigator: {}, getSelection: () => ({}), Date, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, URLSearchParams, WeakMap, URL: { createObjectURL: (f) => "blob:test/" + f.name, revokeObjectURL() {} } };
  vm.createContext(ctx);
  vm.runInContext(script + "\n;globalThis.__b={state,renderWaiting,setAssets,pendingFiles};", ctx);
  ctx.__b.state.waiting = asks;
  ctx.__b.state.messages = opts.messages || [];
  if (opts.assets) ctx.__b.setAssets({});
  for (const [id, files] of Object.entries(opts.pending || {})) ctx.__b.pendingFiles.set(id, files);
  ctx.__b.renderWaiting();
  return els.waiting.innerHTML;
}

// Loads the board with the named functions exposed (threads and the reply writes, board v2), plus state.
// The page's own document listeners are kept in `listeners` (type → [fn]), so a test can fire one (a fold's toggle).
// globals: more of the page's world (a sessionStorage, a location), laid over the default one.
// pageHtml: a built page (buildPage with a config) to load in place of the template.
export function loadNames(names, globals = {}, pageHtml = null) {
  const script = pageHtml ? pageHtml.match(/<script>([\s\S]*?)<\/script>/)[1] : templateScript;
  const els = {};
  const listeners = {};
  const el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", value: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }) });
  // globals.documentElement (#C972): the page's <html>, so a test can load it as the store page (data-host="store").
  const document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, activeElement: null, createRange: () => ({}), documentElement: globals.documentElement };
  const ctx = { document, window: {}, console, setInterval() {}, setTimeout() {}, clearTimeout() {}, queueMicrotask() {}, navigator: {}, getSelection: () => ({}), Date, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, URLSearchParams, WeakMap, File, ...globals };
  vm.createContext(ctx);
  vm.runInContext(script + `\n;globalThis.__b={state,${names.join(",")}};`, ctx);
  return { ...ctx.__b, els, document, listeners };
}
