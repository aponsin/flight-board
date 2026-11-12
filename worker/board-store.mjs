// Board store operations on D1 (#C719). Every write goes through the rules in board-rules.mjs in the same call; a refusal is
// logged (rule, card, who, time) and returned, nothing is written. `db` is a D1 binding (or tests/helpers/d1-sqlite.mjs).
import { reworkTriggered, staleCopies, COPY_CARD, E2E_CARD, e2eWake, e2eWakeLine, STALE_AFTER_MS, holdEndRefusal, autoHoldEnd, heldWakes, isHeld, phaseMedians, slowWakes, SLOW_ROW_END, askRefusal, cardWriteRefusal, closeRefusal, withdrawRefusal, answerShapeRefusal, messageExtrasRefusal, listWriteRefusal, evidenceRefusal, liveNow, historyRows, whoForPhase, PHASES, stalledWaits, POSTED_FRESH_MS, stepRefusal, stackSwitchRefusal, queueWriteRefusal, queueMoveRefusal, queueRank, dependsNotLive, ASK_PARTS, ASK_OPTIONAL_PARTS, APPROVE, PROBE_CARD_ID, PROBE_CARD_ID_MAX, typedOther, zTimeRefusal, inlineListRefusal, installWaitStep, INSTALL_WAIT, movedOnAsks, AUTO_CLOSED_BY, DONE_EVIDENCE } from "./board-rules.mjs";
import { classifySend, nudgeLine, shouldSend, wakeStatus, shouldTellOwner } from "./wake-rules.mjs";
import { readFiles, screenshotsRefusal, parseShot } from "./file-store.mjs";
import { noteShip, readShips } from "./compat-ships.mjs";
import { readUsage } from "./compat-usage.mjs";
import { mtDayTime } from "./team-time.mjs";
import { readThreads } from "./compat-threads.mjs";
import { askWakes, promiseWakes } from "./push-rules.mjs";

export const PROBE_SILENT_MS = 5 * 60_000; // #C996: was 3 min while the evidence job ran every minute; reverts with its cadence
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

// #C956: what the look rule needs from the store for a Decision: the team's visual lanes (the probe posts them as evidence `look`, from the board
// config's decisions.visualLanes) and the owner role of the ask's card. Nothing posted yet, or no card: the words decide alone, as before.
async function lookContext(db, ask) {
  const lanes = (await evidenceOf(db, "look"))?.visualLanes;
  if (!Array.isArray(lanes) || !lanes.length || !ask?.card_id) return {};
  const card = await db.prepare("SELECT owner_role FROM cards WHERE id = ?").bind(ask.card_id).first();
  return { lanes, cardOwner: card?.owner_role ?? null };
}

const COLUMNS = ["title", "summary", "size", "review_level", "from_thread", "track", "owner_role", "next_note", "waiting_on", "blocked_reason", "paused", "dropped", "rework_reason", "customer_text", "look_change", "skip", "depends_on", "issues", "queue_pos", "check_at", "repo", "batch", "bump", "hold_end"];
// true/false are stored as 1/0; a list or the issue counts are stored as JSON text (null stays null: "not said").
const bool = (v) => (v === true ? 1 : v === false ? 0 : Array.isArray(v) || (v && typeof v === "object") ? JSON.stringify(v) : v);

// A new card: words only. The id is the caller's, the number the store's.
export async function createCard(db, now, who, fields) {
  // #C748 (Checker F5): the check date is the lead's or the owner's on a new card too.
  if (fields && typeof fields === "object" && "check_at" in fields && !CHECK_AT_WRITERS.includes(who)) return refuse(db, now, { rule: "check-at-lead-only", detail: `${who ?? "unknown"} cannot set a card's check date; ${CHECK_AT_WRITERS.join(" or ")} can` }, fields.id, who);
  const bad = cardWriteRefusal(fields, null);
  if (bad) return refuse(db, now, bad, fields?.id, who);
  if ("done" in fields || "done_evidence" in fields) return refuse(db, now, { rule: "card-done", detail: "a new card is not done: create it, then close it with card_update" }, fields.id, who);
  const noEnd = holdEndRefusal(fields, null) ?? (await holdEndUnknown(db, fields));
  if (noEnd) return refuse(db, now, noEnd, fields?.id, who);
  // #C949: a new id is one the probe can read (collector/state-schema.mjs CARD_ID): a card it skips gets no evidence row, so a landed card is never seen.
  if (typeof fields.id !== "string" || !PROBE_CARD_ID.test(fields.id) || fields.id.length > PROBE_CARD_ID_MAX) return refuse(db, now, { rule: "card-id", detail: `lowercase letters and digits in up to 5 words joined by hyphens, each word up to 16 characters, up to ${PROBE_CARD_ID_MAX} characters in all, so the probe can read the card` }, fields.id, who);
  if (typeof fields.title !== "string" || !fields.title.trim()) return refuse(db, now, { rule: "card-shape", detail: "title is required" }, fields.id, who);
  if (await db.prepare("SELECT 1 AS x FROM cards WHERE id = ?").bind(fields.id).first()) return refuse(db, now, { rule: "card-exists", detail: fields.id }, fields.id, who);
  // #C871: a new card may not take a place at or ahead of one the owner holds in its agent's queue (queueWriteRefusal).
  const floorBad = who !== "owner" && Number.isInteger(fields.queue_pos) && typeof fields.owner_role === "string" ? queueWriteRefusal(fields, null, who, await ownerFloor(db, fields.owner_role, fields.id)) : null;
  if (floorBad) return refuse(db, now, floorBad, fields.id, who);
  const num = await mint(db, "C");
  const row = COLUMNS.map((c) => (c in fields ? bool(fields[c]) : null) ?? defaultFor(c));
  await db.prepare(`INSERT INTO cards (id, num, ${COLUMNS.join(", ")}, issues_at, held_at, hold_until, created_at, updated_at) VALUES (?, ?, ${COLUMNS.map(() => "?").join(", ")}, ?, ?, ?, ?, ?)`)
    .bind(fields.id, num, ...row, fields.issues ? now : null, isHeld(fields) ? now : null, autoHoldEnd(fields, null, now), now, now).run();
  return { ok: true, id: fields.id, num };
}
const defaultFor = (c) => (c === "summary" ? "" : c === "track" ? "product" : c === "paused" || c === "dropped" ? 0 : null);

