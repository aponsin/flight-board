// Board store operations on D1 (#C719). Every write goes through the rules in board-rules.mjs in the same call; a refusal is
// logged (rule, card, who, time) and returned, nothing is written. `db` is a D1 binding (or tests/helpers/d1-sqlite.mjs).
import { askRefusal, cardWriteRefusal, evidenceRefusal, liveNow, ASK_PARTS } from "./board-rules.mjs";
import { classifySend, nudgeLine, shouldSend, wakeStatus, shouldTellOwner } from "./wake-rules.mjs";

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

const COLUMNS = ["title", "summary", "size", "review_level", "from_thread", "track", "owner_role", "next_note", "waiting_on", "blocked_reason", "paused", "dropped", "rework_reason"];
const bool = (v) => (v === true ? 1 : v === false ? 0 : v);

// A new card: words only. The id is the caller's, the number the store's.
export async function createCard(db, now, who, fields) {
  const bad = cardWriteRefusal(fields, null);
  if (bad) return refuse(db, now, bad, fields?.id, who);
  if (typeof fields.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(fields.id)) return refuse(db, now, { rule: "card-id", detail: "lowercase letters, digits, hyphens" }, fields.id, who);
  if (typeof fields.title !== "string" || !fields.title.trim()) return refuse(db, now, { rule: "card-shape", detail: "title is required" }, fields.id, who);
  if (await db.prepare("SELECT 1 AS x FROM cards WHERE id = ?").bind(fields.id).first()) return refuse(db, now, { rule: "card-exists", detail: fields.id }, fields.id, who);
  const num = await mint(db, "C");
  const row = COLUMNS.map((c) => (c in fields ? bool(fields[c]) : null) ?? defaultFor(c));
  await db.prepare(`INSERT INTO cards (id, num, ${COLUMNS.join(", ")}, created_at, updated_at) VALUES (?, ?, ${COLUMNS.map(() => "?").join(", ")}, ?, ?)`)
    .bind(fields.id, num, ...row, now, now).run();
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
  await db.prepare(`UPDATE cards SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).bind(...keys.map((k) => bool(fields[k])), now, id).run();
  return { ok: true, id, changed: keys.length };
}

// An ask of one of the eight types. The parts of the type go in body as JSON; the store mints the #T number.
export async function createAsk(db, now, ask) {
  const bad = askRefusal(ask, now);
  if (bad) return refuse(db, now, bad, ask?.card_id, ask?.asked_by);
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
  const ok = m && typeof m === "object" && Object.keys(m).every((k) => k === "thread_id" || k === "body") && typeof m.thread_id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(m.thread_id) && typeof m.body === "string" && m.body.trim() && m.body.length <= 8000;
  if (!ok) return refuse(db, now, { rule: "message-shape", detail: "thread_id and body, body 1 to 8000 characters, nothing else" }, m?.thread_id, who);
  const id = `m-${now}-${crypto.randomUUID().slice(0, 8)}`;
  await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, m.thread_id, who, m.body, now).run();
  return { ok: true, id };
}

// An answer to an ask. A Decision's answer must be one of its options (decide); only an open ask can be answered.
export async function answerAsk(db, now, who, { id, answer } = {}) {
  const ask = typeof id === "string" ? await db.prepare("SELECT * FROM asks WHERE id = ?").bind(id).first() : null;
  if (!ask) return refuse(db, now, { rule: "ask-unknown", detail: String(id) }, null, who);
  if (ask.answered_at) return refuse(db, now, { rule: "ask-already-answered", detail: id }, ask.card_id, who);
  if (typeof answer !== "string" || !answer.trim()) return refuse(db, now, { rule: "answer-shape", detail: "an answer is text" }, ask.card_id, who);
  if (ask.type === "Decision" && !JSON.parse(ask.body).options.includes(answer)) return refuse(db, now, { rule: "answer-not-an-option", detail: answer }, ask.card_id, who);
  await db.prepare("UPDATE asks SET answered_at = ?, answer = ?, answered_by = ? WHERE id = ?").bind(now, answer, who, id).run();
  return { ok: true, id };
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
  return m.n + a.n;
};
const wakeFacts = (w, askedAt) => ({ askedAt, batchId: w.batch_id, count: w.batch_count, batchAt: w.batch_at, takenAt: w.taken_at, lastSendAt: w.last_send_at ?? undefined, lastSendBatch: w.last_send_batch, lastSendOk: w.last_send_ok === null ? undefined : w.last_send_ok === 1, lastSendReason: w.last_send_reason ?? undefined, lastSendFix: w.last_send_fix ?? undefined });

// The probe's 20-second ask: the heartbeat, and the answer to "anything for Manager?". Opens a batch when something is
// pending and none is open; says whether to send now (once per batch, again at most every 5 minutes) and with which line.
export async function wakeAsk(db, now) {
  await db.prepare("UPDATE wake SET alive_at = ? WHERE id = 1").bind(now).run();
  let w = await db.prepare("SELECT * FROM wake WHERE id = 1").first();
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
  const answers = (await db.prepare("SELECT id, num, title, answer, answered_at FROM asks WHERE answered_at IS NOT NULL AND answer_taken_at IS NULL ORDER BY answered_at").all()).results;
  await db.prepare("UPDATE messages SET delivered_at = ? WHERE delivered_at IS NULL AND author = 'owner'").bind(now).run();
  await db.prepare("UPDATE asks SET answer_taken_at = ? WHERE answered_at IS NOT NULL AND answer_taken_at IS NULL").bind(now).run();
  await db.prepare("UPDATE wake SET taken_at = ?, seen_at = ? WHERE id = 1").bind(now, now).run();
  return { ok: true, messages, answers };
}

// Evidence: only the probe writes it; one lit phase per card.
export async function writeEvidence(db, now, who, key, value, track) {
  const bad = evidenceRefusal(key, value, who, track);
  if (bad) return refuse(db, now, bad, key.startsWith?.("cards.") ? key.slice(6) : null, who);
  await db.prepare("INSERT INTO evidence (key, value, read_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, read_at = excluded.read_at").bind(key, JSON.stringify(value), now).run();
  return { ok: true };
}

// The one JSON view the page polls: everything it shows with its source and age, and a version tag (ETag) over the content
// that changes only when something the page shows changes (ages are computed by the page from at/readAt, not stored here).
export async function readView(db, now) {
  const all = async (sql) => (await db.prepare(sql).all()).results;
  const cards = await all("SELECT * FROM cards ORDER BY num");
  const asks = await all("SELECT * FROM asks ORDER BY num");
  const evidence = Object.fromEntries((await all("SELECT key, value, read_at FROM evidence ORDER BY key")).map((e) => [e.key, { value: JSON.parse(e.value), readAt: e.read_at }]));
  const refusals = await all("SELECT at, rule, card_id, who, detail FROM refusals ORDER BY id DESC LIMIT 20");
  const wake = await db.prepare("SELECT * FROM wake WHERE id = 1").first();
  // The store notices silence, not the probe: the newest evidence write is the probe's heartbeat. No evidence for 3 minutes
  // shows the probe's own chip red ("probe silent since"), and never makes the cards look stalled.
  // A timed-out run's own report (key run.*) is not a healthy reading and does not count as a heartbeat.
  const last = Math.max(0, ...Object.entries(evidence).filter(([k]) => !k.startsWith("run.")).map(([, e]) => e.readAt));
  const probe = last && now - last <= PROBE_SILENT_MS ? { state: "ok", lastAt: last } : { state: "silent", since: last || null };
  const live = liveNow(evidence.live ? { version: evidence.live.value.version, readAt: evidence.live.readAt } : null, now);
  const content = { cards, asks, evidence, refusals, wake };
  // The tag covers what the page shows; a probe going silent changes it, the clock moving alone does not.
  const wakeState = wakeStatus(wakeFacts(wake, wake.alive_at || undefined), now);
  const tag = (await sha256hex(JSON.stringify([content, probe.state, wakeState.state, wakeState.reason ?? null]))).slice(0, 16);
  return { tag, now, live, probe, wakeState, ...content };
}
