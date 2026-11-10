// Board store operations on D1 (#C719). Every write goes through the rules in board-rules.mjs in the same call; a refusal is
// logged (rule, card, who, time) and returned, nothing is written. `db` is a D1 binding (or tests/helpers/d1-sqlite.mjs).
import { askRefusal, cardWriteRefusal, closeRefusal, withdrawRefusal, answerShapeRefusal, messageExtrasRefusal, listWriteRefusal, evidenceRefusal, liveNow, historyRows, whoForPhase, stalledWaits, stepRefusal, ASK_PARTS, APPROVE } from "./board-rules.mjs";
import { classifySend, nudgeLine, shouldSend, wakeStatus, shouldTellOwner } from "./wake-rules.mjs";
import { readFiles, screenshotsRefusal } from "./file-store.mjs";
import { noteShip, readShips } from "./compat-ships.mjs";
import { readUsage } from "./compat-usage.mjs";
import { readThreads } from "./compat-threads.mjs";

export const PROBE_SILENT_MS = 3 * 60_000;
const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// The store mints #C and #T numbers: one atomic statement, never a read-then-write.
export async function mint(db, name) {
  const r = await db.prepare("UPDATE counters SET next = next + 1 WHERE name = ? RETURNING next - 1 AS n").bind(name).first();
  return r.n;
}

export async function refuse(db, now, refusal, cardId, who) {
  await db.prepare("INSERT INTO refusals (at, rule, card_id, who, detail) VALUES (?, ?, ?, ?, ?)").bind(now, refusal.rule, cardId ?? null, who ?? null, String(refusal.detail ?? "").slice(0, 300)).run();
  return { ok: false, refused: refusal };
}

const evidenceOf = async (db, key) => {
  const r = await db.prepare("SELECT value FROM evidence WHERE key = ?").bind(key).first();
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
};

const COLUMNS = ["title", "summary", "size", "review_level", "from_thread", "track", "owner_role", "next_note", "waiting_on", "blocked_reason", "paused", "dropped", "rework_reason", "customer_text", "look_change", "skip", "depends_on", "issues", "queue_pos", "check_at", "repo", "batch", "bump"];
// true/false are stored as 1/0; a list or the issue counts are stored as JSON text (null stays null: "not said").
const bool = (v) => (v === true ? 1 : v === false ? 0 : Array.isArray(v) || (v && typeof v === "object") ? JSON.stringify(v) : v);

// A new card: words only. The id is the caller's, the number the store's.
export async function createCard(db, now, who, fields) {
  const bad = cardWriteRefusal(fields, null);
  if (bad) return refuse(db, now, bad, fields?.id, who);
  if (typeof fields.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(fields.id)) return refuse(db, now, { rule: "card-id", detail: "lowercase letters, digits, hyphens" }, fields.id, who);
  if (typeof fields.title !== "string" || !fields.title.trim()) return refuse(db, now, { rule: "card-shape", detail: "title is required" }, fields.id, who);
  if (await db.prepare("SELECT 1 AS x FROM cards WHERE id = ?").bind(fields.id).first()) return refuse(db, now, { rule: "card-exists", detail: fields.id }, fields.id, who);
  const num = await mint(db, "C");
  const row = COLUMNS.map((c) => (c in fields ? bool(fields[c]) : null) ?? defaultFor(c));
  await db.prepare(`INSERT INTO cards (id, num, ${COLUMNS.join(", ")}, issues_at, created_at, updated_at) VALUES (?, ?, ${COLUMNS.map(() => "?").join(", ")}, ?, ?, ?)`)
    .bind(fields.id, num, ...row, fields.issues ? now : null, now, now).run();
  return { ok: true, id: fields.id, num };
}
const defaultFor = (c) => (c === "summary" ? "" : c === "track" ? "product" : c === "paused" || c === "dropped" ? 0 : null);

