// The one-time import into the board store (#C719), DRY RUN FIRST. Reads the Collector's mirror (one JSON file per document) and
// reports what would be written and what the store's own rules would refuse, writing nothing. Rules (Director, #C719):
//  1 open = not done and its thread not resolved (answered but not closed is imported WITH the answer);
//  2 decision/choice/look -> Decision, action -> Action, answer -> Answer, later -> Later, session -> SessionStart; no approvals;
//  3 every row goes through the store's own rules (askRefusal, cardWriteRefusal); a refused open item is listed with rule and old
//    id, never dropped or patched; nothing is invented (no ETA, option, recommendation or asker);
//  4 numbers kept (#T from the thread, #C from the card); the counters start above the highest number on the old board, and at
//    the real run above the LIVE board's counters (--live-c / --live-t), never the mirror's;
//  5 no orphans: a message goes with an imported thread only; the rest of the history stays on the old board;
//  6 keyed by old id: the SQL is INSERT OR IGNORE, so a second run doubles nothing. The report compares its counts with the old
//    page's tab counts when they are given (--expect needs=N,later=N,lead=N,todo=N,ideas=N) and names every difference.
//   node import-mirror.mjs --mirror <dir> --owner <name> --roster A,B,C --lead <role> [--expect ...] [--live-c N --live-t N] [--sql <out file>]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { askRefusal, cardWriteRefusal, closeRefusal, listWriteRefusal, PHASES } from "../worker/board-rules.mjs";

const SIZES = ["XS", "S", "M", "L", "XL"], LEVELS = ["None", "Quick", "Full"];
// The old board kept free text in phaseReason; the store's rework_reason is one of five words. Only those five carry over.
const REWORK = ["bug found in test", "review findings", "design change", "security finding", "owner change"];
const flag = (v) => (v === true ? 1 : v === false ? 0 : null);
export const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const str = (v) => (typeof v === "string" && v.trim() ? v : null);
const TYPE = { decision: "Decision", choice: "Decision", look: "Decision", action: "Action", answer: "Answer", later: "Later", session: "SessionStart" };

// The page's rule for a thread: its last message marks it resolved (an owner's Ack on a card's thread is not).
export function threadResolved(msgs, hasCard) {
  const last = [...msgs].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).at(-1);
  return !!(last && last.resolved && !(last.kind === "ack" && hasCard));
}

export function cardRow(id, d) {
  if (!ID.test(id)) return { ok: false, rule: "card-id" };
  if (!str(d.name)) return { ok: false, rule: "card-shape", detail: "no title" };
  if (!Number.isInteger(d.num) || d.num < 1) return { ok: false, rule: "card-shape", detail: "no number" };
  const row = {
    id, num: d.num, title: d.name, summary: str(d.summary) ?? "", size: SIZES.includes(d.size) ? d.size : null, review_level: LEVELS.includes(d.level) ? d.level : null,
    track: "product", owner_role: str(d.who) ?? str(d.owner), next_note: str(d.nextNote), next_note_at: int(d.nextNoteAt), waiting_on: str(d.waitingOn),
    paused: d.status === "paused" ? 1 : 0, dropped: d.status === "dropped" ? 1 : 0, rework_reason: REWORK.includes(d.phaseReason) ? d.phaseReason : null, created_at: int(d.createdAt) ?? 0, updated_at: int(d.updatedAt) ?? int(d.createdAt) ?? 0,
    // The words the review skips depend on (Checker on v7): copied as they are, "not said" stays NULL.
    customer_text: flag(d.customerText), look_change: flag(d.lookChange), skip: Array.isArray(d.skip) ? JSON.stringify(d.skip) : null,
  };
  const bad = cardWriteRefusal({ id, title: row.title, summary: row.summary, size: row.size, review_level: row.review_level, track: row.track, owner_role: row.owner_role, next_note: row.next_note, waiting_on: row.waiting_on, paused: row.paused, dropped: row.dropped, ...(row.rework_reason ? { rework_reason: row.rework_reason } : {}), ...(row.customer_text !== null ? { customer_text: row.customer_text } : {}), ...(row.look_change !== null ? { look_change: row.look_change } : {}), ...(row.skip !== null ? { skip: d.skip } : {}) }, null);
  return bad ? { ok: false, ...bad } : { ok: true, row };
}