// holds-need-an-end (#C838): hold_end names an OPEN ask or a card that is not dropped; null lifts it.
const holdEndUnknown = async (db, fields) => {
  const ref = fields.hold_end;
  if (ref === undefined || ref === null) return null;
  const ok = await db.prepare("SELECT 1 AS x FROM asks WHERE id = ? AND closed_at IS NULL UNION ALL SELECT 1 AS x FROM cards WHERE id = ? AND dropped = 0 AND done_at IS NULL").bind(ref, ref).first();
  return ok ? null : { rule: "hold-end-unknown", detail: `${ref} is no open ask and no live card` };
};

const CHECK_AT_WRITERS = ["Manager", "owner"];
// Card words changed later: checked against the probe's reading of this card (a typed word cannot contradict it).
export async function updateCard(db, now, who, fields) {
  const id = fields?.id;
  const card = typeof id === "string" ? await db.prepare("SELECT id, next_note, waiting_on, blocked_reason, check_at, hold_end, held_at, hold_until, queue_set_by, queue_pos, owner_role, dropped, done_at FROM cards WHERE id = ?").bind(id).first() : null;
  if (!card) return refuse(db, now, { rule: "card-unknown", detail: String(id) }, id, who);
  // #C902: done closes the card once, on a card that is not dropped; a thread message named as evidence must be on the board.
  if (fields.done === true) {
    if (card.done_at) return refuse(db, now, { rule: "card-done", detail: `${id} is already done` }, id, who);
    if (card.dropped) return refuse(db, now, { rule: "card-done", detail: `${id} is dropped: a card is done or dropped, not both` }, id, who);
    const ev = String(fields.done_evidence ?? "").trim();
    if (ev.startsWith("m-") && !(await db.prepare("SELECT 1 AS x FROM messages WHERE id = ?").bind(ev).first())) return refuse(db, now, { rule: "done-needs-evidence", detail: `no message ${ev} on the board` }, id, who);
  }
  const owned = queueWriteRefusal(fields, card, who, who !== "owner" && Number.isInteger(fields?.queue_pos) ? await ownerFloor(db, fields.owner_role ?? card.owner_role, id) : 0);
  if (owned) return refuse(db, now, owned, id, who);
  const bad = cardWriteRefusal(fields, await evidenceOf(db, `cards.${id}`));
  if (bad) return refuse(db, now, bad, id, who);
  // #C748: the check date holds a card open past its live reading, so only the lead (or the owner) sets it or lifts it (null), as on the old board.
  if ("check_at" in fields && !CHECK_AT_WRITERS.includes(who)) return refuse(db, now, { rule: "check-at-lead-only", detail: `${who ?? "unknown"} cannot set or lift a card's check date; ${CHECK_AT_WRITERS.join(" or ")} can` }, id, who);
  const noEnd = holdEndRefusal(fields, card) ?? (await holdEndUnknown(db, fields));
  if (noEnd) return refuse(db, now, noEnd, id, who);
  const keys = COLUMNS.filter((c) => c in fields);
  if (!keys.length && fields.done !== true) return { ok: true, id, changed: 0 };
  // The issue counts carry the time they were last set (the page shows when the chips were counted).
  const sets = keys.map((k) => `${k} = ?`), vals = keys.map((k) => bool(fields[k]));
  if (fields.done === true) { sets.push("done_at = ?", "done_evidence = ?"); vals.push(now, String(fields.done_evidence).trim()); }
  if (keys.includes("issues")) { sets.push("issues_at = ?"); vals.push(fields.issues ? now : null); }
  // #C987: the card moved on when its next step or what it waits on changes value (a write of the same words is no move).
  if (["next_note", "waiting_on"].some((k) => keys.includes(k) && (fields[k] ?? null) !== (card[k] ?? null))) { sets.push("moved_at = ?"); vals.push(now); }
  // #C871: who placed the card in its queue, and when (the owner's placement outranks an agent's: queueWriteRefusal).
  if (keys.includes("queue_pos")) { sets.push("queue_set_by = ?", "queue_set_at = ?"); vals.push(fields.queue_pos === null ? null : who ?? null, fields.queue_pos === null ? null : now); }
  // Security R1/R1b and Checker on da011f1: a place in one agent's queue says nothing about another's, so when someone but the owner changes owner_role
  // (with no queue_pos of its own, which the floor rule above checks against the new queue), the card enters the new queue unplaced and unmarked.
  if (who !== "owner" && !keys.includes("queue_pos") && typeof fields.owner_role === "string" && fields.owner_role !== card.owner_role) sets.push("queue_pos = NULL", "queue_set_by = NULL", "queue_set_at = NULL");
  // When the hold began: set by the write that makes the card held, kept while it stays held, cleared (with its end) when it is lifted.
  if (keys.includes("waiting_on") || keys.includes("blocked_reason")) {
    const after = { waiting_on: "waiting_on" in fields ? fields.waiting_on : card.waiting_on, blocked_reason: "blocked_reason" in fields ? fields.blocked_reason : card.blocked_reason };
    sets.push("held_at = ?"); vals.push(isHeld(after) ? (isHeld(card) ? card.held_at ?? now : now) : null);
    if (!isHeld(after) && !("hold_end" in fields)) sets.push("hold_end = NULL");
    // a waiting_on with no explicit end gets one from the store (now + 2 h, renewed by each such write); lifting the hold, or an explicit end, clears it
    sets.push("hold_until = ?"); vals.push(isHeld(after) ? autoHoldEnd(fields, card, now) : null);
  }
  await db.prepare(`UPDATE cards SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...vals, now, id).run();
  // #C875: a reason attached ends the rework's wait for one (the flag in the card's evidence goes) and is kept in the card's reason history.
  if (keys.includes("rework_reason") && typeof fields.rework_reason === "string") {
    await db.prepare("INSERT INTO rework_history (card_id, reason, at, who) VALUES (?, ?, ?, ?)").bind(id, fields.rework_reason, now, who ?? null).run();
    await db.prepare("UPDATE evidence SET value = json_remove(value, '$.rework') WHERE key = ? AND json_extract(value, '$.rework') IS NOT NULL").bind(`cards.${id}`).run();
  }
  return { ok: true, id, changed: keys.length + (fields.done === true ? 1 : 0) };
}

// An ask of one of the eight types. The parts of the type go in body as JSON; the store mints the #T number.
export async function createAsk(db, now, ask) {
  const bad = askRefusal(ask, now, await lookContext(db, ask));
  if (bad) return refuse(db, now, bad, ask?.card_id, ask?.asked_by);
  const badShots = await screenshotsRefusal(db, ask.screenshots);
  if (badShots) return refuse(db, now, badShots, ask.card_id, ask.asked_by);
  if (ask.card_id && !(await db.prepare("SELECT 1 AS x FROM cards WHERE id = ?").bind(ask.card_id).first())) return refuse(db, now, { rule: "card-unknown", detail: ask.card_id }, ask.card_id, ask.asked_by);
  const num = await mint(db, "T");
  const body = {};
  for (const k of [...ASK_PARTS[ask.type], ...(ASK_OPTIONAL_PARTS[ask.type] ?? []), "screenshots"]) if (ask[k] !== undefined) body[k] = ask[k];
  const id = `t${num}`;
  await db.prepare("INSERT INTO asks (id, num, type, title, asked_by, card_id, body, eta_at, eta_precondition, owed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, num, ask.type, ask.title, ask.asked_by, ask.card_id ?? null, JSON.stringify(body), ask.eta_at ?? null, ask.eta_precondition ?? null, ask.owed_by ?? null, now).run();
  return { ok: true, id, num };
}

// #C920: a Decision that follows the owner's question goes in his thread, not in a new ask. Manager's Decision ask carries
// related_thread: an owner thread's id (the decision is posted there as kind "decision" with its options as buttons, and no ask
// item is made) or the literal "none" (refused only when the decision names a card #C<n> or an ask #T<n> that an open thread of the
// owner's from the last 2 hours also names; the refusal names that thread). Other roles' asks are as before. The tool layer calls
// this; createAsk itself stays the plain store write.
export const THREAD_WINDOW_MS = 2 * 3_600_000;
const REF = /#([CT])(\d{1,7})\b/gi;
const refsOf = (...texts) => { const out = new Set(); for (const t of texts) for (const m of String(t ?? "").matchAll(REF)) out.add(`${m[1].toUpperCase()}${Number(m[2])}`); return out; };
const KEYS = ["A", "B", "C", "D"];

// The owner's open threads whose last owner message is within the window: { id, title, refs }.
async function openOwnerThreads(db, now) {
  const rows = (await db.prepare("SELECT thread_id, MAX(created_at) AS last FROM messages WHERE author = 'owner' AND created_at >= ? GROUP BY thread_id").bind(now - THREAD_WINDOW_MS).all()).results;
  const out = [];
  for (const { thread_id: id } of rows) {
    const ask = await db.prepare("SELECT num, title, closed_at FROM asks WHERE id = ?").bind(id).first();
    if (ask?.closed_at) continue;
    const card = await db.prepare("SELECT num, title FROM cards WHERE id = ?").bind(id).first();
    const free = await db.prepare("SELECT num, title FROM threads WHERE id = ?").bind(id).first();
    const msgs = (await db.prepare("SELECT body, resolved FROM messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC").bind(id).all()).results;
    if (msgs[0]?.resolved) continue; // the thread's last word resolved it
    const title = free?.title || ask?.title || card?.title || id;
    const own = [ask?.num ? `#T${ask.num}` : "", free?.num ? `#T${free.num}` : "", card?.num ? `#C${card.num}` : ""];
    out.push({ id, title, refs: refsOf(title, ask?.title, card?.title, ...own, ...msgs.map((m) => m.body)) });
  }
  return out;
}

