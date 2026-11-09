// The one-time import into the board store (#C719), DRY RUN FIRST: reads the Collector's mirror (one JSON file per document in
// <mirror>/{initiatives,threads,messages,waiting}/) and reports what would be written and what would be refused, without
// touching the store. `plan()` is pure; the CLI prints counts and ids only, never document text.
//   node import-mirror.mjs --mirror <dir> [--json <out file>]
// Mapping: initiatives -> cards (open and dropped cards; done cards are history and are counted, not imported, because a done
// card's status lives in evidence and the store keeps no row for it), messages -> messages (delivered, so no old line wakes
// anyone), threads -> counted only (a message names its thread). waiting -> asks is NOT mapped here: its kinds do not line
// up with the eight ask types, which is a design question for the Director; they are counted by kind.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SIZES = ["XS", "S", "M", "L", "XL"], LEVELS = ["None", "Quick", "Full"];
const REWORK = ["bug found in test", "review findings", "design change", "security finding", "owner change"];
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const str = (v) => (typeof v === "string" ? v : null);

export function cardRow(id, d) {
  const why = [];
  if (!ID.test(id)) why.push("card-id");
  if (!str(d.name)?.trim()) why.push("no-title");
  if (!Number.isInteger(d.num) || d.num < 1) why.push("no-num");
  if (why.length) return { ok: false, why };
  return { ok: true, row: {
    id, num: d.num, title: d.name, summary: str(d.summary) ?? "",
    size: SIZES.includes(d.size) ? d.size : null, review_level: LEVELS.includes(d.level) ? d.level : null,
    track: "product", owner_role: str(d.who) ?? str(d.owner), next_note: str(d.nextNote), next_note_at: int(d.nextNoteAt),
    waiting_on: str(d.waitingOn), paused: d.status === "paused" ? 1 : 0, dropped: d.status === "dropped" ? 1 : 0,
    rework_reason: REWORK.includes(d.phaseReason) ? d.phaseReason : null,
    created_at: int(d.createdAt) ?? 0, updated_at: int(d.updatedAt) ?? int(d.createdAt) ?? 0,
  } };
}

export function messageRow(d, id) {
  if (!str(d.thread) || !str(d.from) || !str(d.text) || !int(d.at)) return { ok: false, why: ["message-shape"] };
  return { ok: true, row: { id: str(d.id) ?? id, thread_id: d.thread, author: d.from, body: d.text, created_at: d.at, delivered_at: d.at } };
}

// docs: { initiatives: {id: doc}, messages: {id: doc}, threads: {id: doc}, waiting: {id: doc} }
export function plan(docs) {
  const out = { cards: [], messages: [], skipped: { doneCards: 0 }, refused: { cards: {}, messages: {} }, nums: new Set(), waitingByKind: {}, threads: Object.keys(docs.threads ?? {}).length, counters: { C: 1, T: 1 } };
  const bump = (m, w) => { for (const r of w) m[r] = (m[r] ?? 0) + 1; };
  for (const [id, d] of Object.entries(docs.initiatives ?? {})) {
    if (d.status === "done") { out.skipped.doneCards++; continue; }
    const r = cardRow(id, d);
    if (!r.ok) { bump(out.refused.cards, r.why); continue; }
    if (out.nums.has(r.row.num)) { bump(out.refused.cards, ["duplicate-num"]); continue; }
    out.nums.add(r.row.num); out.cards.push(r.row);
  }
  // The counter continues after the highest number in the whole mirror, done cards included: a number is never reused.
  out.counters.C = 1 + Math.max(0, ...Object.values(docs.initiatives ?? {}).map((d) => (Number.isInteger(d.num) ? d.num : 0)));
  out.counters.T = 1 + Math.max(0, ...Object.values(docs.threads ?? {}).map((d) => (Number.isInteger(d.num) ? d.num : 0)));
  for (const [id, d] of Object.entries(docs.messages ?? {})) {
    const r = messageRow(d, id);
    if (r.ok) out.messages.push(r.row); else bump(out.refused.messages, r.why);
  }
  for (const d of Object.values(docs.waiting ?? {})) { const k = str(d.kind) ?? "none"; out.waitingByKind[k] = (out.waitingByKind[k] ?? 0) + 1; }
  return out;
}

export function readMirror(dir) {
  const docs = {};
  for (const c of ["initiatives", "threads", "messages", "waiting"]) {
    docs[c] = {};
    for (const f of readdirSync(join(dir, c))) {
      if (!f.endsWith(".json")) continue;
      try { docs[c][f.slice(0, -5)] = JSON.parse(readFileSync(join(dir, c, f), "utf8")); } catch { /* an unreadable file is skipped, and counted below */ docs[c].__unreadable = (docs[c].__unreadable ?? 0) + 1; }
    }
  }
  return docs;
}

export function report(p) {
  return { cards: p.cards.length, doneCardsNotImported: p.skipped.doneCards, cardsRefused: p.refused.cards, messages: p.messages.length, messagesRefused: p.refused.messages, threads: p.threads, waitingByKind: p.waitingByKind, counters: p.counters };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const get = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
  if (!get("--mirror")) { console.error("pass --mirror <dir>"); process.exit(64); }
  const docs = readMirror(get("--mirror"));
  for (const c of Object.keys(docs)) delete docs[c].__unreadable;
  const p = plan(docs);
  console.log(JSON.stringify(report(p), null, 2));
  if (get("--json")) writeFileSync(get("--json"), JSON.stringify({ cards: p.cards, messages: p.messages, counters: p.counters }));
}