// An old item's images as the store's screenshots (#C824). The old board kept each as { label, option, url: "/_blob/<file id>" } (the
// store's file ids), which `String` turned into "[object Object]" (#T1701). The store names a screenshot "<file id>", "<file id> label" or
// "<file id> A: label" (parseShot in worker/file-store.mjs): a string that already has that shape is kept; an object with a /_blob/ url
// becomes one; anything else is dropped, never guessed.
const SHOT = /^[A-Za-z0-9_-]{16,64}(\s.*)?$/s;
export function shotsOf(images) {
  const out = [];
  for (const i of Array.isArray(images) ? images : []) {
    if (typeof i === "string") { if (SHOT.test(i)) out.push(i); continue; }
    const id = /^\/_blob\/([A-Za-z0-9_-]{16,64})$/.exec(typeof i?.url === "string" ? i.url : "")?.[1];
    if (!id) continue;
    const label = typeof i.label === "string" ? i.label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : "";
    const option = /^[A-D]$/.test(i.option ?? "") ? i.option : "";
    out.push(label ? (option ? `${id} ${option}: ${label}` : `${id} ${label}`) : id);
  }
  return out.slice(0, 8);
}

// An old waiting item as the store's ask: the parts come from the item as it is; nothing is made up.
// `lenient` (#C824, a CLOSED ask kept for the record): the store's rules for a new open ask (a Decision's options and recommended, an
// Action's expect, a Later's ETA) are not applied, because nothing will ask the owner again; the parts the old item has are kept as they are,
// and a Later without an ETA is given its closing time (the table needs one). Its type must still be one the store has.
export function askRow(id, d, { thread, askedBy, lenient = false }) {
  // #C748: a "later" item that carries options is a question the owner answers (a Decision with its options), not a Later: the store's
  // Later rule takes no options. Its ETA is carried as the Decision's "not before" (#C823): the owner is not asked until that date.
  const type = d.kind === "later" && Array.isArray(d.options) && d.options.length ? "Decision" : TYPE[d.kind];
  if (!type) return { ok: false, rule: "ask-type", detail: `kind ${d.kind ?? "none"}` };
  const ask = { type, title: str(d.title) ?? str(thread?.title) ?? str(d.question)?.slice(0, 120) ?? str(d.text)?.slice(0, 120), asked_by: str(d.from) ?? askedBy };
  // The old board stores options as [{key, label, recommended?}]; the store wants labels and the recommended label. Copied as it
  // is, nothing invented: no flagged option, no recommended, and the store's rule refuses it as before.
  const opts = Array.isArray(d.options) ? d.options : null;
  const label = (o) => (typeof o === "string" ? o : str(o?.label));
  const labels = opts?.map(label);
  const flagged = opts?.find((o) => o && typeof o === "object" && o.recommended === true);
  if (type === "Decision") Object.assign(ask, { question: str(d.question) ?? str(d.text), options: labels?.every(Boolean) ? labels : opts, recommended: flagged ? label(flagged) : d.recommended, ...(d.kind === "later" && Number.isFinite(d.eta) ? { eta_at: d.eta } : {}) });
  if (type === "Action") Object.assign(ask, { steps: d.steps, expect: d.expect, where: str(d.where) });
  if (type === "Answer") ask.question = str(d.question) ?? str(d.text);
  if (type === "Later") Object.assign(ask, { text: str(d.text) ?? str(d.question), ...(Number.isFinite(d.eta) ? { eta_at: d.eta } : {}), ...(Array.isArray(d.steps) && d.steps.length ? { steps: d.steps } : {}), ...(str(d.expect) ? { expect: d.expect } : {}), ...(str(d.where) ? { where: d.where } : {}) });
  if (type === "SessionStart") ask.words = str(d.words) ?? str(d.text);
  const shots = shotsOf(d.images);
  if (shots.length) ask.screenshots = shots;
  for (const k of Object.keys(ask)) if (ask[k] === undefined || ask[k] === null) delete ask[k];
  if (lenient && type === "Later" && !Number.isFinite(ask.eta_at)) ask.eta_at = int(d.doneAt) ?? int(d.response?.at) ?? int(d.respondedAt) ?? int(d.updatedAt) ?? int(d.since) ?? 1;
  const bad = lenient ? (ask.title ? null : { rule: "ask-title", detail: "no title" }) : askRefusal(ask, null);
  if (bad) return { ok: false, ...bad };
  const body = {};
  for (const k of ["question", "options", "recommended", "steps", "expect", "where", "text", "words", "screenshots"]) if (ask[k] !== undefined) body[k] = ask[k];
  const answered = d.response && typeof d.response === "object" ? int(d.response.at) ?? int(d.respondedAt) : null;
  // A Decision's old answer is the option's key (response.choice); the store's answer is the option's label.
  const chosen = type === "Decision" && opts ? opts.find((o) => o && typeof o === "object" && o.key === d.response?.choice) : null;
  const answer = !answered ? null : chosen ? label(chosen) : JSON.stringify(d.response);
  // answer_taken_at = the answer's own time: the first wake after the import must not hand Manager every old answer again.
  return { ok: true, row: { id, num: Number.isInteger(thread?.num) ? thread.num : null, type, title: ask.title, asked_by: ask.asked_by, card_id: null, body: JSON.stringify(body), eta_at: ask.eta_at ?? null, eta_precondition: null,
    created_at: int(d.since) ?? int(d.at) ?? 0, answered_at: answered, answer, answered_by: answered ? "owner" : null, answer_taken_at: answered, closed_at: null } };
}

