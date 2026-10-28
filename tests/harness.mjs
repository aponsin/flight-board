// Loads the flight board's own script from page/board.template.html and exposes its pure functions for tests.
// No browser: window.claude is absent, so the page's live-data block stops at "offline".
import { readFileSync } from "node:fs";
import vm from "node:vm";
const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// els: a Map to keep each element by id, so a test can read what a render wrote; by default every lookup is a new one.
export function loadBoard({ els = null } = {}) {
  const fresh = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }) });
  const el = (id) => (els ? els.get(id) ?? els.set(id, fresh()).get(id) : fresh());
  const document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const ctx = { document, window: {}, console, setInterval() {}, setTimeout() {}, clearTimeout() {}, queueMicrotask() {}, navigator: {}, getSelection: () => ({}), Date, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(script + "\n;globalThis.__b={state,enrich,gates,initRow,linkify,phaseIndex,PHASES,waitBoxes,phaseTimes,renderAll,replyBox,dur,askText,gaps,waitGaps,liveGap,stalled,fileCheck,pingText};", ctx);
  return ctx.__b;
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
export function loadNames(names) {
  const els = {};
  const listeners = {};
  const el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", value: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }) });
  const document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, activeElement: null, createRange: () => ({}) };
  const ctx = { document, window: {}, console, setInterval() {}, setTimeout() {}, clearTimeout() {}, queueMicrotask() {}, navigator: {}, getSelection: () => ({}), Date, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, URLSearchParams, WeakMap, File };
  vm.createContext(ctx);
  vm.runInContext(script + `\n;globalThis.__b={state,${names.join(",")}};`, ctx);
  return { ...ctx.__b, els, document, listeners };
}