export async function askFromTool(db, now, who, args) {
  const a = args ?? {};
  if (!(who === "Manager" && a.type === "Decision")) return createAsk(db, now, a);
  const { related_thread: rel, ...ask } = a;
  const no = (rule, detail) => refuse(db, now, { rule, detail }, ask.card_id, who);
  if (typeof rel !== "string" || !rel.trim()) return no("decision-thread-missing", "a Decision from Manager carries related_thread: the owner thread's id if it follows something he said there, or \"none\"");
  if (rel === "none") {
    const bad = askRefusal(ask, now, await lookContext(db, ask));
    if (bad) return refuse(db, now, bad, ask.card_id, who);
    const card = ask.card_id ? await db.prepare("SELECT num FROM cards WHERE id = ?").bind(ask.card_id).first() : null;
    const mine = refsOf(ask.title, ask.question, ask.recommended, ...(Array.isArray(ask.options) ? ask.options : []), card ? `#C${card.num}` : "");
    if (mine.size) {
      const hit = (await openOwnerThreads(db, now)).find((t) => [...mine].some((r) => t.refs.has(r)));
      if (hit) return no("decision-belongs-in-thread", `this Decision names ${[...mine].filter((r) => hit.refs.has(r)).map((r) => "#" + r).join(", ")}, which the owner's open thread ${hit.id} ("${hit.title}") also names: send it again with related_thread: "${hit.id}" and it is posted in that thread with its options`);
    }
    return createAsk(db, now, ask);
  }
  const bad = askRefusal(ask, now, await lookContext(db, ask));
  if (bad) return refuse(db, now, bad, ask.card_id, who);
  if (ask.eta_at !== undefined) return no("decision-not-before", "a Decision posted in a thread has no not-before time; leave eta_at out");
  // #C936: the screenshots go with the message (postMessage checks them as an ask's are: stored images, "<id> A: label", the letter one
  // of this decision's options). Checker F1 on 7868461: a message used to drop them silently, so they were refused; now it keeps them.
  const known = (await db.prepare("SELECT 1 AS x FROM asks WHERE id = ?").bind(rel).first()) || (await db.prepare("SELECT 1 AS x FROM cards WHERE id = ?").bind(rel).first()) || (await db.prepare("SELECT 1 AS x FROM threads WHERE id = ?").bind(rel).first());
  if (!known) return no("decision-thread-unknown", rel);
  const options = ask.options.map((label, i) => ({ key: KEYS[i], label }));
  const rec = options[ask.options.indexOf(ask.recommended)];
  const body = `${ask.title}\n\n${ask.question}\n\nRecommended: ${rec.key}${typeof ask.card_id === "string" && ask.card_id ? `\n\nCard: ${ask.card_id}` : ""}`;
  const r = await postMessage(db, now, who, { thread_id: rel, body, kind: "decision", options, ...(ask.screenshots !== undefined && !(Array.isArray(ask.screenshots) && !ask.screenshots.length) ? { screenshots: ask.screenshots } : {}) });
  return r.ok ? { ...r, thread_id: rel, posted_in_thread: true } : r;
}

