// The dry run's tab counts, read off the PAGE (#C830 v2, Checker's finding on 06422f3): the new board runs the same page code as the old
// one, so no tab rule is written again here. The page's own script is loaded as the tests load it, given the old board's documents (the
// export) or the store's view after the import (compatView of the view with the plan's rows laid in), and asked for its tabs.
// Pure but for reading the template. Nothing here writes.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { compatView } from "../worker/compat-view.mjs";

const TEMPLATE = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const SCRIPT = TEMPLATE.match(/<script>([\s\S]*?)<\/script>/)[1];

// The page at a fixed clock. docs: { initiatives, waiting, messages, threads, ideas, todo, steps }, arrays of { id, ... } (the old board's
// collection names). probe: the probe document (compat), or null. conf: { owner } of the board config (the page's OWNER).
// script: the page's script; given only by a test (a changed template's script must fail loudly, #C834), the template's otherwise.
export function loadPage(docs, { now, owner = "Owner", probe = null, script: pageScript = SCRIPT } = {}) {
  const OWNER_KEY = '"owner":"Owner"';
  // The page's config carries the owner's name; if the template's config changes shape this must fail loudly, not run with the wrong owner.
  if (!pageScript.includes(OWNER_KEY)) throw new Error("import-page: the template's config no longer holds \"owner\":\"Owner\" (the page's OWNER)");
  const script = pageScript.replace(OWNER_KEY, `"owner":${JSON.stringify(owner)}`);
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", value: "", hidden: false, scrollTop: 0, dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [], querySelector: () => null, appendChild() {}, getBoundingClientRect: () => ({ left: 0, width: 0, top: 0, height: 0 }) });
  const document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}), createElement: () => el("_new") };
  // The page reads Date.now() and new Date(): both are the pinned clock.
  const FixedDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } };
  const ctx = { document, window: { scrollY: 0, scrollTo() {}, addEventListener() {} }, console, setInterval() {}, setTimeout() {}, clearTimeout() {}, queueMicrotask() {}, navigator: {}, getSelection: () => ({}), localStorage: { getItem: () => null, setItem() {} }, location: { hash: "", search: "" }, Date: FixedDate, Math, JSON, Number, String, Array, Object, Set, Map, WeakMap, isFinite, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(`${script}\n;globalThis.__b={state,OWNER,tabCounts,youItems,laterAsks,leadAsks,threadSets,resolvedMatches,probeEvent,gates,enrich,asShown};`, ctx);
  const b = ctx.__b;
  for (const [c, list] of Object.entries(docs)) {
    const key = c === "initiatives" ? "initRaw" : c;
    if (Array.isArray(b.state[key])) b.state[key] = list;
  }
  if (probe) b.probeEvent({ type: "data", result: { payload: probe } }, {});
  // renderAll's fill line (the page's `state.initiatives = state.initRaw.map(i => gates(enrich(asShown(i))))`): 23 readers use the shown cards
  // (threadCard, threadCards, the building state, ...), and the stubbed timers never run the page's own redraw. After the probe, which asShown reads.
  b.state.initiatives = b.state.initRaw.map((i) => b.gates(b.enrich(b.asShown(i))));
  return b;
}

// What the page lists on each tab at `now`: the counts and the ids behind them.
export function pageTabs(docs, opts) {
  const b = loadPage(docs, opts), now = opts.now;
  const counts = b.tabCounts(now, "");
  const y = b.youItems(now, "");
  const ids = {
    you: [...y.asks.map((w) => w.id), ...y.answered.map((t) => t.id ?? t)].sort(),
    later: b.laterAsks(now, "").map((w) => w.id ?? w).sort(),
    lead: [...b.leadAsks(now, "").map((w) => w.id ?? w), ...b.threadSets(now, "").open.map((t) => t.id ?? t)].sort(),
    resolved: [...b.resolvedMatches("", now)].sort(),
  };
  // The cards as the page shows them (status done = closed by evidence, or dropped): In flight is the ones that are not.
  const cards = b.state.initiatives.map((i) => ({ id: i.id, status: i.status }));
  return { counts, ids, cards };
}

