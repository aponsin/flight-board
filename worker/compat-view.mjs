// The compatibility view (#C723 A2, parity plan section 1): the store's view (readView) answered in the OLD page's collection
// shapes, so page/board.template.html draws it unchanged. Pure: rows in, plain objects out, no I/O, tested in Node by rendering
// the page on the result (tests/compat-view.test.mjs). It only reads; every write still goes through the store's rules (A3).
//
// Filled now: initiatives (cards + the probe's phase), waiting (asks), todo and ideas (lists), derived/all (the probe's card
// readings and the live version), meta/live, and the probe document. Left out until their stage: messages, threads, steps,
// events, usage, plan, timings, ctx*, checkRequests, threadPings, pingThreads, agentPrs, approvals.

import { STALE_AFTER_MS, PHASES, typedOther, INSTALL_WAIT } from "./board-rules.mjs";
import { expectedVersions } from "../collector/expected.mjs";
import { applyFiles } from "./file-store.mjs";
import { applyShips } from "./compat-ships.mjs";
import { applyThreads } from "./compat-threads.mjs";
import { applyUsage } from "./compat-usage.mjs";
import { applyApprovals } from "./compat-approvals.mjs";
import { withSessionWeek } from "../collector/week-usage.mjs";

const num = (v) => (Number.isFinite(v) ? v : undefined);
const prune = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
const json = (s) => { try { const v = JSON.parse(s); return v && typeof v === "object" ? v : {}; } catch { return {}; } };
const KEY = (i) => String.fromCharCode(65 + i); // a Decision's options are plain strings in the store: A, B, C, D here