// An old To-do or Ideas item as the store's list row (the owner's pick, 2026-11-09): the words as they are, no trigger or ETA
// made up. Only open (not done) items are imported; one the store's rule refuses is listed by old id, never patched.
export function listRow(kind, id, d) {
  if (!ID.test(id)) return { ok: false, rule: "list-id" };
  const fields = { kind, text: d.text, ...(str(d.area) ? { area: d.area } : {}), ...(str(d.kind) ? { category: d.kind } : {}), ...(str(d.note) ? { note: d.note } : {}), ...(d.rank !== undefined ? { rank: d.rank } : {}) };
  const bad = listWriteRefusal(fields, { create: true });
  if (bad) return { ok: false, ...bad };
  return { ok: true, row: { id, kind, text: d.text, area: str(d.area), category: str(d.kind), note: str(d.note), rank: int(d.rank), done: 0, done_at: null, added_at: int(d.addedAt) ?? 0 } };
}

// docs: { initiatives, waiting, threads, messages, ideas, todo } each { oldId: doc }. owner: the owner's name (to tell a lead's word from his).
export function plan(docs, { owner = "", roster = [], lead = "", liveC = 0, liveT = 0 } = {}) {
  const byThread = {};
  for (const [id, m] of Object.entries(docs.messages ?? {})) (byThread[m.thread] ??= []).push({ ...m, _id: id });
  const out = { historyCards: [], cards: [], asks: [], messages: [], refused: [], notes: [], defaulted: 0, skipped: { doneCards: 0, doneAsks: 0, resolvedAsks: 0 }, counts: { needs: 0, later: 0, lead: 0 }, counters: { C: 1, T: 1 } };
  const keep = new Set();
  for (const [id, d] of Object.entries(docs.initiatives ?? {})) {
    if (d.status === "done") {
      out.skipped.doneCards++;
      // Not a store card: a history row (title, size, level, times) so the old page's medians and Done list are not blank (#C723 B3b).
      const doneAt = int(d.doneAt);
      if (!d.dropped && str(d.name) && doneAt) out.historyCards.push({ id, num: int(d.num), title: d.name, size: SIZES.includes(d.size) ? d.size : null, review_level: LEVELS.includes(d.level) ? d.level : null, created_at: int(d.createdAt), done_at: doneAt });
      continue;
    }
    const r = cardRow(id, d);
    if (!r.ok) { out.refused.push({ kind: "card", id, rule: r.rule, detail: r.detail }); continue; }
    out.cards.push(r.row);
    if (str(d.thread)) keep.add(d.thread);
  }
  for (const [id, d] of Object.entries(docs.waiting ?? {})) {
    if (d.done) { out.skipped.doneAsks++; continue; }
    // The item's thread: its `thread` field, else the thread doc of the same id (the old board names it that way).
    const tid = str(d.thread) ?? (docs.threads?.[id] ? id : null), msgs = tid ? byThread[tid] ?? [] : [];
    if (tid && threadResolved(msgs, false)) { out.skipped.resolvedAsks++; continue; }
    // asked_by (Director): the item's `who` when it names a roster agent (never the owner), else the lead; counted when defaulted.
    const named = str(d.who) && d.who !== owner && roster.includes(d.who) ? d.who : null;
    if (!named) out.defaulted++;
    const r = askRow(id, { ...d, from: undefined }, { thread: docs.threads?.[tid], askedBy: named ?? str(lead) });
    if (!r.ok) { out.refused.push({ kind: "ask", id, rule: r.rule, detail: r.detail, type: d.kind }); continue; }
    if (r.row.num === null) out.notes.push({ id, note: "no thread number: the store would mint one above the counters" });
    out.asks.push(r.row);
    if (tid) keep.add(tid);
    if (d.kind === "later") out.counts.later++; else if (d.response) out.counts.lead++; else out.counts.needs++;
  }
  // The phase history (#C723 B3b): the old step log of the cards carried over, once, as source=import rows. A done card is not carried
  // over, so its steps are not either. A wait, an unknown kind, a time that is no time or a phase the store does not know is counted, not guessed.
  out.history = []; out.skipped.steps = 0;
  const carried = new Set([...out.cards, ...out.historyCards].map((c) => c.id));
  for (const s of Object.values(docs.steps ?? {})) {
    if (!carried.has(s?.init)) { out.skipped.steps++; continue; }
    if ((s.kind !== "start" && s.kind !== "end") || s.wait || !PHASES.includes(s.phase) || !int(s.at)) { out.refused.push({ kind: "step", id: `${s.init}/${s.phase}`, rule: "step-shape" }); continue; }
    out.history.push({ card_id: s.init, phase: s.phase, kind: s.kind, at: s.at, who: str(s.who), source: "import" });
  }
  out.history.sort((a, b) => a.at - b.at || a.card_id.localeCompare(b.card_id));
  for (const tid of keep) for (const m of byThread[tid] ?? []) {
    if (!str(m.from) || !str(m.text) || !int(m.at)) { out.refused.push({ kind: "message", id: m._id, rule: "message-shape" }); continue; }
    out.messages.push({ id: m._id, thread_id: tid, author: m.from, body: m.text, created_at: m.at, delivered_at: m.at });
  }
  out.lists = [];
  out.counts.todo = 0; out.counts.ideas = 0; out.skipped.doneLists = 0;
  for (const [kind, coll, key] of [["todo", "todo", "todo"], ["idea", "ideas", "ideas"]]) for (const [id, d] of Object.entries(docs[coll] ?? {})) {
    if (d.done) { out.skipped.doneLists++; continue; }
    const r = listRow(kind, id, d);
    if (!r.ok) { out.refused.push({ kind: "list", id, rule: r.rule, detail: r.detail }); continue; }
    out.lists.push(r.row); out.counts[key]++;
  }
  const nums = (c, f) => Object.values(docs[c] ?? {}).map((x) => (Number.isInteger(x[f]) ? x[f] : 0));
  out.counters.C = Math.max(liveC, 1 + Math.max(0, ...nums("initiatives", "num")));
  out.counters.T = Math.max(liveT, 1 + Math.max(0, ...nums("threads", "num")));
  // An item with no thread has no #T: it gets the next numbers above the counters (never a reused one), in old-id order.
  for (const a of out.asks.filter((x) => x.num === null).sort((x, y) => x.id.localeCompare(y.id))) a.num = out.counters.T++;
  return out;
}

