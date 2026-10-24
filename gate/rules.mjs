// The write gate's rules (board-brief section 4): every write to the board is checked here before it lands, and refused
// with the question its writer must answer, never silently. Pure: the write, the config, the writer's role, the time, the
// gate's own state and the board's mirror come in; the problems and the new state go out. gate/gate.mjs is the hook.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const PAGE = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
let page;
// The page's own checks (gaps, waitGaps), so the gate and the board never disagree about what an item lacks.
function pageRules() {
  if (page) return page;
  const script = PAGE.match(/<script>([\s\S]*?)<\/script>/)[1];
  const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }) });
  const ctx = { document: { getElementById: () => el(), querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) }, window: {}, console, setInterval() {}, setTimeout() {}, queueMicrotask() {}, navigator: {}, getSelection: () => ({}), Date, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, URLSearchParams, WeakMap };
  vm.createContext(ctx);
  vm.runInContext(script + "\n;globalThis.__b={gaps,waitGaps};", ctx);
  return (page = ctx.__b);
}

const TIME_FIELDS = ["at", "since", "nextNoteAt"];
// A step written as plain text that holds a command: the owner can't copy it. Commands go in {text, cmd}.
const COMMAND = /`[^`]+`|(^|[\s:])(npm|npx|git|gh|node|python3?|cd|curl|brew|sudo|wrangler|bash|zsh)\s+[^\s]/;

function timeErrors(data, now) {
  const e = [];
  for (const f of TIME_FIELDS) {
    const v = data[f];
    if (typeof v !== "number") continue;
    if (v > now + 60e3) e.push(`${f} is in the future: read the clock (python3 -c "import time;print(int(time.time()*1000))")`);
    else if (v % 1e5 === 0) e.push(`${f} looks rounded or guessed (${v}): read the clock`);
  }
  if (typeof data.etaLive === "number" && data.etaLive < now) e.push("ETA is in the past");
  return e;
}

// One write's problems. w: { op, collection, doc_id, data }. who: { role, manager }.
export function writeErrors(w, { config, who, now }) {
  const { op, collection, doc_id: id, data } = w;
  const e = [];
  const phases = config.phases.map((p) => p[0]);
  // Rule 6: each role's memory tile is its own; Manager may also set every role's entry in meta/context (the keeper).
  if (collection === "ctx") {
    if (!who.role) e.push("no role for this session: give it its role as its title");
    else if (id !== who.role) e.push(`ctx/${id} is ${id}'s own tile; this session is ${who.role}`);
  }
  if (collection === "meta" && id === "context" && op !== "delete" && !who.manager) {
    const agents = data && typeof data === "object" ? Object.keys(data.agents ?? {}) : [];
    const others = Object.keys(data ?? {}).filter((k) => k !== "agents" && k !== "at");
    if (!who.role) e.push("no role for this session: give it its role as its title");
    else if (agents.some((a) => a !== who.role) || others.length) e.push(`meta/context: ${who.role} may write only agents.${who.role}`);
  }
  if (op === "delete" || !data || typeof data !== "object") return e;
  e.push(...timeErrors(data, now));
  const rules = pageRules();
  if (collection === "initiatives") {
    if (op === "set" && data.status !== "done") {
      if (!data.name) e.push("no name");
      if (!data.size) e.push("no size");
      for (const g of rules.gaps({ status: "active", ...data })) if (!/stalled|never started|over 1 h old|ETA passed/.test(g)) e.push(g);
    }
    if (op === "update" && "nextNote" in data && typeof data.nextNoteAt !== "number" && !(data.nextNote && data.nextNote.__delete__)) e.push("nextNote set without nextNoteAt");
  }
  if (collection === "waiting") {
    // Rule 7: an agent's passing state ("needs the user") goes down the nudge path; it never becomes an item.
    if (op === "set" && (config.gate.transientPrefixes ?? []).some((p) => String(id).startsWith(p))) e.push(`"${id}" is a passing agent state: it goes to the nudges, never to the board as an item`);
    if (op === "set") {
      if (!data.kind) e.push("no kind");
      if (typeof data.since !== "number") e.push("no since (when it was asked)");
      for (const g of rules.waitGaps({ ...data, done: false })) e.push(g);
    }
    if ((op === "set" || op === "update") && "kind" in data && !["decision", "action", "answer"].includes(data.kind)) e.push(`kind "${data.kind}" is not drawn: use decision, action or answer`);
    const kind = data.kind;
    if (Array.isArray(data.options)) {
      if (op === "set" ? kind !== "decision" : "kind" in data && kind !== "decision") e.push('options show as buttons only on kind "decision"');
      if (data.options.some((o) => !o || !o.key || !o.label)) e.push("each option needs key and label");
    }
    // Rule 1: a decision has at least two options and a line of context; a look decision a screenshot per option.
    if (op === "set" && kind === "decision" && !data.done) {
      const opts = Array.isArray(data.options) ? data.options.filter((o) => o && o.key && o.label) : [];
      if (opts.length < 2) e.push("a decision needs at least two options {key, label}");
      if (!String(data.text ?? "").trim()) e.push("a decision needs its context in text");
      if (data.look === true) {
        const shown = new Set((Array.isArray(data.images) ? data.images : []).map((i) => i && i.option));
        const missing = opts.filter((o) => !shown.has(o.key)).map((o) => o.key);
        if (missing.length) e.push(`a look decision needs a screenshot for each option (missing: ${missing.join(", ")})`);
      }
    }
    // Rule 1: a command goes in {text, cmd}, so the owner gets a Copy button.
    if (Array.isArray(data.steps)) data.steps.forEach((s, n) => { if (typeof s === "string" && COMMAND.test(s)) e.push(`steps[${n}] holds a command: write it as {text, cmd}`); });
  }
  if (collection === "steps" && op === "set") {
    if (!phases.includes(data.phase)) e.push(`unknown phase "${data.phase}" (use ${phases.join(", ")})`);
    if (!["start", "end"].includes(data.kind)) e.push("kind must be start or end");
    if (!data.init || !data.who || typeof data.at !== "number") e.push("a step needs init, who and at");
  }
  return e;
}