// The old board's documents (readMirror / readHistory: collection -> { id: doc }) as the page's arrays; a deleted item is gone.
export function oldDocs(docs) {
  const arr = (coll) => Object.entries(coll ?? {}).filter(([, d]) => d && d.deleted !== true).map(([id, d]) => ({ id, ...d }));
  return { initiatives: arr(docs.initiatives), waiting: arr(docs.waiting), messages: arr(docs.messages), threads: arr(docs.threads), ideas: arr(docs.ideas), todo: [], steps: arr(docs.steps) };
}

// The store's view after the import: the plan's rows laid into a copy of the view (asks, threads, messages, history cards), the asks the
// plan closes closed, the messages it flags resolved. Rows have the store's column names (the plan builds them for the SQL).
export function postImportView(view, a, h) {
  const v = JSON.parse(JSON.stringify(view));
  v.asks ??= []; v.historyCards ??= []; v.threads ??= { messages: [], threads: [] };
  v.threads.messages ??= []; v.threads.threads ??= [];
  const askIx = new Map(v.asks.map((s, i) => [s.id, i]));
  const msgIds = new Set(v.threads.messages.map((m) => m.id));
  const thrIds = new Set(v.threads.threads.map((t) => t.id));
  // The asks the first plan (planAsks) carries that the store lacks, and the closed asks of the history plan.
  for (const r of [...(a?.asks ?? []), ...(h?.asks ?? [])]) if (!askIx.has(r.id)) { askIx.set(r.id, v.asks.length); v.asks.push({ ...r }); }
  // The asks the store holds open that the plan patches (a Later made the Decision, its old date kept as "not before"): the plan's row wins on type, body and date.
  for (const r of a?.asks ?? []) { const s = v.asks[askIx.get(r.id)]; if (s && !s.closed_at && !s.answered_at && s.type === "Later" && r.type === "Decision") { s.type = r.type; s.body = r.body; s.eta_at = r.eta_at ?? null; s.eta_precondition = null; } else if (s && !s.closed_at && r.type === "Decision" && s.type === "Decision" && s.eta_at == null && r.eta_at) s.eta_at = r.eta_at; }
  // The asks the old board closed that the store holds open: closed by the guarded UPDATE (the store's own answer kept).
  for (const c of h?.closeOpen ?? []) { const s = v.asks[askIx.get(c.id)]; if (s && !s.closed_at) { s.closed_at = c.closed_at; s.closed_by = "import"; if (!s.answered_at && c.answered_at) { s.answered_at = c.answered_at; s.answer = c.answer; s.answered_by = "owner"; } } }
  for (const m of [...(a?.messages ?? []), ...(h?.messages ?? [])]) if (!msgIds.has(m.id)) { msgIds.add(m.id); v.threads.messages.push({ id: m.id, thread_id: m.thread_id, author: m.author, body: m.body, created_at: m.created_at, kind: m.kind ?? null, resolved: m.resolved ? 1 : 0, options: m.options ?? null }); }
  const flag = new Set(h?.resolve ?? []);
  for (const m of v.threads.messages) if (flag.has(m.id)) m.resolved = 1;
  for (const t of h?.threads ?? []) if (!thrIds.has(t.id)) { thrIds.add(t.id); v.threads.threads.push({ id: t.id, num: t.num, title: t.title ?? null, created_at: t.created_at }); }
  const hc = new Set(v.historyCards.map((c) => c.id));
  for (const c of h?.historyCards ?? []) if (!hc.has(c.id)) { hc.add(c.id); v.historyCards.push({ ...c }); }
  return v;
}

// The page's tabs over the store's view after the import. The owner's messages are stored under the author "owner" and the page's shim
// turns that into the owner's name (compat-shim): done here too.
export function storeTabs(view, a, h, { now, owner = "Owner" } = {}) {
  const c = compatView(postImportView(view, a, h));
  const col = c.collections;
  const messages = (col.messages ?? []).map((m) => (m.from === "owner" ? { ...m, from: owner } : m));
  return pageTabs({ initiatives: col.initiatives ?? [], waiting: col.waiting ?? [], messages, threads: col.threads ?? [], ideas: col.ideas ?? [], todo: col.todo ?? [], steps: col.steps ?? [] }, { now, owner, probe: c.probe ?? null });
}

// The page's tabs over the old board's export (the same page code the old board ran). To-do is not in the export: left as the page's 0.
export function oldTabs(docs, { now, owner = "Owner" } = {}) {
  return pageTabs(oldDocs(docs), { now, owner });
}