// What the store already holds that the old board has since closed (Manager, #C719). storeAsks is the store's own list of asks
// (its view); only an ask the old board knows by the same id can be closed here, which is every ask this import created, and
// nothing else. An ask is closed on the old board when it is done or its thread is resolved. It goes through the store's own
// close rule (closeRefusal); one the rule refuses, and one the old board no longer has at all, are listed and block, never
// closed by guess. Messages are not touched: closing the ask closes its thread. Nothing is deleted.
export function closures(docs, storeAsks, { now }) {
  const byThread = {};
  for (const [id, m] of Object.entries(docs.messages ?? {})) (byThread[m.thread] ??= []).push({ ...m, _id: id });
  const out = { close: [], refused: [], unknown: [] };
  for (const s of storeAsks ?? []) {
    if (s.closed_at) continue;
    const d = docs.waiting?.[s.id];
    if (!d) { out.unknown.push({ id: s.id, rule: "not-on-old-board" }); continue; }
    const tid = str(d.thread) ?? (docs.threads?.[s.id] ? s.id : null), msgs = tid ? byThread[tid] ?? [] : [];
    const last = [...msgs].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).at(-1);
    if (!d.done && !(tid && threadResolved(msgs, false))) continue; // still open there too
    const bad = closeRefusal(s, "owner", "owner"); // the old board's resolve was the owner's
    if (bad) { out.refused.push({ id: s.id, rule: bad.rule, detail: bad.detail }); continue; }
    out.close.push({ id: s.id, at: int(d.doneAt) ?? int(last?.at) ?? now });
  }
  return out;
}