// The item a write is about, for the stuck count: "<collection>:<doc id>".
const itemKey = (w) => `${w.collection}:${w.doc_id}`;
const STUCK_AFTER = 3;

// A whole tool call to the board. state: { refusals: { item: n }, stuck: { item: { reason, at } } }.
// Returns { errors, state, stuckNow }: stuckNow names an item refused STUCK_AFTER times in a row, for the stuck line.
export function checkWrites(writes, { config, who, now, state }) {
  const next = { refusals: { ...(state?.refusals ?? {}) }, stuck: { ...(state?.stuck ?? {}) } };
  const errors = [];
  // Rule 8: the stuck line is always writable; it is how the owner sees Manager stuck.
  const stuckWrite = writes.find((w) => w.collection === "meta" && w.doc_id === "stuck");
  const perItem = new Map();
  for (const w of writes) {
    if (w === stuckWrite) continue;
    const errs = writeErrors(w, { config, who, now });
    perItem.set(itemKey(w), [...(perItem.get(itemKey(w)) ?? []), ...errs]);
    for (const m of errs) errors.push(`${w.collection}/${w.doc_id}: ${m}`);
  }
  // A write that passes for a stuck item clears its line in the same call, or it is refused.
  if (!errors.length) {
    const cleared = stuckClears(stuckWrite, next.stuck);
    for (const key of perItem.keys()) if (next.stuck[key] && !cleared.has(key)) errors.push(`${key.replace(":", "/")}: it shows as stuck on the board; clear it in the same batch (update meta/stuck {"${key}": {"__delete__": true}})`);
  }
  let stuckNow = null;
  if (errors.length) {
    for (const [key, errs] of perItem) {
      if (!errs.length) continue;
      next.refusals[key] = (next.refusals[key] ?? 0) + 1;
      if (next.refusals[key] >= STUCK_AFTER && !next.stuck[key]) stuckNow = { item: key, reason: errs[0] };
    }
  } else {
    for (const key of perItem.keys()) delete next.refusals[key];
    for (const key of stuckClears(stuckWrite, next.stuck)) delete next.stuck[key];
  }
  // The stuck write itself: what it adds is recorded, so the item's next good write must clear it.
  if (stuckWrite && !errors.length) for (const [key, v] of Object.entries(stuckWrite.data ?? {})) if (v && !v.__delete__) next.stuck[key] = { reason: String(v.reason ?? ""), at: now };
  return { errors, state: next, stuckNow };
}

// The items a write to meta/stuck takes off the line: each one set to {"__delete__": true}, or all of them by a delete.
function stuckClears(w, stuck = {}) {
  if (!w) return new Set();
  if (w.op === "delete") return new Set(Object.keys(stuck));
  return new Set(Object.entries(w.data ?? {}).filter(([, v]) => v && v.__delete__).map(([k]) => k));
}

// The refusal's text, with the stuck instruction on the third refusal in a row.
export function refusalText(errors, stuckNow, now) {
  let t = `Flight board refused this write. Fix and resend:\n- ${errors.join("\n- ")}\n`;
  if (stuckNow) t += `\nThird refusal in a row for ${stuckNow.item}. Show it on the board now (this write always passes):\n  ArtifactData update meta/stuck {"${stuckNow.item}": {"reason": ${JSON.stringify(stuckNow.reason)}, "at": ${now}}}\n`;
  return t;
}