// Card words changed later: checked against the probe's reading of this card (a typed word cannot contradict it).
export async function updateCard(db, now, who, fields) {
  const id = fields?.id;
  const card = typeof id === "string" ? await db.prepare("SELECT id FROM cards WHERE id = ?").bind(id).first() : null;
  if (!card) return refuse(db, now, { rule: "card-unknown", detail: String(id) }, id, who);
  const bad = cardWriteRefusal(fields, await evidenceOf(db, `cards.${id}`));
  if (bad) return refuse(db, now, bad, id, who);
  const keys = COLUMNS.filter((c) => c in fields);
  if (!keys.length) return { ok: true, id, changed: 0 };
  // The issue counts carry the time they were last set (the page shows when the chips were counted).
  const sets = keys.map((k) => `${k} = ?`), vals = keys.map((k) => bool(fields[k]));
  if (keys.includes("issues")) { sets.push("issues_at = ?"); vals.push(fields.issues ? now : null); }
  await db.prepare(`UPDATE cards SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...vals, now, id).run();
  return { ok: true, id, changed: keys.length };
}

// An ask of one of the eight types. The parts of the type go in body as JSON; the store mints the #T number.
export async function createAsk(db, now, ask) {
  const bad = askRefusal(ask, now);
  if (bad) return refuse(db, now, bad, ask?.card_id, ask?.asked_by);
  const badShots = await screenshotsRefusal(db, ask.screenshots);
  if (badShots) return refuse(db, now, badShots, ask.card_id, ask.asked_by);
  if (ask.card_id && !(await db.prepare("SELECT 1 AS x FROM cards WHERE id = ?").bind(ask.card_id).first())) return refuse(db, now, { rule: "card-unknown", detail: ask.card_id }, ask.card_id, ask.asked_by);
  const num = await mint(db, "T");
  const body = {};
  for (const k of [...ASK_PARTS[ask.type], "screenshots"]) if (ask[k] !== undefined) body[k] = ask[k];
  const id = `t${num}`;
  await db.prepare("INSERT INTO asks (id, num, type, title, asked_by, card_id, body, eta_at, eta_precondition, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, num, ask.type, ask.title, ask.asked_by, ask.card_id ?? null, JSON.stringify(body), ask.eta_at ?? null, ask.eta_precondition ?? null, now).run();
  return { ok: true, id, num };
}

// A message on a thread (a card id, an ask id or a free thread name). Delivery to Manager is the wake's business.
export async function postMessage(db, now, who, m) {
  const ok = m && typeof m === "object" && Object.keys(m).every((k) => ["thread_id", "body", "kind", "options"].includes(k)) && typeof m.thread_id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(m.thread_id) && typeof m.body === "string" && m.body.trim() && m.body.length <= 8000;
  if (!ok) return refuse(db, now, { rule: "message-shape", detail: "thread_id and body, body 1 to 8000 characters, and for an agent a kind and options; nothing else" }, m?.thread_id, who);
  const extra = messageExtrasRefusal(m, who);
  if (extra) return refuse(db, now, extra, m.thread_id, who);
  const id = `m-${now}-${crypto.randomUUID().slice(0, 8)}`;
  await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at, kind, options) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, m.thread_id, who, m.body, now, m.kind ?? null, m.options ? JSON.stringify(m.options) : null).run();
  return { ok: true, id };
}

// An answer to an ask. A Decision's answer must be one of its options (decide); only an open ask can be answered.
// B2 (#C725): with a status the answer is given in full: {status, note, other, hasFiles} beside the answer (the option for a
// choice). The text the agent reads (answer) is the option, the note of a something-else, or the note / Ack / Done / Help.
export async function answerAsk(db, now, who, { id, answer, status, note, other, hasFiles } = {}) {
  const ask = typeof id === "string" ? await db.prepare("SELECT * FROM asks WHERE id = ?").bind(id).first() : null;
  if (!ask) return refuse(db, now, { rule: "ask-unknown", detail: String(id) }, null, who);
  if (ask.answered_at) return refuse(db, now, { rule: "ask-already-answered", detail: id }, ask.card_id, who);
  let stored = null;
  if (status !== undefined) {
    if (ask.type === "Approval") return refuse(db, now, { rule: "approval-answer", detail: `an approval is answered "${APPROVE}"` }, ask.card_id, who);
    const bad = answerShapeRefusal(ask, { status, note, other, hasFiles });
    if (bad) return refuse(db, now, bad, ask.card_id, who);
    const text = typeof note === "string" ? note.trim() : "";
    if (other) answer = text || "Something else";
    else if (status === "chose") { if (typeof answer !== "string") return refuse(db, now, { rule: "answer-shape", detail: "a choice names its option" }, ask.card_id, who); }
    else answer = text || { done: "Done", help: "Help", ack: "Ack" }[status];
    stored = { status: other ? "other" : status, note: text || null };
  }
  if (typeof answer !== "string" || !answer.trim()) return refuse(db, now, { rule: "answer-shape", detail: "an answer is text" }, ask.card_id, who);
  if (ask.type === "Decision" && !other && !JSON.parse(ask.body).options.includes(answer)) return refuse(db, now, { rule: "answer-not-an-option", detail: answer }, ask.card_id, who);
  // An Approval (#C727) is answered with Approve only, and only while it is open: a closed one was merged or replaced by a newer head.
  if (ask.type === "Approval" && (answer !== APPROVE || ask.closed_at)) return refuse(db, now, { rule: "approval-answer", detail: ask.closed_at ? `${id} is closed` : `an approval is answered "${APPROVE}"` }, ask.card_id, who);
  await db.prepare("UPDATE asks SET answered_at = ?, answer = ?, answered_by = ?, answer_status = ?, answer_note = ? WHERE id = ?").bind(now, answer, who, stored?.status ?? null, stored?.note ?? null, id).run();
  return { ok: true, id };
}

// The owner's Withdraw of an approval (#C727): the answer is cleared, so the pull request waits for his Approve again and Release
// reads no approval; the withdraw itself is kept on the ask. Owner only (the role, never a name).
export async function withdrawAsk(db, now, who, id, role) {
  const ask = typeof id === "string" ? await db.prepare("SELECT id, type, answered_at, closed_at, card_id FROM asks WHERE id = ?").bind(id).first() : null;
  const bad = withdrawRefusal(ask, role);
  if (bad) return refuse(db, now, bad, ask?.card_id, who);
  await db.prepare("UPDATE asks SET answered_at = NULL, answer = NULL, answered_by = NULL, answer_status = NULL, answer_note = NULL, answer_taken_at = NULL, withdrawn_at = ?, withdrawn_by = ? WHERE id = ?").bind(now, who, id).run();
  return { ok: true, id };
}

// The owner's To-do and Ideas rows. The store names a new row; a row's kind never changes; done stamps done_at once.
const LIST_COLUMNS = ["text", "area", "category", "note", "rank", "done"];
// The step tool: one row of the phase history, from an agent, with the wait column. The writer is who authenticated (never a name in the
// call); the card has to exist; a repeat of the same step (same card, phase, kind, time and wait) is stored once.
export async function writeStep(db, now, who, a) {
  const bad = stepRefusal(a, now);
  if (bad) return refuse(db, now, bad, typeof a?.init === "string" ? a.init : null, who);
  if (!(await db.prepare("SELECT id FROM cards WHERE id = ?").bind(a.init).first())) return refuse(db, now, { rule: "step-card-unknown", detail: a.init }, null, who);
  const at = a.at ?? now, wait = a.wait ?? null;
  await db.prepare("INSERT OR IGNORE INTO phase_history (card_id, phase, kind, at, who, source, wait) VALUES (?, ?, ?, ?, ?, 'tool', ?)").bind(a.init, a.phase, a.kind, at, who, wait).run();
  return { ok: true };
}
// The probe fills in a card's repo word from git (#C742, collector/repo-words.mjs). Only a card that has none takes it: a word already set,
// by an agent or an earlier fill, is never changed here, and nothing else on the card is touched (not even its updated time).
export async function fillCardRepo(db, now, id, repo) {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return refuse(db, now, { rule: "card-id", detail: String(id).slice(0, 40) }, null, "probe");
  if (typeof repo !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(repo)) return refuse(db, now, { rule: "card-repo", detail: "repo is lower case letters, digits and -, up to 40" }, id, "probe");
  const row = await db.prepare("SELECT repo FROM cards WHERE id = ?").bind(id).first();
  if (!row) return refuse(db, now, { rule: "card-unknown", detail: id }, null, "probe");
  if (typeof row.repo === "string" && row.repo !== "") return { ok: true, set: false, repo: row.repo };
  await db.prepare("UPDATE cards SET repo = ? WHERE id = ? AND (repo IS NULL OR repo = '')").bind(repo, id).run();
  return { ok: true, set: true, repo };
}
export async function createListItem(db, now, who, fields) {
  const bad = listWriteRefusal(fields, { create: true });
  if (bad) return refuse(db, now, bad, null, who);
  const id = `${fields.kind === "todo" ? "todo" : "idea"}-${now}-${crypto.randomUUID().slice(0, 6)}`;
  const row = LIST_COLUMNS.map((c) => (c in fields ? bool(fields[c]) : null) ?? (c === "done" ? 0 : null));
  const doneNow = row[LIST_COLUMNS.indexOf("done")] === 1;
  await db.prepare(`INSERT INTO lists (id, kind, ${LIST_COLUMNS.join(", ")}, done_at, done_by, added_at) VALUES (?, ?, ${LIST_COLUMNS.map(() => "?").join(", ")}, ?, ?, ?)`)
    .bind(id, fields.kind, ...row, doneNow ? now : null, doneNow ? who : null, now).run();
  return { ok: true, id };
}
export async function updateListItem(db, now, who, fields) {
  const id = fields?.id;
  const cur = typeof id === "string" ? await db.prepare("SELECT id, done FROM lists WHERE id = ?").bind(id).first() : null;
  if (!cur) return refuse(db, now, { rule: "list-unknown", detail: String(id) }, null, who);
  const { id: _id, ...words } = fields;
  const bad = listWriteRefusal(words);
  if (bad) return refuse(db, now, bad, null, who);
  const keys = LIST_COLUMNS.filter((c) => c in words);
  if (!keys.length) return { ok: true, id, changed: 0 };
  const sets = keys.map((k) => `${k} = ?`), vals = keys.map((k) => bool(words[k]));
  if ("done" in words) {
    const d = bool(words.done);
    if (d === 1 && !cur.done) { sets.push("done_at = ?", "done_by = ?"); vals.push(now, who); }
    if (d === 0) { sets.push("done_at = ?", "done_by = ?"); vals.push(null, null); }
  }
  await db.prepare(`UPDATE lists SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
  return { ok: true, id, changed: keys.length };
}

// Closing an ask: it leaves Needs you and Later, and its thread is closed with it. Nothing is deleted; messages stay as they are.
export async function closeAsk(db, now, who, id, role) {
  const ask = typeof id === "string" ? await db.prepare("SELECT id, type, asked_by, answered_at, closed_at, card_id FROM asks WHERE id = ?").bind(id).first() : null;
  const bad = closeRefusal(ask ? ask : null, who, role);
  if (bad) return refuse(db, now, bad, ask?.card_id, who);
  await db.prepare("UPDATE asks SET closed_at = ?, closed_by = ? WHERE id = ?").bind(now, who, id).run();
  return { ok: true, id };
}

// A reply on a closed thread reopens it (#C725 B1): the owner's reply to a done ask puts it back where it was. The answer and
// everything else stay as they are. An ask that is not closed is left alone. Nothing is deleted.
export async function reopenAsk(db, now, who, id) {
  const ask = typeof id === "string" ? await db.prepare("SELECT id, type, closed_at, card_id FROM asks WHERE id = ?").bind(id).first() : null;
  if (!ask) return refuse(db, now, { rule: "ask-unknown", detail: String(id) }, null, who);
  // An Approval is never reopened (Checker, #C725): it closes when its head is merged or replaced, and reopening it would bring back
  // an approval of a head the owner did not approve again (the answer stays on a closed ask).
  if (ask.type === "Approval") return refuse(db, now, { rule: "approval-reopen", detail: `${id}: a closed approval is not reopened; a new head is a new ask` }, ask.card_id, who);
  if (!ask.closed_at) return { ok: true, id, changed: 0 };
  await db.prepare("UPDATE asks SET closed_at = NULL, closed_by = NULL WHERE id = ?").bind(id).run();
  return { ok: true, id, changed: 1 };
}

// The owner's ack of a ship: once per version, only for a version the probe recorded.
export async function ackShip(db, now, who, version) {
  const ship = typeof version === "string" ? await db.prepare("SELECT acked_at FROM ships WHERE version = ?").bind(version).first() : null;
  if (!ship) return refuse(db, now, { rule: "ship-unknown", detail: String(version) }, null, who);
  if (ship.acked_at) return refuse(db, now, { rule: "ship-already-acked", detail: version }, null, who);
  await db.prepare("UPDATE ships SET acked_at = ? WHERE version = ?").bind(now, version).run();
  return { ok: true, version };
}

// ---- The wake (row 4) -------------------------------------------------------------------------------------------------
// "For Manager": the owner's messages and answers Manager has not read. Manager's typed read (takeInbox) takes them.
const pendingForManager = async (db) => {
  const m = await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE delivered_at IS NULL AND author = 'owner'").first();
  const a = await db.prepare("SELECT COUNT(*) AS n FROM asks WHERE answered_at IS NOT NULL AND answer_taken_at IS NULL").first();
  const s = await db.prepare("SELECT COUNT(*) AS n FROM stall_wakes WHERE taken_at IS NULL").first();
  return m.n + a.n + s.n;
};
// #C732: the cards that wait 15 min at a phase while its agent is idle (stalledWaits, board-rules.mjs), kept as one row per
// (card, reason): a new reason for a card is pending for Manager once, an older untaken reason of the card is replaced by it, and a stall
// that is over is no longer pending. A reason already sent is never sent again.
async function syncStalls(db, now) {
  const cards = (await db.prepare("SELECT id, num, owner_role, blocked_reason, paused, dropped, waiting_on, repo FROM cards").all()).results;
  const evRows = (await db.prepare("SELECT key, value FROM evidence WHERE key = 'agents' OR key LIKE 'cards.%'").all()).results;
  let agents = {}; const evidence = {};
  for (const r of evRows) { let v; try { v = JSON.parse(r.value); } catch { continue; } if (r.key === "agents") agents = v; else evidence[r.key.slice(6)] = v; }
  const openAskCards = new Set((await db.prepare("SELECT DISTINCT card_id FROM asks WHERE closed_at IS NULL AND card_id IS NOT NULL").all()).results.map((r) => r.card_id));
  const phaseStart = new Map((await db.prepare("SELECT card_id, phase, MAX(at) AS at FROM phase_history WHERE kind = 'start' AND wait IS NULL GROUP BY card_id, phase").all()).results.map((r) => [`${r.card_id}|${r.phase}`, r.at]));
  const stalls = stalledWaits({ now, cards, evidence, agents, openAskCards, phaseStart });
  for (const s of stalls) await db.prepare("INSERT OR IGNORE INTO stall_wakes (card_id, reason, created_at) VALUES (?, ?, ?)").bind(s.card_id, s.reason, now).run();
  // Whatever is untaken and no longer current (the stall is over, or its reason changed) is no longer pending: a card's older reason is
  // replaced by its new one here, so Manager never reads both.
  const current = new Set(stalls.map((s) => `${s.card_id}|${s.reason}`));
  const pending = (await db.prepare("SELECT card_id, reason FROM stall_wakes WHERE taken_at IS NULL").all()).results;
  for (const p of pending) if (!current.has(`${p.card_id}|${p.reason}`)) await db.prepare("UPDATE stall_wakes SET taken_at = ? WHERE card_id = ? AND reason = ?").bind(now, p.card_id, p.reason).run();
}
const wakeFacts = (w, askedAt) => ({ askedAt, batchId: w.batch_id, count: w.batch_count, batchAt: w.batch_at, takenAt: w.taken_at, lastSendAt: w.last_send_at ?? undefined, lastSendBatch: w.last_send_batch, lastSendOk: w.last_send_ok === null ? undefined : w.last_send_ok === 1, lastSendReason: w.last_send_reason ?? undefined, lastSendFix: w.last_send_fix ?? undefined });

// The probe's 20-second ask: the heartbeat, and the answer to "anything for Manager?". Opens a batch when something is
// pending and none is open; says whether to send now (once per batch, again at most every 5 minutes) and with which line.
export async function wakeAsk(db, now) {
  await db.prepare("UPDATE wake SET alive_at = ? WHERE id = 1").bind(now).run();
  let w = await db.prepare("SELECT * FROM wake WHERE id = 1").first();
  await syncStalls(db, now);
  const n = await pendingForManager(db);
  const open = w.batch_id && w.taken_at < w.batch_at;
  if (n > 0 && !open) {
    await db.prepare("UPDATE wake SET batch_id = ?, batch_count = ?, batch_at = ? WHERE id = 1").bind(`b-${now}`, n, now).run();
  } else if (n > 0) await db.prepare("UPDATE wake SET batch_count = ? WHERE id = 1").bind(n).run();
  w = await db.prepare("SELECT * FROM wake WHERE id = 1").first();
  const facts = wakeFacts(w, now);
  const status = wakeStatus(facts, now);
  const tellOwner = shouldTellOwner(status, w.told_reason);
  if (tellOwner) await db.prepare("UPDATE wake SET told_reason = ? WHERE id = 1").bind(status.reason).run();
  return { send: n > 0 && shouldSend(facts, now), line: n > 0 ? nudgeLine(w.batch_count, w.batch_id) : null, batchId: n > 0 ? w.batch_id : null, count: n, status, tellOwner };
}

// The probe reports a finished send (its exit code and the CLI's text, classified). A good send clears the owner-told memory.
export async function wakeResult(db, now, batchId, exit, text) {
  const c = classifySend(exit, text);
  await db.prepare("UPDATE wake SET last_send_at = ?, last_send_batch = ?, last_send_ok = ?, last_send_reason = ?, last_send_fix = ?, told_reason = CASE WHEN ? = 1 THEN NULL ELSE told_reason END WHERE id = 1")
    .bind(now, String(batchId ?? "").slice(0, 40), c.ok ? 1 : 0, c.ok ? null : c.reason, c.ok ? null : c.fix, c.ok ? 1 : 0).run();
  return { ok: true, send: c };
}

// Manager's typed read: returns what is for Manager as data and marks it taken (the batch closes, wake.seen_at moves).
export async function takeInbox(db, now) {
  const messages = (await db.prepare("SELECT id, thread_id, author, body, created_at FROM messages WHERE delivered_at IS NULL AND author = 'owner' ORDER BY created_at").all()).results;
  const answers = (await db.prepare("SELECT id, num, title, answer, answer_status, answer_note, answered_at, answered_by FROM asks WHERE answered_at IS NOT NULL AND answer_taken_at IS NULL ORDER BY answered_at").all()).results;
  // Mark exactly the rows returned: one written between the SELECT and the UPDATE stays for the next read, never lost (Checker).
  // D1 binds at most 100 values per statement (Checker): mark in chunks of 90 ids plus the time.
  const mark = async (sql, rows) => { for (let i = 0; i < rows.length; i += 90) { const ids = rows.slice(i, i + 90).map((r) => r.id); await db.prepare(sql.replace("(?)", `(${ids.map(() => "?").join(", ")})`)).bind(now, ...ids).run(); } };
  await mark("UPDATE messages SET delivered_at = ? WHERE delivered_at IS NULL AND id IN (?)", messages);
  await mark("UPDATE asks SET answer_taken_at = ? WHERE answer_taken_at IS NULL AND id IN (?)", answers);
  // #C732: the stalls pending (each with its reason), taken with the rest; the reason text is built from card numbers, phase and role names.
  const stalls = (await db.prepare("SELECT s.card_id, c.num, s.reason FROM stall_wakes s LEFT JOIN cards c ON c.id = s.card_id WHERE s.taken_at IS NULL ORDER BY s.created_at").all()).results;
  for (const s of stalls) await db.prepare("UPDATE stall_wakes SET taken_at = ? WHERE card_id = ? AND reason = ? AND taken_at IS NULL").bind(now, s.card_id, s.reason).run();
  await db.prepare("UPDATE wake SET taken_at = ?, seen_at = ? WHERE id = 1").bind(now, now).run();
  return { ok: true, messages, answers, stalls };
}

// Evidence: only the probe writes it; one lit phase per card.
export async function writeEvidence(db, now, who, key, value, track) {
  const bad = evidenceRefusal(key, value, who, track);
  if (bad) return refuse(db, now, bad, key.startsWith?.("cards.") ? key.slice(6) : null, who);
  const upsert = db.prepare("INSERT INTO evidence (key, value, read_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, read_at = excluded.read_at").bind(key, JSON.stringify(value), now);
  if (!key.startsWith("cards.")) { await upsert.run(); return { ok: true }; }
  // A card's lit phase changed (or is read for the first time): the phase history gets its rows in the same write (#C723 B3b).
  // The phase it was in: the last evidence reading, else (the first reading after the one-time import) the phase the history left open.
  const cardId = key.slice(6), next = value.lit[0];
  let prev = (await evidenceOf(db, key))?.lit?.[0] ?? null;
  // A wait step (the step tool, #C739) is not the lit phase: the three reads of the history below take the probe's own rows only (wait IS NULL).
  if (!prev) { const last = await db.prepare("SELECT phase, kind FROM phase_history WHERE card_id = ? AND wait IS NULL ORDER BY at DESC, id DESC LIMIT 1").bind(cardId).first(); if (last?.kind === "start") prev = last.phase; }
  const prevWho = prev && prev !== next ? (await db.prepare("SELECT who FROM phase_history WHERE card_id = ? AND phase = ? AND kind = 'start' AND wait IS NULL ORDER BY at DESC, id DESC LIMIT 1").bind(cardId, prev).first())?.who ?? null : null;
  const rows = prev === next ? [] : historyRows(cardId, prev, next, now, whoForPhase(cardId, next, (await evidenceOf(db, "agents")) ?? {}, (await db.prepare("SELECT owner_role FROM cards WHERE id = ?").bind(cardId).first())?.owner_role), prevWho);
  const ins = rows.map((r) => db.prepare("INSERT OR IGNORE INTO phase_history (card_id, phase, kind, at, who, source) VALUES (?, ?, ?, ?, ?, 'evidence')").bind(r.card_id, r.phase, r.kind, r.at, r.who));
  await db.batch([upsert, ...ins]);
  await noteShip(db, now, cardId, value);
  return { ok: true };
}

// The one JSON view the page polls: everything it shows with its source and age, and a version tag (ETag) over the content
// that changes only when something the page shows changes (ages are computed by the page from at/readAt, not stored here).
export async function readView(db, now) {
  const all = async (sql) => (await db.prepare(sql).all()).results;
  const cards = await all("SELECT * FROM cards ORDER BY num");
  const asks = await all("SELECT * FROM asks ORDER BY num");
  const lists = await all("SELECT * FROM lists ORDER BY kind, done, rank, added_at, id");
  const evidence = Object.fromEntries((await all("SELECT key, value, read_at FROM evidence ORDER BY key")).map((e) => [e.key, { value: JSON.parse(e.value), readAt: e.read_at }]));
  const refusals = await all("SELECT at, rule, card_id, who, detail FROM refusals ORDER BY id DESC LIMIT 20");
  const wake = await db.prepare("SELECT * FROM wake WHERE id = 1").first();
  // The store notices silence, not the probe: the newest evidence write is the probe's heartbeat. No evidence for 3 minutes
  // shows the probe's own chip red ("probe silent since"), and never makes the cards look stalled.
  // A timed-out run's own report (key run.*) is not a healthy reading and does not count as a heartbeat.
  const last = Math.max(0, ...Object.entries(evidence).filter(([k]) => !k.startsWith("run.")).map(([, e]) => e.readAt));
  const probe = last && now - last <= PROBE_SILENT_MS ? { state: "ok", lastAt: last } : { state: "silent", since: last || null };
  const live = liveNow(evidence.live ? { version: evidence.live.value.version, readAt: evidence.live.readAt } : null, now);
  const history = await all("SELECT id, card_id, phase, kind, at, who, wait FROM phase_history ORDER BY at, id");
  const historyCards = await all("SELECT id, num, title, size, review_level, created_at, done_at FROM history_cards ORDER BY done_at");
  const files = await readFiles(db, asks), ships = await readShips(db), usage = await readUsage(db), threads = await readThreads(db);
  const content = { cards, asks, lists, evidence, refusals, wake, history, historyCards, files, ships, usage, threads };
  // The tag covers what the page shows; a probe going silent changes it, the clock moving alone does not.
  const wakeState = wakeStatus(wakeFacts(wake, wake.alive_at || undefined), now);
  const tag = (await sha256hex(JSON.stringify([content, probe.state, wakeState.state, wakeState.reason ?? null]))).slice(0, 16);
  return { tag, now, live, probe, wakeState, ...content };
}
