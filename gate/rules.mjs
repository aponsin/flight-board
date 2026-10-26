// The write gate's rules (board-brief section 4): every write to the board is checked here before it lands, and refused
// with the question its writer must answer, never silently. Pure: the write, the config, the writer's role, the time, the
// gate's own state and the board's mirror come in; the problems and the new state go out. gate/gate.mjs is the hook.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { PLAN, planWriteErrors, planMirrorErrors, initiativePlanErrors } from "./plan.mjs";

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

// The counter thread numbers come from (meta/threadSeq {next}).
export const THREAD_SEQ = "threadSeq";

// A batch that numbers threads also moves the counter, pinned (if_version) so two allocations can't both pass: its nums
// are distinct and run up to the counter's new next - 1, with no gap. The counter is pinned whenever it already exists
// (only a set that creates it goes without), and never goes back: seen is the highest next the gate has let through
// (its own state, raised by gate/after.mjs only once the board applied the write: a refused batch's rerun still passes),
// and a batch's numbers start at it or above (Checker: an unpinned [num 1, next 2] reset it to #T1).
export function threadNumErrors(writes, seen = 0) {
  const seqw = writes.find((w) => w.collection === "meta" && w.doc_id === THREAD_SEQ && w.op !== "delete");
  if (seqw && !Number.isInteger(seqw.if_version) && !(seqw.op === "set" && !seen)) return [`meta/${THREAD_SEQ}: pin it with if_version (the version a get just read); only the set that creates it goes without`];
  if (seqw && Number.isInteger(seqw.data?.next) && seqw.data.next < seen) return [`meta/${THREAD_SEQ}: next never goes back (${seqw.data.next} < ${seen}, the last the gate let through)`];
  const nums = writes.filter((w) => w.collection === "threads" && w.op !== "delete" && w.data?.num !== undefined).map((w) => w.data.num);
  if (!nums.length) return [];
  const seq = writes.find((w) => w.collection === "meta" && w.doc_id === THREAD_SEQ && w.op !== "delete");
  if (!seq) return [`threads: numbering a thread moves meta/${THREAD_SEQ} in the same batch (scripts/thread-ids.mjs writes both)`];
  const sorted = [...nums].sort((a, b) => a - b);
  if (new Set(nums).size !== nums.length) return ["threads: two threads in one batch can't share a number"];
  if (sorted.some((n, k) => n !== seq.data?.next - nums.length + k)) return [`threads: the numbers run up to meta/${THREAD_SEQ}.next - 1 with no gap (${sorted.join(", ")} vs next ${seq.data?.next})`];
  if (sorted[0] < seen) return [`threads: #T${sorted[0]} was handed out already (the counter was at ${seen}): export again and rerun scripts/thread-ids.mjs`];
  return [];
}