// #C979: whether the owner reads a thread: an ask's, a free thread, or one he has written in.
async function ownerReads(db, threadId) {
  return Boolean((await db.prepare("SELECT 1 AS x FROM asks WHERE id = ?").bind(threadId).first())
    || (await db.prepare("SELECT 1 AS x FROM threads WHERE id = ?").bind(threadId).first())
    || (await db.prepare("SELECT 1 AS x FROM messages WHERE thread_id = ? AND author = 'owner' LIMIT 1").bind(threadId).first()));
}

// A message on a thread (a card id, an ask id or a free thread name). Delivery to Manager is the wake's business.
export async function postMessage(db, now, who, m) {
  const ok = m && typeof m === "object" && Object.keys(m).every((k) => ["thread_id", "body", "kind", "options", "screenshots"].includes(k)) && typeof m.thread_id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(m.thread_id) && typeof m.body === "string" && m.body.trim() && m.body.length <= 8000;
  if (!ok) return refuse(db, now, { rule: "message-shape", detail: "thread_id and body, body 1 to 8000 characters, and for an agent a kind, options and screenshots; nothing else" }, m?.thread_id, who);
  const extra = messageExtrasRefusal(m, who);
  if (extra) return refuse(db, now, extra, m.thread_id, who);
  // #C979: an agent's post in a thread the owner reads carries no UTC "Z" time (Mountain Time only). The owner reads an ask's thread, a free
  // thread (his) and any thread he has written in; a card thread only agents have written in is theirs, and keeps its Z times.
  if (who !== "owner") {
    const prose = [m.body, ...(Array.isArray(m.options) ? m.options.map((o) => o?.label) : [])];
    const z = zTimeRefusal(prose) ?? inlineListRefusal(prose); // #C965: one numbered line per point, as for an ask
    if (z && await ownerReads(db, m.thread_id)) return refuse(db, now, z, m.thread_id, who);
  }
  // #C936: an agent's message may carry screenshots, as an ask does. An empty list carries nothing; a picture that names an option (A to D)
  // names one of this message's own options, so a plain post cannot letter a picture.
  if (m.screenshots !== undefined) {
    const badShots = await screenshotsRefusal(db, m.screenshots);
    if (badShots) return refuse(db, now, badShots, m.thread_id, who);
    const keys = new Set((m.options ?? []).map((o) => o.key));
    for (const s of m.screenshots) { const p = parseShot(s); if (p.option && !keys.has(p.option)) return refuse(db, now, { rule: "screenshots-option", detail: `${p.id} names option ${p.option}, which this message does not offer` }, m.thread_id, who); }
  }
  const shots = Array.isArray(m.screenshots) && m.screenshots.length ? JSON.stringify(m.screenshots) : null;
  const id = `m-${now}-${crypto.randomUUID().slice(0, 8)}`;
  await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at, kind, options, screenshots) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, m.thread_id, who, m.body, now, m.kind ?? null, m.options ? JSON.stringify(m.options) : null, shots).run();
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
// #C903: the build starts when the dispatch wakes the builder, so build time is real. The probe sees a card only once something is pushed, so
// a store-era card's history used to begin at "checker" and the build medians came from old imported cards. The probe (its dispatch job)
// posts the card it woke its owner for with nothing pushed; the row is the build's start, who = the card's owner, source evidence. Only a card
// with NO history row of its own and no lit phase takes it, so a second wake (every dispatch run repeats the item) writes nothing, a pushed
// card is left to the evidence, and a dropped card gets none. The first push confirms it: the evidence write finds the build start as the
// card's open phase and closes it when the lit phase moves on (writeEvidence).
export async function recordBuildStart(db, now, id) {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return refuse(db, now, { rule: "card-id", detail: String(id).slice(0, 40) }, null, "probe");
  const card = await db.prepare("SELECT owner_role, dropped, done_at FROM cards WHERE id = ?").bind(id).first();
  if (!card) return refuse(db, now, { rule: "build-start-card-unknown", detail: id }, null, "probe");
  if (card.dropped) return { ok: true, recorded: false, why: "dropped" };
  if (card.done_at) return { ok: true, recorded: false, why: "done" };
  if (await db.prepare("SELECT 1 AS x FROM phase_history WHERE card_id = ? AND wait IS NULL LIMIT 1").bind(id).first()) return { ok: true, recorded: false, why: "has-history" };
  if ((await evidenceOf(db, `cards.${id}`))?.lit?.length) return { ok: true, recorded: false, why: "lit" };
  await db.prepare("INSERT OR IGNORE INTO phase_history (card_id, phase, kind, at, who, source) VALUES (?, 'build', 'start', ?, ?, 'evidence')").bind(id, now, card.owner_role ?? null).run();
  return { ok: true, recorded: true };
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
// #C963: whether the owner's own words wait (a message or an answer Manager has not read), as against a stall line: a failed send is retried
// sooner for these (shouldSend). The same two counts pendingForManager adds up.
const ownerWaiting = async (db) => {
  const m = await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE delivered_at IS NULL AND author = 'owner'").first();
  const a = await db.prepare("SELECT COUNT(*) AS n FROM asks WHERE answered_at IS NOT NULL AND answer_taken_at IS NULL").first();
  return m.n + a.n > 0;
};
// #C732: the cards that wait 15 min at a phase while its agent is idle (stalledWaits, board-rules.mjs), kept as one row per
// (card, reason): a new reason for a card is pending for Manager once, an older untaken reason of the card is replaced by it, and a stall
// that is over is no longer pending. A reason already sent is never sent again.
async function syncStalls(db, now) {
  const cards = (await db.prepare("SELECT id, num, owner_role, blocked_reason, paused, dropped, done_at, waiting_on, repo, check_at, hold_end, held_at, hold_until, depends_on, updated_at, queue_pos, queue_set_by, moved_at FROM cards").all()).results;
  const evRows = (await db.prepare("SELECT key, value, read_at FROM evidence WHERE key = 'agents' OR key LIKE 'cards.%'").all()).results;
  let agents = {}; const evidence = {}, readAt = {};
  for (const r of evRows) { let v; try { v = JSON.parse(r.value); } catch { continue; } if (r.key === "agents") agents = v; else { evidence[r.key.slice(6)] = v; readAt[r.key.slice(6)] = r.read_at; } }
  const openAskCards = new Set((await db.prepare("SELECT DISTINCT card_id FROM asks WHERE closed_at IS NULL AND card_id IS NOT NULL").all()).results.map((r) => r.card_id));
  const phaseStart = new Map((await db.prepare("SELECT card_id, phase, MAX(at) AS at FROM phase_history WHERE kind = 'start' AND wait IS NULL GROUP BY card_id, phase").all()).results.map((r) => [`${r.card_id}|${r.phase}`, r.at]));
  // holds-need-an-end (#C838): a held card whose end has passed, or that has had none for 2 h, wakes Manager once (one row per card and reason).
  // #C915 (b): a hold_end on any card (held or not) is read, so an open one silences the card's stall and a passed one does not.
  const refs = [...new Set(cards.filter((c) => c.hold_end).map((c) => c.hold_end))];
  const endsPassed = new Set();
  for (const ref of refs) {
    const ask = await db.prepare("SELECT closed_at FROM asks WHERE id = ?").bind(ref).first();
    if (ask) { if (ask.closed_at) endsPassed.add(ref); continue; }
    const card = cards.find((c) => c.id === ref);
    if (card && (card.dropped || card.done_at || evidence[ref]?.lit?.[0] === "live")) endsPassed.add(ref);
  }
  // #C904: an ask the owner has left 10 min wakes Manager once, before the owner's phone gets it at 30 (push-rules.mjs).
  const openAsks = (await db.prepare("SELECT id, num, type, eta_at, created_at, answered_at, closed_at, withdrawn_at, owed_by FROM asks WHERE closed_at IS NULL AND answered_at IS NULL AND withdrawn_at IS NULL").all()).results;
  // #C927: a repository whose oldest open card reading is over an hour old wakes Manager once per spell (staleCopies, board-rules.mjs). The row is
  // kept (taken or not) while the spell lasts, so a later sync never tells it again; it goes when the repository's readings are fresh again.
  const copies = staleCopies({ now, cards, evidence, readAt });
  const had = new Map((await db.prepare("SELECT card_id, reason FROM stall_wakes WHERE card_id LIKE ?").bind(`${COPY_CARD}%`).all()).results.map((r) => [r.card_id, r.reason]));
  for (const id of had.keys()) if (!copies.some((s) => s.card_id === id)) await db.prepare("DELETE FROM stall_wakes WHERE card_id = ?").bind(id).run();
  const copyStalls = copies.map((s) => ({ ...s, reason: had.get(s.card_id) ?? s.reason }));
  // #C885: a read-only role's own card is worked by posts on its thread; the newest post by the card's owner, per card.
  // #C931 (6), Security's note on #C885: only the last POSTED_FRESH_MS of messages is read, the only window the rule looks at, so the scan stays small; >= keeps the boundary the rule counts as fresh (#C943).
  const postedAt = new Map((await db.prepare("SELECT m.thread_id AS card_id, MAX(m.created_at) AS at FROM messages m JOIN cards c ON c.id = m.thread_id AND m.author = c.owner_role WHERE m.created_at >= ? GROUP BY m.thread_id").bind(now - POSTED_FRESH_MS).all()).results.map((r) => [r.card_id, r.at]));
  // #C915 (d): the usual time of each work phase, from the finished rows of the history (newest 5000), for the "slow with no reason" line.
  const medians = phaseMedians((await db.prepare("SELECT id, card_id, phase, kind, at FROM phase_history WHERE wait IS NULL AND kind IN ('start', 'end') ORDER BY id DESC LIMIT 5000").all()).results);
  // A card already named by a "waits at" line this round is not named twice: that line is its one stall.
  const waits = stalledWaits({ now, cards, evidence, agents, openAskCards, phaseStart, postedAt, endsPassed });
  const slowAll = slowWakes({ now, cards, evidence, openAskCards, phaseStart, medians, endsPassed });
  const slow = slowAll.filter((s) => !waits.some((w) => w.card_id === s.card_id));
  // The slow line's words are the same every spell, so its row (card, reason) must not outlive the spell: once a card is no longer slow with no
  // reason (a reason given, a hold, the card moved on), its row goes, taken or not, and a later spell wakes Manager again (Checker F1; as copyStalls).
  const slowRows = (await db.prepare("SELECT card_id, reason FROM stall_wakes WHERE reason LIKE ?").bind(`%${SLOW_ROW_END}`).all()).results;
  for (const r of slowRows) if (!slowAll.some((s) => s.card_id === r.card_id && s.reason === r.reason)) await db.prepare("DELETE FROM stall_wakes WHERE card_id = ? AND reason = ?").bind(r.card_id, r.reason).run();
  // #C987: an answered Decision whose card moved on: one line to Manager, then the store closes it at its time (movedOnAsks, board-rules.mjs).
  const answered = (await db.prepare("SELECT id, num, type, card_id, answered_at, answer_taken_at, answer_status, closed_at, withdrawn_at, auto_closed_at FROM asks WHERE type = 'Decision' AND answered_at IS NOT NULL AND closed_at IS NULL AND withdrawn_at IS NULL AND auto_closed_at IS NULL").all()).results;
  // Each such ask's newest thread message (one bound query per ask; a handful at most).
  const lastWord = new Map();
  for (const a of answered) {
    const m = await db.prepare("SELECT author, created_at FROM messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").bind(a.id).first();
    if (m) lastWord.set(a.id, { author: m.author, at: m.created_at });
  }
  const movedOn = movedOnAsks({ now, asks: answered, cards, lastWord });
  for (const m of movedOn.filter((x) => x.due)) await db.prepare("UPDATE asks SET closed_at = ?, closed_by = ?, auto_closed_at = ? WHERE id = ? AND closed_at IS NULL").bind(now, AUTO_CLOSED_BY, now, m.ask_id).run();
  const closing = movedOn.filter((x) => !x.due).map(({ card_id, num, reason }) => ({ card_id, num, reason }));
  const stalls = [...waits, ...heldWakes({ now, cards, endsPassed }), ...slow, ...await syncE2e(db, now), ...askWakes({ asks: openAsks, now }), ...promiseWakes({ asks: openAsks, now }), ...copyStalls, ...closing];
  for (const s of stalls) await db.prepare("INSERT OR IGNORE INTO stall_wakes (card_id, reason, created_at) VALUES (?, ?, ?)").bind(s.card_id, s.reason, now).run();
  // Whatever is untaken and no longer current (the stall is over, or its reason changed) is no longer pending: a card's older reason is
  // replaced by its new one here, so Manager never reads both.
  const current = new Set(stalls.map((s) => `${s.card_id}|${s.reason}`));
  const pending = (await db.prepare("SELECT card_id, reason FROM stall_wakes WHERE taken_at IS NULL").all()).results;
  for (const p of pending) if (!current.has(`${p.card_id}|${p.reason}`)) await db.prepare("UPDATE stall_wakes SET taken_at = ? WHERE card_id = ? AND reason = ?").bind(now, p.card_id, p.reason).run();
}
// #C873: the product's daily full test run (evidence e2e). Manager's batch gets ONE line when it turns red, missed or unknown from something else:
// the row stays (taken or not) while the state holds, so a later probe run never tells it again; it goes when the state changes or turns ok.
// A reading gone stale or absent leaves the row alone (nothing current, so an untaken line is dropped as over, as any stall).
async function syncE2e(db, now) {
  const row = await db.prepare("SELECT value, read_at FROM evidence WHERE key = 'e2e'").first();
  let value = null; try { value = row ? JSON.parse(row.value) : null; } catch { /* none */ }
  const fresh = row && now - row.read_at <= STALE_AFTER_MS;
  if (fresh && value?.state === "ok") { await db.prepare("DELETE FROM stall_wakes WHERE card_id = ?").bind(E2E_CARD).run(); return []; }
  const wake = e2eWake({ now, value, readAt: row?.read_at ?? 0 });
  if (!wake) return [];
  await db.prepare("DELETE FROM stall_wakes WHERE card_id = ? AND reason NOT LIKE ?").bind(E2E_CARD, `${e2eWakeLine(wake.state)}%`).run();
  const had = await db.prepare("SELECT reason FROM stall_wakes WHERE card_id = ?").bind(E2E_CARD).first();
  return [{ card_id: E2E_CARD, num: null, reason: had?.reason ?? wake.reason }];
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
  const facts = { ...wakeFacts(w, now), ownerWaiting: n > 0 && await ownerWaiting(db) };
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

// ---- The door guard (store-manager-door-guard, #C827) ------------------------------------------------------------------
// Manager's connector shows up in other sessions too, and a read_inbox from any of them takes Manager's wake batch. The Worker cannot see
// which session sent a call, so read_inbox carries the caller's session id and the Worker compares it with the one Manager or the owner set.
// This guards against accidents (another session using the connector), not against someone who copies the id. With no id set the take goes
// through and is logged as unguarded, so a deploy never shuts Manager out.
export const DOOR_SESSION_SHAPE = /^[A-Za-z0-9_-]{8,80}$/;
export async function setDoorSession(db, now, who, session, current) {
  if (who !== "Manager" && who !== "owner") return refuse(db, now, { rule: "door-session-writer", detail: `${who ?? "unknown"} cannot set the door's session; Manager or the owner can` }, null, who);
  if (typeof session !== "string" || !DOOR_SESSION_SHAPE.test(session)) return refuse(db, now, { rule: "door-session-shape", detail: "session is 8 to 80 letters, digits, - or _" }, null, who);
  const prev = await db.prepare("SELECT session FROM door_session WHERE id = 1").first();
  // Security's F1: the session this guards against can read set_door_session in tools/list and set its own id. So on Manager's door, CHANGING an id that
  // is already set needs the current id (`current`); the owner (Access) may set it freely. The first id, with none set, needs nothing.
  if (who === "Manager") {
    const row = await db.prepare("SELECT session FROM door_session WHERE id = 1").first();
    if (row && current !== row.session) return refuse(db, now, { rule: "door-session-mismatch", detail: "changing the door's session needs `current`: the session id now set" }, null, who);
  }
  await db.prepare("INSERT INTO door_session (id, session, set_by, set_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET session = excluded.session, set_by = excluded.set_by, set_at = excluded.set_at").bind(session, who, now).run();
  // Checker's F1: replacing a DIFFERENT id that was already set is flagged: a log row, and Manager's next successful read says so (notices).
  if (prev && prev.session !== session) await db.prepare("INSERT INTO inbox_takes (at, claimed, ok, reason) VALUES (?, NULL, 1, ?)").bind(now, `door session replaced by ${who}`).run();
  return { ok: true, session };
}
// #C859: the stack switch of a repository, the owner's alone (stackSwitchRefusal). Recorded with who and when; setting it to what it is
// changes nothing but the stamp. A repository with no row reads as off.
export async function setStackSwitch(db, now, who, b) {
  const bad = stackSwitchRefusal(b, who);
  if (bad) return refuse(db, now, bad, null, who);
  await db.prepare("INSERT INTO stack_switch (repo, stack, set_by, set_at) VALUES (?, ?, ?, ?) ON CONFLICT(repo) DO UPDATE SET stack = excluded.stack, set_by = excluded.set_by, set_at = excluded.set_at").bind(b.repo, b.stack ? 1 : 0, who, now).run();
  return { ok: true, repo: b.repo, stack: b.stack };
}
// #C871: the owner moves a card that has not started up or down in its agent's queue. The queue is the agent's cards not dropped and with no
// commit pushed (the probe's reading), in queue_pos order (a card with none after those with one), then by number. The queue is renumbered
// 1..n, and the two cards swapped carry the owner's stamp, so an agent cannot move them back (queueWriteRefusal).
// An agent's queue, in order (queueRank): its cards not dropped and with nothing pushed (the probe's reading), each { id, num, queue_pos, owner
// (the owner placed it), held (a depends_on that is not live) }. The same list serves the move, and the floor an agent's write may not pass.
export async function queueCards(db, role) {
  const all = (await db.prepare("SELECT id, num, owner_role, queue_pos, queue_set_by, depends_on, dropped, done_at FROM cards").all()).results ?? [];
  const evidence = {};
  for (const c of all) if (c.depends_on) for (const d of (() => { try { const l = JSON.parse(c.depends_on); return Array.isArray(l) ? l : []; } catch { return []; } })()) if (typeof d === "string" && !(d in evidence)) evidence[d] = await evidenceOf(db, `cards.${d}`);
  const queue = [];
  for (const r of all.filter((c) => c.owner_role === role && !c.dropped && !c.done_at)) {
    const e = await evidenceOf(db, `cards.${r.id}`);
    if (e?.headSha12 || e?.phase === "live") continue;
    queue.push({ id: r.id, num: r.num, queue_pos: r.queue_pos, owner: r.queue_set_by === "owner", held: dependsNotLive(r, all, evidence) });
  }
  return queue.sort(queueRank);
}
// The last place the owner holds in a queue, not counting `exceptId`: an agent may not write a place at or ahead of it (queueWriteRefusal).
const ownerFloor = async (db, role, exceptId) => Math.max(0, ...(await queueCards(db, role)).filter((r) => r.owner && r.id !== exceptId && Number.isInteger(r.queue_pos)).map((r) => r.queue_pos));
export async function moveInQueue(db, now, who, b) {
  const bad = queueMoveRefusal(b, who);
  if (bad) return refuse(db, now, bad, b?.id, who);
  const card = await db.prepare("SELECT id, owner_role, dropped, done_at FROM cards WHERE id = ?").bind(b.id).first();
  if (!card || card.dropped || card.done_at) return refuse(db, now, { rule: "card-unknown", detail: String(b.id) }, b.id, who);
  const queue = await queueCards(db, card.owner_role);
  const at = queue.findIndex((r) => r.id === b.id);
  if (at < 0) return refuse(db, now, { rule: "queue-started", detail: `${b.id} has started: only a card with nothing pushed is in the queue` }, b.id, who);
  const to = b.dir === "up" ? at - 1 : at + 1;
  // A card held by a depends_on stays after those that can start: it does not cross that line, and nothing crosses it going the other way.
  if (to < 0 || to >= queue.length || queue[to].held !== queue[at].held) return { ok: true, id: b.id, moved: false, order: queue.map((r) => r.id) };
  [queue[at], queue[to]] = [queue[to], queue[at]];
  const swapped = new Set([queue[at].id, queue[to].id]);
  for (let n = 0; n < queue.length; n++) {
    const r = queue[n];
    if (swapped.has(r.id)) await db.prepare("UPDATE cards SET queue_pos = ?, queue_set_by = ?, queue_set_at = ?, updated_at = ? WHERE id = ?").bind(n + 1, who, now, now, r.id).run();
    else if (r.queue_pos !== n + 1) await db.prepare("UPDATE cards SET queue_pos = ?, updated_at = ? WHERE id = ?").bind(n + 1, now, r.id).run();
  }
  return { ok: true, id: b.id, moved: true, order: queue.map((r) => r.id) };
}
export async function guardedInbox(db, now, session) {
  const expected = await db.prepare("SELECT session, set_by, set_at FROM door_session WHERE id = 1").first();
  const claimed = typeof session === "string" ? session.slice(0, 80) : null;
  const log = (ok, reason) => db.prepare("INSERT INTO inbox_takes (at, claimed, ok, reason) VALUES (?, ?, ?, ?)").bind(now, claimed, ok ? 1 : 0, reason).run();
  if (expected && claimed !== expected.session) {
    await log(false, claimed === null ? "no session given" : "session does not match");
    // The expected id is never echoed back.
    const lastSet = `the door's session was last set by ${expected.set_by} at ${mtDayTime(expected.set_at)}`;
    return refuse(db, now, { rule: "door-session-mismatch", detail: `${claimed === null ? "read_inbox needs the \`session\` argument: Manager's own session id." : "the session given is not the one set for Manager's door."} If you are not Manager's session, stop and tell Manager; never call set_door_session to get past this refusal. (${lastSet})` }, null, "Manager");
  }
  await log(true, expected ? "match" : "no session set: unguarded");
  const notes = (await db.prepare("SELECT id, at, reason FROM inbox_takes WHERE noticed_at IS NULL AND reason LIKE 'door session replaced by %' ORDER BY id").all()).results;
  const got = await takeInbox(db, now);
  if (notes.length) {
    for (const n of notes) await db.prepare("UPDATE inbox_takes SET noticed_at = ? WHERE id = ?").bind(now, n.id).run();
    got.notices = notes.map((n) => `${n.reason} at ${mtDayTime(n.at)}`);
  }
  return got;
}

// Manager's typed read: returns what is for Manager as data and marks it taken (the batch closes, wake.seen_at moves).
export async function takeInbox(db, now) {
  const messages = (await db.prepare("SELECT id, thread_id, author, body, created_at FROM messages WHERE delivered_at IS NULL AND author = 'owner' ORDER BY created_at").all()).results;
  const answers = (await db.prepare("SELECT id, num, title, answer, answer_status, answer_note, answered_at, answered_by FROM asks WHERE answered_at IS NOT NULL AND answer_taken_at IS NULL ORDER BY answered_at").all()).results;
  // The files attached to each message and answer (store-inbox-shows-files, #C837): [{ id, name, type, size, fetch }], in the order attached, empty when none.
  // `fetch` is the path under the board's address (GET <address>/_blob/<id>, a signed-in session; no tool returns the bytes). Chunks of 90 ids plus the kind stay under D1's 100 binds.
  const filesOf = async (kind, rows) => {
    const by = new Map();
    for (let i = 0; i < rows.length; i += 90) {
      const ids = rows.slice(i, i + 90).map((r) => r.id);
      const found = (await db.prepare(`SELECT l.ref_id, f.id, f.name, f.type, f.size FROM file_links l JOIN files f ON f.id = l.file_id WHERE l.ref_kind = ? AND l.ref_id IN (${ids.map(() => "?").join(", ")}) ORDER BY l.ref_id, l.pos`).bind(kind, ...ids).all()).results;
      for (const f of found) (by.get(f.ref_id) ?? by.set(f.ref_id, []).get(f.ref_id)).push({ id: f.id, name: f.name, type: f.type, size: f.size, fetch: `/_blob/${f.id}` });
    }
    for (const r of rows) r.files = by.get(r.id) ?? [];
  };
  await filesOf("message", messages);
  await filesOf("answer", answers);
  // #C932: an imported "something else" kept the old response object whole as the answer string (no answer_status): Manager reads the owner's
  // typed text, as for a native answer, never the object as JSON. Only what is returned changes; no row is rewritten.
  // Only that: the import kept every old response object whole (Ack, Done, Help with files, a picked letter), and those read as they were stored
  // (Checker F1): the object must say its choice was "something else", as the view's rule does (a Decision whose answer matches no option).
  for (const a of answers) { const o = a.answer_status ? null : typedOther(a.answer); if (o && o.choice === "something else") a.answer = o.note.trim() || "Something else"; }
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

// #C832 (Checker 2 F1, Security LOW): the link a live reading closes its card with, built only from what the probe's own state schema takes (a full 40-hex
// head sha, an owner/name repository) and held to the rule card_update's done_evidence meets (an https link, 500 characters at most). Anything else: null,
// and nothing closes (evidenceRefusal checks only `lit`, so the shapes are checked here, where the string becomes evidence).
const LIVE_SHA = /^[0-9a-f]{40}$/, LIVE_REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
export function liveDoneEvidence(reading) {
  const { headSha, repoFull } = reading ?? {};
  if (typeof headSha !== "string" || typeof repoFull !== "string" || !LIVE_SHA.test(headSha) || !LIVE_REPO.test(repoFull)) return null;
  const link = `https://github.com/${repoFull}/commit/${headSha}`;
  return link.length <= 500 && DONE_EVIDENCE.test(link) ? link : null;
}

// Evidence: only the probe writes it; one lit phase per card.
export async function writeEvidence(db, now, who, key, value, track) {
  const bad = evidenceRefusal(key, value, who, track);
  if (bad) return refuse(db, now, bad, key.startsWith?.("cards.") ? key.slice(6) : null, who);
  const upsertOf = (v) => db.prepare("INSERT INTO evidence (key, value, read_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, read_at = excluded.read_at").bind(key, JSON.stringify(v), now);
  if (!key.startsWith("cards.")) { await upsertOf(value).run(); return { ok: true }; }
  // A card's lit phase changed (or is read for the first time): the phase history gets its rows in the same write (#C723 B3b).
  // The phase it was in: the last evidence reading, else (the first reading after the one-time import) the phase the history left open.
  const cardId = key.slice(6), next = value.lit[0];
  const before = await evidenceOf(db, key);
  // #C875: the Rework flag is the Worker's, never the probe's: a `rework` the probe sends is dropped. It is set on a transition between two readings
  // (reworkTriggered), kept across the readings that follow, and cleared when a reason is attached (updateCard) or the card is on main or live.
  const { rework: _sent, ...reading } = value;
  const rework = before?.rework === true && reading.onMain !== true && next !== "live" ? true : reworkTriggered(before, reading);
  const upsert = upsertOf(rework ? { ...reading, rework: true } : reading);
  let prev = before?.lit?.[0] ?? null;
  // A wait step (the step tool, #C739) is not the lit phase: the three reads of the history below take the probe's own rows only (wait IS NULL).
  if (!prev) { const last = await db.prepare("SELECT phase, kind FROM phase_history WHERE card_id = ? AND wait IS NULL ORDER BY at DESC, id DESC LIMIT 1").bind(cardId).first(); if (last?.kind === "start") prev = last.phase; }
  const prevWho = prev && prev !== next ? (await db.prepare("SELECT who FROM phase_history WHERE card_id = ? AND phase = ? AND kind = 'start' AND wait IS NULL ORDER BY at DESC, id DESC LIMIT 1").bind(cardId, prev).first())?.who ?? null : null;
  const cardRow = await db.prepare("SELECT owner_role, repo FROM cards WHERE id = ?").bind(cardId).first();
  const agents = (await evidenceOf(db, "agents")) ?? {}, ownerRole = cardRow?.owner_role;
  const rows = prev === next ? [] : historyRows(cardId, prev, next, now, whoForPhase(cardId, next, agents, ownerRole), prevWho);
  // #C881: Started is the first push (PARITY row 35). A card whose first reading is already past build, with no row of its own (the probe sees a
  // card only once something is pushed), gets its build start and end at that first push, so every lit card has a build row and a start time.
  if (!prev && next !== "build" && PHASES.indexOf(next) > PHASES.indexOf("build") && next !== "live" && !(await db.prepare("SELECT 1 AS x FROM phase_history WHERE card_id = ? AND wait IS NULL LIMIT 1").bind(cardId).first())) {
    const who = whoForPhase(cardId, "build", agents, ownerRole);
    rows.unshift({ card_id: cardId, phase: "build", kind: "start", at: now, who }, { card_id: cardId, phase: "build", kind: "end", at: now, who });
  }
  const ins = rows.map((r) => db.prepare("INSERT OR IGNORE INTO phase_history (card_id, phase, kind, at, who, source) VALUES (?, ?, ?, ?, ?, 'evidence')").bind(r.card_id, r.phase, r.kind, r.at, r.who));
  // #C976: a board card at ship and on main waits on the owner's install: its own wait row (phase ship, wait install, who owner) opens on the
  // reading that starts the wait and closes on the one that ends it (live, or off ship or main). The probe's own rows are untouched.
  const lastWait = await db.prepare("SELECT kind FROM phase_history WHERE card_id = ? AND wait = ? ORDER BY at DESC, id DESC LIMIT 1").bind(cardId, INSTALL_WAIT).first();
  const step = installWaitStep({ repo: cardRow?.repo, next, onMain: reading.onMain, open: lastWait?.kind === "start" });
  if (step) ins.push(db.prepare("INSERT OR IGNORE INTO phase_history (card_id, phase, kind, at, who, source, wait) VALUES (?, 'ship', ?, ?, 'owner', 'evidence', ?)").bind(cardId, step, now, INSTALL_WAIT));
  // #C832: a card whose reading is live is finished: the program closes it (done_at = when it first read live, done_evidence = its commit's link),
  // nothing is typed. Not a dropped or already-done card, and not one the lead gave a check date (a date is a wish to look again). A reading with
  // no full head sha or repository name has no link to show, so it closes nothing (the next reading with one does).
  const link = next === "live" ? liveDoneEvidence(reading) : null;
  const closes = link
    ? [db.prepare("UPDATE cards SET done_at = ?, done_evidence = ?, updated_at = ? WHERE id = ? AND done_at IS NULL AND dropped = 0 AND check_at IS NULL").bind(now, link, now, cardId)] : [];
  await db.batch([upsert, ...ins, ...closes]);
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
  const stackSwitch = (await all("SELECT repo, stack, set_by, set_at FROM stack_switch ORDER BY repo")).map((r) => ({ ...r, stack: r.stack === 1 }));
  const threads = await readThreads(db), files = await readFiles(db, asks, threads.messages), ships = await readShips(db), usage = await readUsage(db);
  const reworkHistory = await all("SELECT card_id, reason, at, who FROM rework_history ORDER BY at, id");
  const content = { cards, asks, lists, evidence, refusals, wake, history, historyCards, files, ships, usage, threads, stackSwitch, reworkHistory };
  // The tag covers what the page shows; a probe going silent changes it, the clock moving alone does not.
  const wakeState = wakeStatus(wakeFacts(wake, wake.alive_at || undefined), now);
  const tag = (await sha256hex(JSON.stringify([content, probe.state, wakeState.state, wakeState.reason ?? null]))).slice(0, 16);
  return { tag, now, live, probe, wakeState, ...content };
}
