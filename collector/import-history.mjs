// The old board's history for the switch-time rerun (#C749): what the first import left out because it took open items only.
// Four readers, all INSERT OR IGNORE by their own key (a row the store already holds is never changed), no deploy:
//   usage   the old usage days (runner, automation minutes, Actions dollars) the store has no row for (the probe's own days are never touched);
//   ships   the old Shipped feed (the `events` collection) as ships rows, for the versions the store lacks;
//   steps   the old step log of the done cards the store keeps as history cards, with the wait column (migration 0018), in the window;
//   resolved the threads closed within the window: their messages, the closing message's `resolved` flag, and their #T rows.
// Pure: documents in, rows and a report out. The SQL is built by historySql, with the caller's quoting (q) so one rule covers every line.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ID } from "./import-mirror.mjs";
import { PHASES } from "../worker/board-rules.mjs";
import { plainVersion } from "../worker/compat-ships.mjs";

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WAITS = ["busy", "gate", "decision"];
const MSG_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_TEXT = 8000;
// A control character other than tab and newline never reaches the SQL (the caller's q would throw and stop the whole run): the item is refused.
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const str = (v) => (typeof v === "string" && v.trim() && !CTRL.test(v) ? v : null);
const time = (v) => (Number.isInteger(v) && v > 1_577_836_800_000 && v < 4_102_444_800_000 ? v : null);
const minutes = (v) => (Number.isFinite(v) && v >= 0 && v < 1e6 ? v : null);

export function readHistory(dir) {
  const docs = {};
  for (const name of ["usage", "events", "steps", "threads", "messages", "initiatives"]) {
    docs[name] = {};
    const from = join(dir, name);
    if (!existsSync(from)) continue;
    for (const f of readdirSync(from)) if (f.endsWith(".json")) { try { docs[name][f.slice(0, -5)] = JSON.parse(readFileSync(join(from, f), "utf8")); } catch { /* a file that is not JSON is skipped */ } }
  }
  return docs;
}