// The scheduled collector's fixed session title (collector/TASK.md).
export const COLLECTOR_ROLE = "Collector";
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
  // An edit in place (ArtifactData str_replace) leaves the gate blind to the field's new value: write the whole field.
  if (op === "str_replace") return [`a text edit in place can't be checked: write the whole field with update instead`];
  // The scheduled collector (its session titled "Collector", collector/TASK.md) sets derived/all and nothing else
  // (Security): whatever its run reads, it can't change a card, an ask, a message, a step or a tile.
  if (who.role === COLLECTOR_ROLE && !(collection === "derived" && id === "all" && op === "set")) {
    return [`the ${COLLECTOR_ROLE} only sets derived/all`];
  }
  // What the repository says (derived/*) is the collector's, and the lead's to repair; no other role writes it (Security).
  if (collection === "derived" && who.role !== COLLECTOR_ROLE && !who.manager) {
    return [`derived/${id} is written by the ${COLLECTOR_ROLE} (or ${config.gate.managerRole}), not ${who.role}`];
  }
  // Thread numbers (#T27) and names: threads/<thread id> {num, title} and the counter meta/threadSeq {next} are the lead's
  // alone (scripts/thread-ids.mjs allocates them). The owner renames a thread from the page, which writes only a title.
  if (collection === "threads" || (collection === "meta" && id === THREAD_SEQ)) {
    if (!who.manager) return [`${collection}/${id}: only ${config.gate.managerRole} numbers and names threads (the owner renames one from the board)`];
    if (op === "delete") return [`${collection}/${id}: a thread number is kept for good`];
    if (collection === "threads" && data?.num !== undefined && !(Number.isInteger(data.num) && data.num > 0)) return [`num: a whole number from 1`];
    if (collection === "threads" && data?.title !== undefined && !(typeof data.title === "string" && data.title.trim() && data.title.length <= 120)) return [`title: 1 to 120 characters`];
    if (collection === "meta" && !(Number.isInteger(data?.next) && data.next > 1)) return [`meta/${THREAD_SEQ}: next is a whole number above 1`];
  }
  // Rule 6: each role's memory tile is its own; Manager may also set every role's entry in meta/context (the keeper).
  if (collection === "ctx") {
    if (!who.role) e.push("no role for this session: give it its role as its title");
    else if (id !== who.role) e.push(`ctx/${id} is ${id}'s own tile; this session is ${who.role}`);
  }
  // A set or delete would replace or remove every role's entry: only the lead may.
  if (collection === "meta" && id === "context" && (op === "set" || op === "delete") && !who.manager) e.push(`meta/context: only ${config.gate.managerRole} may ${op} the whole document; update agents.${who.role ?? "<you>"} instead`);
  if (collection === "meta" && id === "context" && op === "update" && !who.manager) {
    const agents = data && typeof data === "object" ? Object.keys(data.agents ?? {}) : [];
    const others = Object.keys(data ?? {}).filter((k) => k !== "agents" && k !== "at");
    if (!who.role) e.push("no role for this session: give it its role as its title");
    else if (agents.some((a) => a !== who.role) || others.length) e.push(`meta/context: ${who.role} may write only agents.${who.role}`);
  }
  // The plan (board v3, gate/plan.mjs): the lead's alone, never deleted, every field checked.
  if (collection === PLAN) return [...e, ...planWriteErrors(w, { who, config })];
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
export function checkWrites(writes, { config, who, now, state, mirror = null }) {
  const next = { refusals: { ...(state?.refusals ?? {}) }, stuck: { ...(state?.stuck ?? {}) }, ...(state?.threadSeq ? { threadSeq: state.threadSeq } : {}) };
  // A session with no role (no title, no FLIGHT_BOARD_ROLE) writes nothing, the stuck line included (Security).
  if (!who?.role) return { errors: ["no role for this session: give it its role as its title (or FLIGHT_BOARD_ROLE), then write"], state: next, stuckNow: null };
  // The Collector's one write is checked here too, before the stuck line's shortcut below skips writeErrors (Checker).
  if (who.role === COLLECTOR_ROLE) {
    const other = writes.filter((w) => !(w.collection === "derived" && w.doc_id === "all" && w.op === "set"));
    if (other.length) return { errors: other.map((w) => `${w.collection}/${w.doc_id}: the ${COLLECTOR_ROLE} only sets derived/all`), state: next, stuckNow: null };
  }
  const errors = [];
  // Rule 8: the stuck line is always writable; it is how the owner sees Manager stuck.
  const stuckWrite = writes.find((w) => w.collection === "meta" && w.doc_id === "stuck");
  // The stuck line can't be wiped wholesale: only the lead may set or delete the whole document; others update entries.
  if (stuckWrite && stuckWrite.op !== "update" && !who.manager) errors.push(`meta/stuck: only ${config.gate.managerRole} may ${stuckWrite.op} the whole stuck line; update one item's entry instead`);
  const perItem = new Map();
  for (const w of writes) {
    if (w === stuckWrite) continue;
    const errs = [...writeErrors(w, { config, who, now }), ...mirrorErrors(w, { config, mirror, batch: writes, now })];
    perItem.set(itemKey(w), [...(perItem.get(itemKey(w)) ?? []), ...errs]);
    for (const m of errs) errors.push(`${w.collection}/${w.doc_id}: ${m}`);
  }
  errors.push(...threadNumErrors(writes, state?.threadSeq ?? 0));
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

// ---- Rules that need the board's state, from the mirror the collector keeps (rules 3-5) ----
// mirror: { docs: { initiatives, waiting, ideas, messages, derived } } as gate/gate.mjs reads it. Each rule passes when the mirror
// doesn't know the card (a new one).

// Rule 3: a card's phase only moves forward; a jump past a phase needs it skipped, the evidence past it, or a reason.
// Rule 4: one card per owner in the lane phases (config collector.lanePhases: build, test).
// Rule 5 (case 1): done only with no owner message waiting in its thread, no open ask tied to it, and live by the evidence;
// a card given up closes as "dropped" with a dropReason, with the same first two checks and no evidence needed.
// Rule 10: a message belongs to a thread the board has: an item (a card, an ask, an idea, one made in the same call too),
// a thread that already has messages, or one the owner's New thread box just started: "t-" and its 13-digit time, at most
// 7 days old (the page writes it, so it reaches the mirror only at the next export; Checker). An agent never starts a t-
// thread. A reply to an item names the item's id; a thread id made up for it shows the owner a card of its own. An
// export without ideas skips the rule.
const OWNER_THREAD = /^t-(\d{13})$/;
const OWNER_THREAD_DAYS = 7;
export function threadErrors(w, { mirror, batch = [], now = Date.now() }) {
  const { op, collection, data } = w;
  if (collection !== "messages" || op === "delete" || !data || typeof data !== "object" || !mirror?.docs.ideas) return [];
  const t = data.thread;
  if (typeof t !== "string" || !t) return op === "set" ? ["a message names its thread (thread: the item's id, or a t-… thread)"] : [];
  const box = OWNER_THREAD.exec(t);
  if (box && Number(box[1]) <= now + 60e3 && now - Number(box[1]) <= OWNER_THREAD_DAYS * 864e5) return [];
  const has = (c) => (mirror.docs[c] ?? []).some((d) => d.id === t) || batch.some((b) => b.collection === c && b.doc_id === t && b.op !== "delete");
  if (["initiatives", "waiting", "ideas"].some(has) || (mirror.docs.messages ?? []).some((m) => m.thread === t)) return [];
  return [`thread ${t} is no item on the board, no thread with messages and no new thread of the owner's: reply under the item with its id as the thread`];
}

export function mirrorErrors(w, { config, mirror, batch = [], now: at = Date.now() }) {
  const { op, collection, doc_id: id, data } = w;
  if (collection === "messages") return threadErrors(w, { mirror, batch, now: at });
  if (collection === PLAN) return planMirrorErrors(w, { mirror, batch });
  // Every card links to the plan node it serves (board v3); a new card can't go without one, mirror or not.
  const planned = collection === "initiatives" ? initiativePlanErrors(w, { mirror, batch }) : [];
  if (collection !== "initiatives" || op === "delete" || !data || typeof data !== "object" || !mirror) return planned;
  const e = [...planned];
  const order = config.phases.map((p) => p[0]);
  const cards = mirror.docs.initiatives ?? [];
  const was = cards.find((k) => k.id === id);
  const now = { ...(op === "update" ? was : {}), ...data };
  const derived = (mirror.docs.derived ?? []).find((d) => d.id === "all")?.cards?.[id];
  if (was?.phase && "phase" in data && data.phase !== was.phase) {
    const from = order.indexOf(was.phase), to = order.indexOf(data.phase);
    if (to >= 0 && from >= 0 && to < from) e.push(`phases only move forward: ${was.phase} → ${data.phase}`);
    if (to > from + 1 && !data.phaseReason) {
      const skip = new Set([...(Array.isArray(was.skip) ? was.skip : []), ...(Array.isArray(data.skip) ? data.skip : [])]);
      const past = derived?.phase ? order.indexOf(derived.phase) : -1;
      const jumped = order.slice(from + 1, to).filter((p) => !skip.has(p) && past < to);
      if (jumped.length) e.push(`${was.phase} → ${data.phase} skips ${jumped.join(", ")}: add it to skip, or give phaseReason`);
    }
  }
  // Rule 4: one card per owner in the lane phases (build, test); reviews and shipping queue many.
  const lanes = new Set(config.collector.lanePhases ?? []);
  const shut = (k) => k.status === "done" || k.status === "dropped";
  if (!shut(now) && now.who && lanes.has(now.phase) && ("phase" in data || "who" in data)) {
    const other = cards.find((k) => k.id !== id && !shut(k) && k.who === now.who && k.phase === now.phase);
    if (other) e.push(`${other.id} is on ${now.phase} for ${now.who}: has it moved on? Update ${other.id} first`);
  }
  // A card given up closes as "dropped" with its reason; it needs no live evidence.
  if (data.status === "dropped" && !String(data.dropReason ?? was?.dropReason ?? "").trim()) e.push('a dropped card needs dropReason (why it was given up)');
  if ((data.status === "done" || data.status === "dropped") && !shut(was ?? {})) {
    const thread = (mirror.docs.messages ?? []).filter((m) => m.thread === id && typeof m.at === "number").sort((a, b) => a.at - b.at);
    if (thread.length && thread[thread.length - 1].from === config.owner) e.push(`${config.owner}'s last message in its thread is unanswered`);
    const asks = (mirror.docs.waiting ?? []).filter((x) => x.initiative === id && !x.done && !x.response);
    if (asks.length) e.push(`an ask tied to it is still open (${asks.map((x) => x.id).join(", ")})`);
    if (data.status === "done" && derived?.phase && derived.phase !== config.collector.livePhase) e.push(`the repository says ${derived.phase}, not ${config.collector.livePhase} (${derived.evidence})`);
  }
  return e;
}
