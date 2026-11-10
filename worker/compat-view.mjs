// The compatibility view (#C723 A2, parity plan section 1): the store's view (readView) answered in the OLD page's collection
// shapes, so page/board.template.html draws it unchanged. Pure: rows in, plain objects out, no I/O, tested in Node by rendering
// the page on the result (tests/compat-view.test.mjs). It only reads; every write still goes through the store's rules (A3).
//
// Filled now: initiatives (cards + the probe's phase), waiting (asks), todo and ideas (lists), derived/all (the probe's card
// readings and the live version), meta/live, and the probe document. Left out until their stage: messages, threads, steps,
// events, usage, plan, timings, ctx*, checkRequests, threadPings, pingThreads, agentPrs, approvals.

import { STALE_AFTER_MS } from "./board-rules.mjs";
import { applyFiles } from "./file-store.mjs";
import { applyShips } from "./compat-ships.mjs";
import { applyThreads } from "./compat-threads.mjs";
import { applyUsage } from "./compat-usage.mjs";
import { applyApprovals } from "./compat-approvals.mjs";

const num = (v) => (Number.isFinite(v) ? v : undefined);
const prune = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
const json = (s) => { try { const v = JSON.parse(s); return v && typeof v === "object" ? v : {}; } catch { return {}; } };
const KEY = (i) => String.fromCharCode(65 + i); // a Decision's options are plain strings in the store: A, B, C, D here

// Option objects for the page, and the way back (A3 maps a chosen key to the store's string).
export const optionObjects = (options) => (Array.isArray(options) ? options.map((label, i) => ({ key: KEY(i), label: String(label) })) : undefined);
export const optionOfKey = (options, key) => (Array.isArray(options) ? options.find((_, i) => KEY(i) === key) : undefined);

const KINDS = { Decision: "decision", Action: "action", Terminal: "action", SessionStart: "session", Later: "later", Approval: "action", Answer: "answer", Thread: "answer" };

// One ask as an old `waiting` doc.
export function waitingDoc(a) {
  const b = json(a.body);
  const doc = { id: a.id, kind: KINDS[a.type] ?? "action", since: num(a.created_at), initiative: a.card_id ?? undefined, from: a.asked_by };
  switch (a.type) {
    case "Decision": doc.text = b.question; doc.options = optionObjects(b.options); if (Array.isArray(b.options)) { const r = b.options.indexOf(b.recommended); if (r >= 0) doc.recommended = KEY(r); } break;
    case "Action": doc.text = a.title; doc.steps = b.steps; doc.expect = b.expect; break;
    case "Terminal": doc.text = a.title; doc.steps = (b.commands ?? []).map((cmd) => ({ text: "Run this in Terminal:", cmd })); break;
    case "SessionStart": doc.text = a.title; doc.steps = [{ text: "Start the session and type:", cmd: b.words }]; break;
    case "Later": doc.text = b.text ?? a.title; doc.eta = num(a.eta_at); doc.etaWhen = a.eta_precondition ?? undefined; break;
    case "Approval": doc.text = a.title; break;
    case "Answer": doc.question = b.question; doc.text = a.title; break;
    default: doc.text = b.text ?? a.title;
  }
  if (a.answered_at) {
    const options = a.type === "Decision" ? b.options : undefined;
    const idx = options ? options.indexOf(a.answer) : -1;
    // B2: an answer given in full keeps its button and note (answer_status); "other" is the Decision's something-else.
    if (a.answer_status) {
      const other = a.answer_status === "other";
      doc.response = prune({ status: other ? "chose" : a.answer_status, choice: other ? "something else" : idx >= 0 ? KEY(idx) : undefined, note: a.answer_note ?? "", at: a.answered_at });
    } else
    doc.response = prune({ status: a.type === "Decision" ? "chose" : /^ack/i.test(a.answer ?? "") ? "ack" : "done", choice: idx >= 0 ? KEY(idx) : undefined, note: idx >= 0 ? "" : a.type === "Decision" ? a.answer : "", at: a.answered_at });
    doc.respondedAt = a.answered_at;
  }
  if (a.closed_at) { doc.done = true; doc.doneAt = a.closed_at; }
  return prune(doc);
}

// One card as an old `initiatives` doc; the phase and status are the probe's reading, never typed.
export function initiativeDoc(c, ev) {
  const lit = ev?.value?.lit?.[0];
  const skip = c.skip ? json(`{"s":${c.skip}}`).s : undefined;
  const deps = c.depends_on ? json(`{"s":${c.depends_on}}`).s : undefined, issues = c.issues ? json(c.issues) : undefined;
  return prune({
    id: c.id, name: c.title, num: c.num, summary: c.summary, size: c.size, level: c.review_level, who: c.owner_role, phase: lit,
    status: c.dropped ? "dropped" : c.paused ? "paused" : c.blocked_reason ? "blocked" : "active", createdAt: c.created_at, updatedAt: c.updated_at,
    nextNote: c.next_note, nextNoteAt: c.next_note_at, waitingOn: c.waiting_on, blocked: c.blocked_reason, fromThread: c.from_thread,
    customerText: c.customer_text === null || c.customer_text === undefined ? undefined : !!c.customer_text, lookChange: c.look_change === null || c.look_change === undefined ? undefined : !!c.look_change,
    skip: Array.isArray(skip) ? skip : undefined, reworkReason: c.rework_reason, plan: c.track,
    // #C729 B4a: what it waits on, its issue counts (and when set) and its place in its owner's queue.
    dependsOn: Array.isArray(deps) ? deps : undefined, issues: issues && typeof issues === "object" && !Array.isArray(issues) ? issues : undefined, issuesAt: num(c.issues_at),
    queuePos: Number.isInteger(c.queue_pos) && c.queue_pos > 0 ? c.queue_pos : undefined,
  });
}