// have: what the store holds: usageDays, shipVersions, historyCardIds, cardIds (Sets), messageIds, threadIds (Sets), cardsByNum (Map num -> id).
export function planHistory(docs, { have = {}, now = Date.now(), days = 30 } = {}) {
  const cutoff = now - days * DAY_MS;
  const set = (k) => have[k] ?? new Set();
  const out = { usage: [], ships: [], steps: [], threads: [], messages: [], resolve: [], report: {} };
  const rep = out.report;

  // 1. Usage days. The store's own days (the probe posts them) are never touched.
  rep.usage = { new: 0, held: 0, refused: [] };
  for (const [id, d] of Object.entries(docs.usage ?? {})) {
    const day = str(d?.day) ?? id;
    const runner = minutes(d?.runnerMin ?? 0), auto = minutes(d?.actionsMin ?? 0), usd = minutes(d?.actionsUsd ?? 0);
    if (!DAY.test(day) || runner === null || auto === null || usd === null) { rep.usage.refused.push(id); continue; }
    if (set("usageDays").has(day)) { rep.usage.held++; continue; }
    out.usage.push({ day, runner_minutes: runner, automation_minutes: auto, actions_usd: usd });
    rep.usage.new++;
  }
  out.usage.sort((a, b) => a.day.localeCompare(b.day));

  // 2. The Shipped feed: an event with a version (x.y.z) becomes a ships row. Its cards are the ones it lists, else the #C<n> in its text that
  // the store knows by number; the rest is counted, never guessed. A version the store holds is never changed; the earliest time wins.
  const ships = new Map();
  rep.ships = { new: 0, held: 0, notAVersion: 0, outsideWindow: 0, noCards: [], unmatchedNumbers: 0 };
  for (const [id, e] of Object.entries(docs.events ?? {})) {
    const v = plainVersion(typeof e?.version === "string" ? e.version.replace(/^board\s+/i, "") : "");
    if (!v) { rep.ships.notAVersion++; continue; }
    const at = time(e.at);
    if (at === null || at < cutoff) { rep.ships.outsideWindow++; continue; }
    let cards = Array.isArray(e.cards) ? e.cards.filter((c) => typeof c === "string" && ID.test(c)) : [];
    if (!cards.length && typeof e.text === "string") {
      for (const m of e.text.matchAll(/#C(\d{1,7})/g)) {
        const cid = set("cardsByNum") instanceof Map ? set("cardsByNum").get(Number(m[1])) : undefined;
        if (cid) { if (!cards.includes(cid)) cards.push(cid); } else rep.ships.unmatchedNumbers++;
      }
    }
    const prev = ships.get(v);
    if (prev) { prev.shipped_at = Math.min(prev.shipped_at, at); for (const c of cards) if (!prev.cards.includes(c)) prev.cards.push(c); continue; }
    ships.set(v, { version: v, cards, shipped_at: at, _id: id });
  }
  for (const s of [...ships.values()].sort((a, b) => a.shipped_at - b.shipped_at)) {
    if (set("shipVersions").has(s.version)) { rep.ships.held++; continue; }
    if (!s.cards.length) rep.ships.noCards.push(s.version);
    out.ships.push({ version: s.version, cards: JSON.stringify(s.cards), shipped_at: s.shipped_at });
    rep.ships.new++;
  }

  // 3a. The done cards of the old board the store keeps no row for (cards finished since the first import, below the board's own numbers):
  // a history card each (title, size, level, times), as the first import made them, so their steps and the Done list have somewhere to go.
  // A card that was dropped, or has no title or no done time, is not one. The store's own cards and history cards are never touched.
  out.historyCards = [];
  rep.historyCards = { new: 0, held: 0, notDone: 0, refused: 0 };
  const known = new Set([...set("historyCardIds"), ...set("cardIds")]);
  for (const [rawId, d] of Object.entries(docs.initiatives ?? {})) {
    const id = rawId.toLowerCase();
    if (!d || d.deleted === true || d.status !== "done" || d.dropped) { rep.historyCards.notDone++; continue; }
    if (known.has(id)) { rep.historyCards.held++; continue; }
    const doneAt = time(d.doneAt);
    if (!ID.test(id) || !str(d.name) || doneAt === null) { rep.historyCards.refused++; continue; }
    out.historyCards.push({ id, num: Number.isInteger(d.num) && d.num >= 1 && d.num <= 1e6 ? d.num : null, title: d.name, size: ["XS", "S", "M", "L", "XL"].includes(d.size) ? d.size : null, review_level: ["None", "Quick", "Full"].includes(d.level) ? d.level : null, created_at: time(d.createdAt), done_at: doneAt });
    known.add(id);
    rep.historyCards.new++;
  }
  const doneIds = new Set([...set("historyCardIds"), ...out.historyCards.map((c) => c.id)]);

  // 3. The step log of the done cards the store keeps as history cards, in the window. A card the store runs (the probe writes its history)
  // and a card the store has no row for are counted, not written.
  rep.steps = { new: 0, outsideWindow: 0, notDoneCard: 0, noCardOnTheStore: 0, noCardIds: [], refused: 0, refusedBy: {}, waits: 0 };
  const seenNo = new Set(), seenKey = new Set();
  for (const s of Object.values(docs.steps ?? {})) {
    const card = typeof s?.init === "string" ? s.init.toLowerCase() : ""; // the old numbered cards were "C547": the store's ids are lower case
    const at = time(s?.at);
    const why = !ID.test(card) ? "card-id" : s.kind !== "start" && s.kind !== "end" ? `kind ${String(s.kind).slice(0, 12)}` : !PHASES.includes(s.phase) ? `phase ${String(s.phase).slice(0, 12)}` : at === null ? "time" : null;
    if (why) { rep.steps.refused++; rep.steps.refusedBy[why] = (rep.steps.refusedBy[why] ?? 0) + 1; continue; }
    if (at < cutoff) { rep.steps.outsideWindow++; continue; }
    if (s.wait && !WAITS.includes(s.wait)) { rep.steps.refused++; continue; }
    if (!doneIds.has(card)) {
      if (set("cardIds").has(card)) rep.steps.notDoneCard++; else { rep.steps.noCardOnTheStore++; seenNo.add(card); }
      continue;
    }
    const key = `${card}|${s.phase}|${s.kind}|${at}|${s.wait ?? ""}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    out.steps.push({ card_id: card, phase: s.phase, kind: s.kind, at, who: str(s.who), source: "import", wait: s.wait ?? null });
    rep.steps.new++;
    if (s.wait) rep.steps.waits++;
  }
  rep.steps.noCardOnTheStoreCards = seenNo.size;
  rep.steps.noCardIds = [...seenNo].sort().slice(0, 10); // a sample; the count is above
  rep.ships.noCardsCount = rep.ships.noCards.length; rep.ships.noCards = rep.ships.noCards.slice(0, 5);
  out.steps.sort((a, b) => a.at - b.at || a.card_id.localeCompare(b.card_id));

  // 4. Threads closed in the window: every message of the thread, the closing one flagged resolved, and the thread's #T number.
  rep.resolved = { threads: 0, messages: 0, flagged: 0, refused: 0 };
  const byThread = new Map();
  for (const [id, m] of Object.entries(docs.messages ?? {})) {
    if (!m || m.deleted === true) continue;
    const thread = typeof m.thread === "string" ? m.thread : "";
    if (!byThread.has(thread)) byThread.set(thread, []);
    byThread.get(thread).push({ ...m, _id: id });
  }
  for (const [tid, list] of byThread) {
    list.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const last = list.at(-1);
    if (!tid || !MSG_ID.test(tid) || !last?.resolved || (time(last.at) ?? 0) < cutoff) continue;
    const ok = list.filter((m) => MSG_ID.test(m._id) && str(m.from) && typeof m.text === "string" && m.text.trim() && !CTRL.test(m.text) && m.text.length <= MAX_TEXT && time(m.at) !== null);
    rep.resolved.refused += list.length - ok.length;
    if (!ok.length) continue;
    rep.resolved.threads++;
    for (const m of ok) {
      const isResolving = m.resolved === true;
      if (!set("messageIds").has(m._id)) {
        out.messages.push({ id: m._id, thread_id: tid, author: m.from, body: m.text, created_at: m.at, kind: str(m.kind), resolved: isResolving ? 1 : 0, delivered_at: m.at });
        rep.resolved.messages++;
      } else if (isResolving) out.resolve.push(m._id);
      if (isResolving) rep.resolved.flagged++;
    }
    const t = docs.threads?.[tid];
    if (t && Number.isInteger(t.num) && t.num >= 1 && t.num <= 1e6 && !set("threadIds").has(tid)) out.threads.push({ id: tid, num: t.num, title: str(t.title), created_at: ok[0].at });
  }
  return out;
}

// The SQL, one statement a line. q quotes a value (the caller's: it throws on a control character). Every line is by its own key and
// ignores a row that is there; the one UPDATE only sets a flag that is 0.
export function historySql(h, q) {
  const insert = (t, row) => `INSERT OR IGNORE INTO ${t} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(q).join(", ")});`;
  return [
    ...h.usage.map((r) => insert("usage_days", r)),
    ...h.ships.map((r) => insert("ships", r)),
    ...(h.historyCards ?? []).map((r) => insert("history_cards", r)),
    ...h.steps.map((r) => insert("phase_history", r)),
    ...h.threads.map((r) => insert("threads", r)),
    ...h.messages.map((r) => insert("messages", r)),
    ...h.resolve.map((id) => `UPDATE messages SET resolved = 1 WHERE id = ${q(id)} AND resolved = 0;`),
  ];
}