// Option objects for the page, and the way back (A3 maps a chosen key to the store's string).
// #C880: the refusals the view already carries (the newest 20, newest first) as the page's stuck document: { id: "stuck", "initiatives:<card>":
// { reason: <rule>, at, who, owner: <who> } }. One line per role and rule (the newest refusal of that pair that names an open card), nothing older
// than a day, and a line goes as soon as its card has been written after the refusal (a write for that card passed). A refusal naming no card, an
// unknown or closed card, or a name that is no role is left out: the page never prints a word the store has not checked.
export const STUCK_WINDOW_MS = 24 * 3_600_000;
const STUCK_WHO = /^[A-Za-z][A-Za-z0-9]{1,23}$/;
export function stuckDoc(view) {
  const cards = new Map((view.cards ?? []).map((c) => [c.id, c]));
  const doc = { id: "stuck" };
  const seen = new Set();
  for (const r of view.refusals ?? []) {
    if (typeof r.card_id !== "string" || !STUCK_WHO.test(r.who ?? "") || typeof r.rule !== "string" || !Number.isFinite(r.at)) continue;
    if (view.now - r.at > STUCK_WINDOW_MS) continue;
    const c = cards.get(r.card_id);
    if (!c || c.dropped || c.done_at) continue;
    const key = `${r.who}|${r.rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (Number.isFinite(c.updated_at) && c.updated_at > r.at) continue; // a write for that card has passed since
    if (`initiatives:${r.card_id}` in doc) continue; // the page keys a line by its card: the newest refusal of a card is its line
    doc[`initiatives:${r.card_id}`] ={ reason: r.rule, at: r.at, who: r.who, owner: r.who };
  }
  return Object.keys(doc).length > 1 ? doc : null;
}
export const optionObjects =(options) => (Array.isArray(options) ? options.map((label, i) => ({ key: KEY(i), label: String(label) })) : undefined);
export const optionOfKey = (options, key) => (Array.isArray(options) ? options.find((_, i) => KEY(i) === key) : undefined);

const KINDS = { Decision: "decision", Action: "action", Terminal: "action", SessionStart: "session", Later: "later", Approval: "action", Answer: "answer", Thread: "answer" };

// One ask as an old `waiting` doc.
export function waitingDoc(a) {
  const b = json(a.body);
  const doc = { id: a.id, kind: KINDS[a.type] ?? "action", since: num(a.created_at), initiative: a.card_id ?? undefined, from: a.asked_by };
  switch (a.type) {
    // #C823: a Decision's eta_at is a "not before": the page lists it under Later until then and under Needs you from then on.
    case "Decision": doc.text = b.question; doc.options = optionObjects(b.options); if (Array.isArray(b.options)) { const r = b.options.indexOf(b.recommended); if (r >= 0) doc.recommended = KEY(r); } if (num(a.eta_at)) doc.notBefore = num(a.eta_at); break;
    case "Action": doc.text = a.title; doc.steps = b.steps; doc.expect = b.expect; doc.where = b.where; break;
    case "Terminal": doc.text = a.title; doc.steps = (b.commands ?? []).map((cmd) => ({ text: "Run this in Terminal:", cmd })); break;
    case "SessionStart": doc.text = a.title; doc.steps = [{ text: "Start the session and type:", cmd: b.words }]; break;
    // #C925: a promise (owed_by) carries who owes it; the page keeps it under Later, badged "<role> owes you this", past its date.
    case "Later": doc.text = b.text ?? a.title; doc.eta = num(a.eta_at); doc.etaWhen = a.eta_precondition ?? undefined; doc.steps = b.steps; doc.expect = b.expect; doc.where = b.where; if (typeof a.owed_by === "string" && /^[A-Za-z][A-Za-z0-9 _-]{0,40}$/.test(a.owed_by)) doc.owedBy = a.owed_by; break;
    case "Approval": doc.text = a.title; break;
    case "Answer": doc.question = b.question; doc.text = a.title; break;
    default: doc.text = b.text ?? a.title;
  }
  if (a.answered_at) {
    // #C923: whether Manager has taken the answer (answer_taken_at); the store page's "not taken" line reads it. A boolean, never the time.
    const taken = !!a.answer_taken_at;
    const options = a.type === "Decision" ? b.options : undefined;
    const idx = options ? options.indexOf(a.answer) : -1;
    // B2: an answer given in full keeps its button and note (answer_status); "other" is the Decision's something-else.
    if (a.answer_status) {
      const other = a.answer_status === "other";
      doc.response = prune({ status: other ? "chose" : a.answer_status, choice: other ? "something else" : idx >= 0 ? KEY(idx) : undefined, note: a.answer_note ?? "", at: a.answered_at, taken });
    } else if (a.type === "Decision" && idx < 0 && typedOther(a.answer)) {
      // #C912: an imported "something else" (collector/import-mirror.mjs `askRow` kept the old response object whole as the answer
      // string, with no answer_status): the owner's typed text, as a native "other" answer reads, never the object as JSON.
      const o = typedOther(a.answer);
      doc.response = prune({ status: "chose", choice: "something else", note: o.note, at: a.answered_at, taken, files: Array.isArray(o.files) && o.files.length ? o.files : undefined });
    } else
    doc.response = prune({ status: a.type === "Decision" ? "chose" : /^ack/i.test(a.answer ?? "") ? "ack" : "done", choice: idx >= 0 ? KEY(idx) : undefined, note: idx >= 0 ? "" : a.type === "Decision" ? a.answer : "", at: a.answered_at, taken });
    doc.respondedAt = a.answered_at;
  }
  if (a.closed_at) { doc.done = true; doc.doneAt = a.closed_at; }
  // #C987: closed by the board (its card moved on), so the page knows the close answered the owner's earlier word (Security F1 on 1ab7673).
  // closed_by, not auto_closed_at: a board close that was reopened and then closed by its asker is the asker's close.
  if (a.closed_at && a.closed_by === "board") doc.autoClosed = true;
  return prune(doc);
}

// The probe's stack reading of a card ({ tip, size, branch } or { outside, branch }), copied field by field so nothing else rides along.
const stackOf = (s) => {
  if (!s || typeof s !== "object" || Array.isArray(s)) return undefined;
  const o = {};
  if (typeof s.tip === "string" && /^[0-9a-f]{12}$/.test(s.tip)) o.tip = s.tip;
  if (Number.isInteger(s.size) && s.size >= 2 && s.size <= 200) o.size = s.size;
  if (s.outside === true) o.outside = true;
  if (typeof s.branch === "string" && /^[A-Za-z0-9._\/-]{1,100}$/.test(s.branch)) o.branch = s.branch;
  return Object.keys(o).length ? o : undefined;
};

// One card as an old `initiatives` doc; the phase and status are the probe's reading, never typed.
export function initiativeDoc(c, ev) {
  const lit = ev?.value?.lit?.[0];
  const skip = c.skip ? json(`{"s":${c.skip}}`).s : undefined;
  const deps = c.depends_on ? json(`{"s":${c.depends_on}}`).s : undefined, issues = c.issues ? json(c.issues) : undefined;
  return prune({
    id: c.id, name: c.title, num: c.num, summary: c.summary, size: c.size, level: c.review_level, who: c.owner_role, phase: lit,
    status: c.dropped ? "dropped" : c.done_at ? "done" : c.paused ? "paused" : c.blocked_reason ? "blocked" : "active", createdAt: c.created_at, updatedAt: c.updated_at,
    // #C902: a card closed as done by an agent (its work left no branch), with what shows it.
    doneAt: num(c.done_at), doneEvidence: c.done_evidence ?? undefined,
    nextNote: c.next_note, nextNoteAt: c.next_note_at, waitingOn: c.waiting_on, blocked: c.blocked_reason, fromThread: c.from_thread,
    customerText: c.customer_text === null || c.customer_text === undefined ? undefined : !!c.customer_text, lookChange: c.look_change === null || c.look_change === undefined ? undefined : !!c.look_change,
    skip: Array.isArray(skip) ? skip : undefined, reworkReason: c.rework_reason, plan: c.track,
    // #C729 B4a: what it waits on, its issue counts (and when set) and its place in its owner's queue.
    dependsOn: Array.isArray(deps) ? deps : undefined, issues: issues && typeof issues === "object" && !Array.isArray(issues) ? issues : undefined, issuesAt: num(c.issues_at),
    queuePos: Number.isInteger(c.queue_pos) && c.queue_pos > 0 ? c.queue_pos : undefined,
    // #C871: who placed it in the queue and when (the page says "order set by the owner"); #C859: where it stands in its repository's stack.
    queueSetBy: typeof c.queue_set_by === "string" && c.queue_set_by ? c.queue_set_by : undefined, queueSetAt: num(c.queue_set_at),
    stack: stackOf(ev?.value?.stack),
    // #C731 B4b: the done-test hold. A card with a checkAt is not closed by the page on the live reading ("Live, still open").
    checkAt: Number.isInteger(c.check_at) && c.check_at > 0 ? c.check_at : undefined,
    repo: c.repo, batch: c.batch, bump: c.bump,
    // #C1008: the group the owner pulled it out of, who and when (the page tags the row "pulled out of G3 · 10:05 AM by <owner>").
    pulledFrom: typeof c.pulled_from === "string" && c.pulled_from ? c.pulled_from : undefined, pulledBy: typeof c.pulled_by === "string" && c.pulled_by ? c.pulled_by : undefined, pulledAt: num(c.pulled_at),
    // holds-need-an-end (#C838): the id of the ask or card whose closing ends the hold, and when the hold began (the page draws "held: <reason>, until <end>").
    holdEnd: typeof c.hold_end === "string" && c.hold_end ? c.hold_end : undefined, heldAt: num(c.held_at), holdUntil: num(c.hold_until),
  });
}

// One list row as an old `todo` / `ideas` doc.
export function listDoc(l) {
  return prune({ id: l.id, text: l.text, area: l.area, category: l.category, note: l.note, rank: l.rank ?? undefined, done: !!l.done, doneAt: l.done_at ?? undefined, addedAt: l.added_at, kind: l.kind === "idea" ? "idea" : undefined });
}

// #C881: derived/all `times` = { card: { phase: { start } } } from the phase history (the probe's own rows, not waits). A phase's start is the
// FIRST time it began: a card that flips back to a phase (checker, ship, checker) keeps the first start, never the newest. Live is not a work phase.
export function timesOfHistory(history) {
  const times = {};
  for (const h of history ?? []) {
    if (h.kind !== "start" || h.wait || h.phase === "live" || !Number.isFinite(h.at)) continue;
    const t = (times[h.card_id] ??= {});
    if (!t[h.phase] || h.at < t[h.phase].start) t[h.phase] = { start: h.at };
  }
  return times;
}

// derived/all {cards, times, live}: the probe's readings by card, in the shape the page's derivedOf reads.
export function derivedDoc(view) {
  const cards = {};
  for (const [key, e] of Object.entries(view.evidence ?? {})) {
    if (!key.startsWith("cards.")) continue;
    const v = e.value ?? {};
    cards[key.slice(6)] = prune({ phase: v.phase ?? v.lit?.[0], head: v.headSha12, version: v.liveVersion ?? undefined, shipping: v.shipping === true ? true : undefined, evidence: undefined, at: e.readAt,
      // #C731 B4b: the probe's readyAt, firm (only ever false) and waitingFor, as derive.mjs gave the page.
      readyAt: num(v.readyAt), firm: v.firm === false ? false : undefined, waitingFor: Array.isArray(v.waitingFor) && v.waitingFor.length ? v.waitingFor : undefined,
      // #C731 B4b slice 3: workSeen (only ever true), shippedAt and reviews ({ phase: ms }), as collect.mjs and derive.mjs gave the page.
      workSeen: v.workSeen === true ? true : undefined, shippedAt: num(v.shippedAt),
      reviews: v.reviews && typeof v.reviews === "object" && !Array.isArray(v.reviews) && Object.keys(v.reviews).length ? Object.fromEntries(Object.entries(v.reviews).filter(([, t]) => Number.isFinite(t))) : undefined });
  }
  const live = view.live?.state === "live" ? { version: String(view.live.version).replace(/^v/, ""), at: view.now - (view.live.age ?? 0) } : undefined;
  // #C731 B4b: each card's expected version, from collector/expected.mjs (the Collector's own rule, never written by hand).
  // A card with a repo of its own is not in the team's queue (the config's repos are the names the cards carry); the ship candidate
  // the probe reads names the run on now, so a shipping card's version is that candidate's.
  const run = view.evidence?.ship?.value, runOf = {};
  if (run && typeof run.version === "string") for (const [id, c] of Object.entries(cards)) if (c.shipping) runOf[id] = `build/ship-v${run.version.replace(/^v/, "")}`;
  const own = (view.cards ?? []).filter((c) => !c.dropped).map((c) => ({ id: c.id, repo: c.repo ?? undefined, batch: c.batch ?? undefined, bump: c.bump ?? undefined }));
  const config = { phases: PHASES.map((p) => [p]), collector: { shipPhase: "ship", buildPhase: "build", lanePhases: ["build", "test"], repos: [...new Set(own.map((c) => c.repo).filter(Boolean))].map((name) => ({ name })) } };
  let expected = {};
  try { expected = expectedVersions({ cards: own, derived: cards, live: live ? { version: live.version } : {}, runOf, config }); } catch { expected = {}; }
  for (const [id, x] of Object.entries(expected)) if (cards[id]) cards[id].expected = x;
  // The card's wait (the page draws "Queued for board release" / "Waiting for install"): a card with a repo of its own, read at ship. Signed and
  // not on main: it waits for a board release; on main: it waits for the owner's deploy (the install). Never for a live card or a card with no repo.
  const rows = new Map((view.cards ?? []).map((c) => [c.id, c]));
  for (const [id, c] of Object.entries(cards)) {
    const v = view.evidence?.[`cards.${id}`]?.value;
    if (!rows.get(id)?.repo || c.phase !== "ship" || typeof v?.onMain !== "boolean") continue;
    c.wait = v.onMain ? "install" : "release";
    // #C838: a card waiting for the install names the deploy ask it waits on (its newest open ask, as #T<n>); the page says "no deploy ask yet" when it has none.
    if (v.onMain) { const open = (view.asks ?? []).filter((a) => a.card_id === id && !a.closed_at && Number.isInteger(a.num)); if (open.length) c.waitAsk = Math.max(...open.map((a) => a.num)); }
  }
  const rel = view.evidence?.releases?.value;
  return prune({ id: "all", at: view.now, cards, times: timesOfHistory(view.history), live, releaseTimes: rel && typeof rel === "object" && !Array.isArray(rel) && Object.keys(rel).length ? rel : undefined });
}

// The probe document the old `board_state` tool returned, from the evidence keys.
export function probeDoc(view) {
  const ev = view.evidence ?? {};
  const cards = {};
  for (const [key, e] of Object.entries(ev)) if (key.startsWith("cards.")) { const { lit, ...rest } = e.value ?? {}; cards[key.slice(6)] = rest; }
  const part = (k) => (ev[k] ? ev[k].value : undefined);
  const out = { v: 1, board: part("board") ?? { boardId: "", at: view.now }, cards, agents: part("agents") ?? {} };
  for (const k of ["ctx", "usage"]) if (part(k) !== undefined) out[k] = part(k);
  // #C988 (#C842's line): the Plan week tile shows the percent Claude shows, from a session's fresh reading, in place of the estimate.
  if (out.usage !== undefined) out.usage = withSessionWeek(out.usage, view, view.now);
  // stuck and ship are written only while they hold (the probe leaves the key out when nothing is stuck or no candidate is pushed),
  // so the store keeps the last value: it counts only while the probe keeps rewriting it (a reading older than 3 minutes is gone).
  // #C873: so does e2e (the product's daily full test run), rewritten every evidence run from the probe's own half-hour reading.
  for (const k of ["stuck", "ship", "e2e"]) if (ev[k] && view.now - ev[k].readAt <= STALE_AFTER_MS) out[k] = ev[k].value;
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
  // #C976: the install wait rows are stored for measuring the owner's install time, not drawn: the page reads every wait as busy or gate and
  // an open one as the card's status, and it already says "Waiting for install" from the card's wait. So they stay out of the step log here.
  if ((view.history ?? []).length) collections.steps = view.history.filter((h) => h.wait !== INSTALL_WAIT).map((h) => prune({ id: `h${h.id}`, init: h.card_id, phase: h.phase, kind: h.kind, at: h.at, who: h.who, wait: h.wait ?? undefined }));
  if (view.live?.state === "live") collections.meta = [{ id: "live", version: String(view.live.version).replace(/^v/, ""), at: view.now - (view.live.age ?? 0) }];
  // #C859: each repository's stack switch, for the page's switch and its stack groups.
  if ((view.stackSwitch ?? []).length) collections.meta = [...(collections.meta ?? []), { id: "stackSwitch", rows: view.stackSwitch.map((r) => ({ repo: r.repo, stack: r.stack === true, setBy: r.set_by, setAt: r.set_at })) }];
  if ((view.pings ?? []).length) collections.threadPings = view.pings.map((p) => ({ id: p.id, at: p.at })); // #C1009: the owner's Ping presses
  // #C880: refused writes on the page's "stuck" line (meta/stuck, which the old gate wrote and the page already draws as "<who> stuck on <card>: <why>").
  const stuck = stuckDoc(view);
  if (stuck) collections.meta = [...(collections.meta ?? []), stuck];
  applyThreads(collections, view); // before applyFiles: it adds assets to the messages
  applyFiles(collections, view);
  applyShips(collections, view);
  applyUsage(collections, view);
  applyApprovals(collections, view);
  return { tag: view.tag, at: view.now, collections, probe: probeDoc(view) };
}