// The plan with the store's asks: what to close, and how many asks the store will hold open afterwards (it must equal the old
// board's open asks: the ones the plan adds that the store lacks, plus the ones it has that stay open).
export function withStore(p, docs, storeAsks, now, storeLists = []) {
  p.closures = closures(docs, storeAsks, { now });
  // A to-do or idea the store holds open that the old board has since marked done is marked done there too (by old id).
  const oldOf = (l) => docs[l.kind === "todo" ? "todo" : "ideas"]?.[l.id];
  p.closures.lists = storeLists.filter((l) => !l.done && oldOf(l)?.done).map((l) => ({ id: l.id, at: int(oldOf(l).doneAt) ?? now }));
  const closing = new Set(p.closures.close.map((c) => c.id)), have = new Set(storeAsks.map((s) => s.id));
  p.openAsksAfter = storeAsks.filter((s) => !s.closed_at && !closing.has(s.id)).length + p.asks.filter((a) => !have.has(a.id)).length;
  return p;
}

const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
const insert = (t, row) => `INSERT OR IGNORE INTO ${t} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(q).join(", ")});`;
// Keyed by old id: running it twice changes nothing. The counters only ever go up. A card row that already exists (an earlier
// run, made before the review-skip columns) keeps everything it has; only the three skip columns are filled in from the old
// card, by id. This file is run once, before cut-over: after it, those columns belong to the cards' own writes.
const skipUpdate = (r) => `UPDATE cards SET customer_text = ${q(r.customer_text)}, look_change = ${q(r.look_change)}, skip = ${q(r.skip)} WHERE id = ${q(r.id)};`;
// An ask the old board has since closed is closed in the store, once (closed_at stays as it is if the store already closed it).
const closeUpdate = (c) => `UPDATE asks SET closed_at = ${q(c.at)}, closed_by = 'import' WHERE id = ${q(c.id)} AND closed_at IS NULL;`;
export function toSql(p) {
  return [...p.cards.map((r) => insert("cards", r)), ...p.cards.map(skipUpdate), ...p.asks.map((r) => insert("asks", r)), ...p.messages.map((r) => insert("messages", r)), ...(p.lists ?? []).map((r) => insert("lists", r)), ...(p.historyCards ?? []).map((r) => insert("history_cards", r)), ...(p.history ?? []).map((r) => insert("phase_history", r)), ...(p.closures?.close ?? []).map(closeUpdate), ...(p.closures?.lists ?? []).map((c) => `UPDATE lists SET done = 1, done_at = ${q(c.at)} WHERE id = ${q(c.id)} AND done = 0;`),
    `UPDATE counters SET next = MAX(next, ${p.counters.C}) WHERE name = 'C';`, `UPDATE counters SET next = MAX(next, ${p.counters.T}) WHERE name = 'T';`].join("\n");
}

