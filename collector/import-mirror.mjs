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
import { askRefusal, cardWriteRefusal } from "../worker/board-rules.mjs";

const SIZES = ["XS", "S", "M", "L", "XL"], LEVELS = ["None", "Quick", "Full"];
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
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
    paused: d.status === "paused" ? 1 : 0, dropped: d.status === "dropped" ? 1 : 0, rework_reason: str(d.phaseReason), created_at: int(d.createdAt) ?? 0, updated_at: int(d.updatedAt) ?? int(d.createdAt) ?? 0,
  };
  const bad = cardWriteRefusal({ id, title: row.title, summary: row.summary, size: row.size, review_level: row.review_level, track: row.track, owner_role: row.owner_role, next_note: row.next_note, waiting_on: row.waiting_on, paused: row.paused, dropped: row.dropped, ...(row.rework_reason ? { rework_reason: row.rework_reason } : {}) }, null);
  return bad ? { ok: false, ...bad } : { ok: true, row };
}

// An old waiting item as the store's ask: the parts come from the item as it is; nothing is made up.
export function askRow(id, d, { thread, askedBy }) {
  const type = TYPE[d.kind];
  if (!type) return { ok: false, rule: "ask-type", detail: `kind ${d.kind ?? "none"}` };
  const ask = { type, title: str(d.title) ?? str(thread?.title) ?? str(d.question)?.slice(0, 120) ?? str(d.text)?.slice(0, 120), asked_by: str(d.from) ?? askedBy };
  if (type === "Decision") Object.assign(ask, { question: str(d.question) ?? str(d.text), options: d.options, recommended: d.recommended });
  if (type === "Action") Object.assign(ask, { steps: d.steps, expect: d.expect });
  if (type === "Answer") ask.question = str(d.question) ?? str(d.text);
  if (type === "Later") Object.assign(ask, { text: str(d.text) ?? str(d.question), ...(Number.isFinite(d.eta) ? { eta_at: d.eta } : {}) });
  if (type === "SessionStart") ask.words = str(d.words) ?? str(d.text);
  if (Array.isArray(d.images) && d.images.length) ask.screenshots = d.images.map(String);
  for (const k of Object.keys(ask)) if (ask[k] === undefined || ask[k] === null) delete ask[k];
  const bad = askRefusal(ask, null);
  if (bad) return { ok: false, ...bad };
  const body = {};
  for (const k of ["question", "options", "recommended", "steps", "expect", "text", "words", "screenshots"]) if (ask[k] !== undefined) body[k] = ask[k];
  const answered = d.response && typeof d.response === "object" ? int(d.response.at) ?? int(d.respondedAt) : null;
  return { ok: true, row: { id, num: Number.isInteger(thread?.num) ? thread.num : null, type, title: ask.title, asked_by: ask.asked_by, card_id: null, body: JSON.stringify(body), eta_at: ask.eta_at ?? null, eta_precondition: null,
    created_at: int(d.since) ?? int(d.at) ?? 0, answered_at: answered, answer: answered ? JSON.stringify(d.response) : null, closed_at: null } };
}