// One list row as an old `todo` / `ideas` doc.
export function listDoc(l) {
  return prune({ id: l.id, text: l.text, area: l.area, category: l.category, note: l.note, rank: l.rank ?? undefined, done: !!l.done, doneAt: l.done_at ?? undefined, addedAt: l.added_at, kind: l.kind === "idea" ? "idea" : undefined });
}

// derived/all {cards, times, live}: the probe's readings by card, in the shape the page's derivedOf reads.
export function derivedDoc(view) {
  const cards = {};
  for (const [key, e] of Object.entries(view.evidence ?? {})) {
    if (!key.startsWith("cards.")) continue;
    const v = e.value ?? {};
    cards[key.slice(6)] = prune({ phase: v.phase ?? v.lit?.[0], head: v.headSha12, version: v.liveVersion ?? undefined, shipping: v.shipping === true ? true : undefined, evidence: undefined, at: e.readAt });
  }
  const live = view.live?.state === "live" ? { version: String(view.live.version).replace(/^v/, ""), at: view.now - (view.live.age ?? 0) } : undefined;
  return prune({ id: "all", at: view.now, cards, times: {}, live });
}

// The probe document the old `board_state` tool returned, from the evidence keys.
export function probeDoc(view) {
  const ev = view.evidence ?? {};
  const cards = {};
  for (const [key, e] of Object.entries(ev)) if (key.startsWith("cards.")) { const { lit, ...rest } = e.value ?? {}; cards[key.slice(6)] = rest; }
  const part = (k) => (ev[k] ? ev[k].value : undefined);
  const out = { v: 1, board: part("board") ?? { boardId: "", at: view.now }, cards, agents: part("agents") ?? {} };
  for (const k of ["ctx", "usage"]) if (part(k) !== undefined) out[k] = part(k);
  // stuck and ship are written only while they hold (the probe leaves the key out when nothing is stuck or no candidate is pushed),
  // so the store keeps the last value: it counts only while the probe keeps rewriting it (a reading older than 3 minutes is gone).
  for (const k of ["stuck", "ship"]) if (ev[k] && view.now - ev[k].readAt <= STALE_AFTER_MS) out[k] = ev[k].value;
  // #C730: the store's own wake (row 4) for the Manager chip and the "seen" ticks, in place of the old wake watch's
  // wakeAliveAt / wakeSeenAt. askAge is left out until the probe has asked the store once; seenAt is Manager's last typed read.
  // A `wake` key in the probe's own board reading is never passed on: only the store's.
  const w = view.wakeState;
  if (out.board && Object.hasOwn(out.board, "wake")) { const { wake, ...rest } = out.board; out.board = rest; }
  if (w && typeof w === "object") out.board = { ...out.board, wake: prune({ state: w.state, reason: w.reason, fix: w.fix, askAge: num(w.askAge), seenAt: view.wake?.seen_at > 0 ? view.wake.seen_at : undefined }) };
  return out;
}

// The whole answer of GET /api/compat. `tag` is the store view's tag (it changes when anything the view shows changes).
export function compatView(view) {
  const evCard = (id) => view.evidence?.[`cards.${id}`];
  const collections = {
    initiatives: (view.cards ?? []).map((c) => initiativeDoc(c, evCard(c.id))),
    waiting: (view.asks ?? []).map(waitingDoc),
    todo: (view.lists ?? []).filter((l) => l.kind === "todo").map(listDoc),
    ideas: (view.lists ?? []).filter((l) => l.kind === "idea").map(listDoc),
    derived: [derivedDoc(view)],
  };
  // The old board's done cards (the one-time import's side table), as done initiatives: the page's medians and its Done list read them.
  // A store card of the same id wins.
  const own = new Set((view.cards ?? []).map((c) => c.id));
  for (const h of view.historyCards ?? []) if (!own.has(h.id)) collections.initiatives.push(prune({ id: h.id, name: h.title, num: h.num, size: h.size, level: h.review_level, status: "done", createdAt: h.created_at, doneAt: h.done_at }));
  // The phase history as the old step log's shape (B3b): the page's own code reads who, times, ETAs and medians from it.
  if ((view.history ?? []).length) collections.steps = view.history.map((h) => prune({ id: `h${h.id}`, init: h.card_id, phase: h.phase, kind: h.kind, at: h.at, who: h.who }));
  if (view.live?.state === "live") collections.meta = [{ id: "live", version: String(view.live.version).replace(/^v/, ""), at: view.now - (view.live.age ?? 0) }];
  applyThreads(collections, view); // before applyFiles: it adds assets to the messages
  applyFiles(collections, view);
  applyShips(collections, view);
  applyUsage(collections, view);
  applyApprovals(collections, view);
  return { tag: view.tag, at: view.now, collections, probe: probeDoc(view) };
}
