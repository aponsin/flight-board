// The old page's own script drawing a whole board, with no browser (#C723): every element it wrote, by id, and every attribute
// it set. host "store" is the page as the store Worker serves it (<html data-host="store">); anything else is the artifact page.
import { readFileSync } from "node:fs";
import vm from "node:vm";

export const TEMPLATE = readFileSync(new URL("../../page/board.template.html", import.meta.url), "utf8");
const SCRIPT0 = TEMPLATE.match(/<script>([\s\S]*?)<\/script>/)[1];

// config: keys laid over the page's built-in config, as a built page carries (artifactUrl, say).
export function drawPage(docs, { probe = null, host = null, expose = [], config = null } = {}) {
  const SCRIPT = config ? SCRIPT0.replace(/\/\*BOARD_CONFIG\*\/([\s\S]*?)\/\*END_CONFIG\*\//, (_, j) => JSON.stringify({ ...JSON.parse(j), ...config })) : SCRIPT0;
  const els = {}, attrs = [];
  const el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", value: "", hidden: false, scrollTop: 0, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, setAttribute: (k, v) => attrs.push(`${k}=${v}`), removeAttribute() {},
    querySelectorAll: () => [], querySelector: () => null, appendChild() {}, focus() {}, getBoundingClientRect: () => ({ left: 0, width: 0, top: 0, height: 0 }) });
  const document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}), createElement: () => el("_new"),
    documentElement: { getAttribute: (k) => (k === "data-host" ? host : null) } };
  const ctx = { document, window: { scrollY: 0, scrollTo() {}, addEventListener() {} }, console, setInterval() {}, setTimeout() {}, clearTimeout() {}, queueMicrotask() {}, navigator: {}, getSelection: () => ({}),
    localStorage: { getItem: () => null, setItem() {} }, location: { hash: "", search: "" }, Date, Math, JSON, Number, String, Array, Object, Set, Map, WeakMap, isFinite, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(SCRIPT + `\n;globalThis.__b={state,renderAll,probeEvent,${["STORE", ...expose].join(",")}};`, ctx);
  const b = ctx.__b;
  for (const [c, list] of Object.entries(docs)) {
    const key = c === "initiatives" ? "initRaw" : c;
    if (Array.isArray(b.state[key])) b.state[key] = list;
  }
  if (probe) b.probeEvent({ type: "data", result: { payload: probe } });
  b.renderAll();
  return { els, b, html: Object.values(els).map((e) => e.innerHTML).join("\n"), attrs: attrs.join("\n") };
}