// docs: { initiatives, waiting, threads, messages } each { oldId: doc }. owner: the owner's name (to tell a lead's word from his).
export function plan(docs, { owner = "", roster = [], lead = "", liveC = 0, liveT = 0 } = {}) {
  const byThread = {};
  for (const [id, m] of Object.entries(docs.messages ?? {})) (byThread[m.thread] ??= []).push({ ...m, _id: id });
  const out = { cards: [], asks: [], messages: [], refused: [], notes: [], defaulted: 0, skipped: { doneCards: 0, doneAsks: 0, resolvedAsks: 0 }, counts: { needs: 0, later: 0, lead: 0 }, counters: { C: 1, T: 1 } };
  const keep = new Set();
  for (const [id, d] of Object.entries(docs.initiatives ?? {})) {
    if (d.status === "done") { out.skipped.doneCards++; continue; }
    const r = cardRow(id, d);
    if (!r.ok) { out.refused.push({ kind: "card", id, rule: r.rule, detail: r.detail }); continue; }
    out.cards.push(r.row);
    if (str(d.thread)) keep.add(d.thread);
  }
  for (const [id, d] of Object.entries(docs.waiting ?? {})) {
    if (d.done) { out.skipped.doneAsks++; continue; }
    const tid = str(d.thread), msgs = tid ? byThread[tid] ?? [] : [];
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
  for (const tid of keep) for (const m of byThread[tid] ?? []) {
    if (!str(m.from) || !str(m.text) || !int(m.at)) { out.refused.push({ kind: "message", id: m._id, rule: "message-shape" }); continue; }
    out.messages.push({ id: m._id, thread_id: tid, author: m.from, body: m.text, created_at: m.at, delivered_at: m.at });
  }
  const nums = (c, f) => Object.values(docs[c] ?? {}).map((x) => (Number.isInteger(x[f]) ? x[f] : 0));
  out.counters.C = Math.max(liveC, 1 + Math.max(0, ...nums("initiatives", "num")));
  out.counters.T = Math.max(liveT, 1 + Math.max(0, ...nums("threads", "num")));
  // An item with no thread has no #T: it gets the next numbers above the counters (never a reused one), in old-id order.
  for (const a of out.asks.filter((x) => x.num === null).sort((x, y) => x.id.localeCompare(y.id))) a.num = out.counters.T++;
  return out;
}

const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
const insert = (t, row) => `INSERT OR IGNORE INTO ${t} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(q).join(", ")});`;
// Keyed by old id: running it twice changes nothing. The counters only ever go up.
export function toSql(p) {
  return [...p.cards.map((r) => insert("cards", r)), ...p.asks.map((r) => insert("asks", r)), ...p.messages.map((r) => insert("messages", r)),
    `UPDATE counters SET next = MAX(next, ${p.counters.C}) WHERE name = 'C';`, `UPDATE counters SET next = MAX(next, ${p.counters.T}) WHERE name = 'T';`].join("\n");
}

export function compare(counts, expect) {
  const map = { needs: "Needs you", later: "Later", lead: "With the team" };
  return Object.keys(map).filter((k) => expect[k] !== undefined && expect[k] !== counts[k]).map((k) => `${map[k]}: old page ${expect[k]}, import ${counts[k]}`);
}

export function readMirror(dir) {
  const docs = {};
  for (const c of ["initiatives", "threads", "messages", "waiting"]) {
    docs[c] = {};
    for (const f of readdirSync(join(dir, c))) if (f.endsWith(".json")) { try { docs[c][f.slice(0, -5)] = JSON.parse(readFileSync(join(dir, c, f), "utf8")); } catch { /* skipped */ } }
  }
  return docs;
}

export function report(p, expect = {}) {
  const tally = {};
  for (const r of p.refused) { const k = `${r.kind}:${r.rule}`; tally[k] = (tally[k] ?? 0) + 1; }
  return { cards: p.cards.length, asks: p.asks.length, messages: p.messages.length, skipped: p.skipped, counts: p.counts, refusedTally: tally, refused: p.refused.filter((r) => r.kind !== "message"), notes: p.notes, askedByDefaulted: p.defaulted, counters: p.counters, differences: compare(p.counts, expect), unchecked: ["To-do", "Ideas", ...(["needs", "later", "lead"].filter((k) => expect[k] === undefined).map((k) => k))] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const get = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
  if (!get("--mirror")) { console.error("pass --mirror <dir>"); process.exit(64); }
  const expect = Object.fromEntries((get("--expect") ?? "").split(",").filter(Boolean).map((x) => x.split("=")).map(([k, v]) => [k, Number(v)]));
  const p = plan(readMirror(get("--mirror")), { owner: get("--owner") ?? "", roster: (get("--roster") ?? "").split(",").filter(Boolean), lead: get("--lead") ?? "", liveC: Number(get("--live-c") ?? 0), liveT: Number(get("--live-t") ?? 0) });
  console.log(JSON.stringify(report(p, expect), null, 2));
  if (get("--sql")) writeFileSync(get("--sql"), toSql(p));
}