export function compare(counts, expect) {
  const map = { needs: "Needs you", later: "Later", lead: "With the team", todo: "To-do", ideas: "Ideas" };
  return Object.keys(map).filter((k) => expect[k] !== undefined && expect[k] !== counts[k]).map((k) => `${map[k]}: old page ${expect[k]}, import ${counts[k]}`);
}

// The Collector's mirror has no to-do collection; todoDir is a read of the old board's `todo` documents, one JSON file each.
export function readMirror(dir, { todoDir } = {}) {
  const docs = {};
  const read = (name, from) => {
    docs[name] = {};
    for (const f of readdirSync(from)) if (f.endsWith(".json")) { try { docs[name][f.slice(0, -5)] = JSON.parse(readFileSync(join(from, f), "utf8")); } catch { /* skipped */ } }
  };
  for (const c of ["initiatives", "threads", "messages", "waiting", "ideas", "steps"]) { try { read(c, join(dir, c)); } catch (e) { if (c !== "steps") throw e; docs.steps = {}; } }
  if (todoDir) {
    read("todo", todoDir);
    // A --todo folder with no documents (the parent of the folder that holds them, a typo) would import every to-do as missing and
    // report 0 open, with no error: refuse it by name instead.
    if (!Object.keys(docs.todo).length) throw new Error(`--todo ${todoDir} holds no .json documents: pass the folder that holds the old board's todo documents`);
  }
  return docs;
}

export function report(p, expect = {}) {
  const tally = {};
  for (const r of p.refused) { const k = `${r.kind}:${r.rule}`; tally[k] = (tally[k] ?? 0) + 1; }
  return { cards: p.cards.length, asks: p.asks.length, messages: p.messages.length, skipped: p.skipped, counts: p.counts, refusedTally: tally, refused: p.refused.filter((r) => r.kind !== "message"), notes: p.notes, askedByDefaulted: p.defaulted, counters: p.counters, differences: compare(p.counts, expect), ...(p.closures ? { closures: p.closures, openAsksAfter: p.openAsksAfter, openAsksMatchOldBoard: p.openAsksAfter === p.asks.length } : {}), lists: (p.lists ?? []).length, history: (p.history ?? []).length, historyCards: (p.historyCards ?? []).length, unchecked: ["needs", "later", "lead", "todo", "ideas"].filter((k) => expect[k] === undefined) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const get = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
  if (!get("--mirror")) { console.error("pass --mirror <dir>"); process.exit(64); }
  const expect = Object.fromEntries((get("--expect") ?? "").split(",").filter(Boolean).map((x) => x.split("=")).map(([k, v]) => [k, Number(v)]));
  const docs = readMirror(get("--mirror"), { todoDir: get("--todo") });
  const p = plan(docs, { owner: get("--owner") ?? "", roster: (get("--roster") ?? "").split(",").filter(Boolean), lead: get("--lead") ?? "", liveC: Number(get("--live-c") ?? 0), liveT: Number(get("--live-t") ?? 0) });
  // --store <file>: the store's own view as JSON (a read of /api/view). Given, the dry run also lists every ask it would close.
  if (get("--store")) { const v = JSON.parse(readFileSync(get("--store"), "utf8")); withStore(p, docs, v.asks ?? [], Number(get("--now") ?? Date.now()), v.lists ?? []); }
  console.log(JSON.stringify(report(p, expect), null, 2));
  if (get("--sql")) writeFileSync(get("--sql"), toSql(p));
}
