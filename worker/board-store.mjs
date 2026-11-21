// Board store operations on D1 (#C719). Every write goes through the rules in board-rules.mjs in the same call; a refusal is
// logged (rule, card, who, time) and returned, nothing is written. `db` is a D1 binding (or tests/helpers/d1-sqlite.mjs).
import { pausedDepLanded, PAUSE_DEP_END, openDecisionHolds, rcOffWakes, RC_OFF_CARD, landedUnbuilt, reviewLateWakes, REVIEW_LATE_MARK, reworkTriggered, signoffClears, reviewHoldRole, staleCopies, COPY_CARD, E2E_CARD, TRUTH_CARD, truthWake, e2eWake, e2eWakeLine, staleMsOf, holdEndRefusal, autoHoldEnd, heldWakes, endedHolds, holdWords, phaseMedians, slowWakes, SLOW_ROW_END, outOfOrderWork, ORDER_ROW_END, askRefusal, cardWriteRefusal, closeRefusal, withdrawRefusal, outdatedRefusal, replacedByNum, answerShapeRefusal, messageExtrasRefusal, listWriteRefusal, evidenceRefusal, liveNow, historyRows, whoForPhase, PHASES, stalledWaits, stallMsOf, shipSlowMsOf, quotaHold, postedFreshMsOf, copyStaleMsOf, landedUnbuiltMsOf, holdNoEndMsOf, autoCloseMsOf, quotaOutPctOf, stepRefusal, stackSwitchRefusal, reviewClaimRefusal, queueWriteRefusal, queueMoveRefusal, pullOutRefusal, groupMoveRefusal, groupRenameRefusal, moveToGroupRefusal, slugOfName, groupPastBuild, slotKeyOf, SLOT_PREFIX, hasPlace, groupCompare, orderListOf, agentRank, isRework, startedGroupSet, groupOf, queueRank, dependsNotLive, ASK_PARTS, ASK_OPTIONAL_PARTS, APPROVE, PROBE_CARD_ID, PROBE_CARD_ID_MAX, isBoardCard, typedOther, zTimeRefusal, inlineListRefusal, installWaitStep, INSTALL_WAIT, movedOnAsks, AUTO_CLOSED_BY, DONE_EVIDENCE, AGENT_STALL, agentStallRow, agentStallOf, raisedIssues, unexplainedStepBack, issueTotal, REASON_COUNTER, sweepAsk, SWEEP_TITLE } from "./board-rules.mjs";
import { classifySend, nudgeLine, shouldSend, wakeStatus, shouldTellOwner, wakeLimits } from "./wake-rules.mjs";
import { readFiles, screenshotsRefusal, parseShot } from "./file-store.mjs";
import { noteShip, readShips } from "./compat-ships.mjs";
import { readUsage } from "./compat-usage.mjs";
import { mtDayTime } from "./team-time.mjs";
import { readThreads } from "./compat-threads.mjs";
import { KNOBS, knobFrom } from "./knobs.mjs";
import { askWakes, promiseWakes, promptWakes, watchWakes, WATCH_WAKE_PREFIX, ownerWordWakes, pushLimits } from "./push-rules.mjs";
import { weekUsageValue, sessionWeek, WEEK_USAGE_KEY } from "../collector/week-usage.mjs";

// #C997: the setting probeSilentSec (worker/knobs.mjs); this is its default.
export const PROBE_SILENT_MS = KNOBS.probeSilentSec.default * 1000;
// The posted settings, or null: the store keeps the probe's last good reading of them.
async function knobsStored(db) {
  const row = await db.prepare("SELECT value FROM evidence WHERE key = 'knobs'").first();
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}
// #C990 on #C997: the silence that makes an outage is the posted setting probeSilentSec, the same edge the Probe chip uses.
const silentMsOf = async (db) => knobFrom(await knobsStored(db), "probeSilentSec") * 1000;
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

const COLUMNS = ["title", "summary", "size", "review_level", "from_thread", "track", "owner_role", "next_note", "waiting_on", "blocked_reason", "paused", "dropped", "rework_reason", "customer_text", "look_change", "skip", "depends_on", "issues", "queue_pos", "check_at", "repo", "batch", "bump", "hold_end", "removes", "contract", "changes_definition"];
// true/false are stored as 1/0; a list or the issue counts are stored as JSON text (null stays null: "not said").
const bool = (v) => (v === true ? 1 : v === false ? 0 : Array.isArray(v) || (v && typeof v === "object") ? JSON.stringify(v) : v);

// A new card: words only. The id is the caller's, the number the store's.
// #C1087 (11-16: a card was created with no summary and the builder had nothing to build from): through the card_create TOOL (opts.needSummary, set by
// board-worker.mjs) a card with no summary, or one that is only blanks, is refused unless from_thread names a thread that exists (an ask's number or a
// thread of messages), which then explains the card. Store callers that pass no opts (the tests, the importers) are as before.
export async function createCard(db, now, who, fields, opts = {}) {
  // #C748 (Checker F5): the check date is the lead's or the owner's on a new card too.
  if (fields && typeof fields === "object" && "check_at" in fields && !CHECK_AT_WRITERS.includes(who)) return refuse(db, now, { rule: "check-at-lead-only", detail: `${who ?? "unknown"} cannot set a card's check date; ${CHECK_AT_WRITERS.join(" or ")} can` }, fields.id, who);
  // #C1150: a blank repo (empty or only spaces) is "no repo" through the tool, said before the shape rule, so the refusal lists the known repos.
  if (opts.needRepo && typeof fields.repo === "string" && !fields.repo.trim()) return refuse(db, now, await repoRefusal(db), fields.id, who);
  const bad = cardWriteRefusal(fields, null) ?? reviewHoldWriterRefusal(fields, who);
  if (bad) return refuse(db, now, bad, fields?.id, who);
  if ("done" in fields || "done_evidence" in fields) return refuse(db, now, { rule: "card-done", detail: "a new card is not done: create it, then close it with card_update" }, fields.id, who);
  const noEnd = holdEndRefusal(fields, null) ?? (await holdEndUnknown(db, fields)) ?? (await dependsOnUnknown(db, fields));
  if (noEnd) return refuse(db, now, noEnd, fields?.id, who);
  // #C949: a new id is one the probe can read (collector/state-schema.mjs CARD_ID): a card it skips gets no evidence row, so a landed card is never seen.
  if (typeof fields.id !== "string" || !PROBE_CARD_ID.test(fields.id) || fields.id.length > PROBE_CARD_ID_MAX) return refuse(db, now, { rule: "card-id", detail: `lowercase letters and digits in up to 5 words joined by hyphens, each word up to 16 characters, up to ${PROBE_CARD_ID_MAX} characters in all, so the probe can read the card` }, fields.id, who);
  // #C1329 (Checker 2's LOW on #C1325): a re-cut branch is named <card id>-v<N> and the probe reads that suffix off the name to find the card (slugOfBranch), so a card whose own id ends
  // in -v<number> would be matched by the re-cut of a different card and read as it. Refused whatever the width of the number.
  if (/-v\d+$/.test(fields.id)) return refuse(db, now, { rule: "card-id-vn", detail: "an id may not end in -v and a number (-v2, -v10): a re-cut branch is named <card id>-v<N>, so the board would read it as a re-cut of another card; name it another way (v2-cleanup, or spell the number out)" }, fields.id, who);
  if (typeof fields.title !== "string" || !fields.title.trim()) return refuse(db, now, { rule: "card-shape", detail: "title is required" }, fields.id, who);
  if (await db.prepare("SELECT 1 AS x FROM cards WHERE id = ?").bind(fields.id).first()) return refuse(db, now, { rule: "card-exists", detail: fields.id }, fields.id, who);
  if (opts.needSummary && !(typeof fields.summary === "string" && fields.summary.trim())) {
    if (!(await threadKnown(db, fields.from_thread))) return refuse(db, now, { rule: "card-summary", detail: "a new card needs a summary (what to build and why): write it, or give from_thread, the number of a thread that already explains the card" }, fields.id, who);
  }
  // #C1107 (11-16: 15 of 27 cards were loose because grouping lived in the lead's memory): through the card_create TOOL (opts.needGroup) a card with no batch is
  // refused, and the refusal lists the open groups to put it in.
  if (opts.needGroup && !(typeof fields.batch === "string" && fields.batch.trim())) return refuse(db, now, await groupRefusal(db, "a new card needs a group (batch): the group it ships with"), fields.id, who);
  // #C1149 (the review dispatch woke Checker 2 for #C1148, a product card created with no repo word, which the board reads as its own): through the card_create TOOL
  // (opts.needRepo) a card with no repo is refused, and the refusal lists the known repos. Old cards with none keep being read as the board's.
  if (opts.needRepo && !(typeof fields.repo === "string" && fields.repo.trim())) return refuse(db, now, await repoRefusal(db), fields.id, who);
  // #C1169: through the card_create TOOL (opts.needContract) a flight-board card names what it touches (see contractRefusal); said after the group and repo rules.
  if (opts.needContract && isBoardCard(fields)) { const noContract = await contractRefusal(db, fields); if (noContract) return refuse(db, now, noContract, fields.id, who); }
  // #C871: a new card may not take a place at or ahead of one the owner holds in its agent's queue (queueWriteRefusal).
  const floorBad = who !== "owner" && Number.isInteger(fields.queue_pos) && typeof fields.owner_role === "string" ? queueWriteRefusal(fields, null, who, await ownerFloor(db, fields.owner_role, fields.id)) : null;
  if (floorBad) return refuse(db, now, floorBad, fields.id, who);
  const num = await mint(db, "C");
  const row = COLUMNS.map((c) => (c in fields ? bool(fields[c]) : null) ?? defaultFor(c));
  await db.prepare(`INSERT INTO cards (id, num, ${COLUMNS.join(", ")}, issues_at, held_at, hold_until, created_at, updated_at) VALUES (?, ?, ${COLUMNS.map(() => "?").join(", ")}, ?, ?, ?, ?, ?)`)
    .bind(fields.id, num, ...row, fields.issues ? now : null, holdWords(fields) ? now : null, autoHoldEnd(fields, null, now, holdNoEndMsOf(await knobsStored(db))), now, now).run();
  if (typeof fields.batch === "string" && fields.batch.trim()) await ensureGroup(db, now, who, fields.batch);
  return { ok: true, id: fields.id, num };
}
// #C1169 (11-17: a card was carded against DATA.md:131 without checking it; the owner: cards about the flight-board must match the first-level principles; principles 1
// and 5: a note is not a rule, refuse early): a flight-board card is written with `contract`, the principle numbers and DATA.md rows or definitions it touches, and
// `changes_definition`, true or false. True needs from_thread, the number of the thread where the owner decided it, else the card is refused.
// #C1206 (11-17: the owner chose a Decision in thread #T2043, id t-1794984971436, and the card was still refused): a thread opened by the owner has an id of its own
// and its number in threads.num, so its messages never carry thread_id "t<num>"; a threads row with that number and a message in it is a known thread too.
const threadKnown = async (db, t) => Number.isInteger(t) && t > 0 && !!(await db.prepare("SELECT 1 AS x FROM asks WHERE num = ? UNION ALL SELECT 1 AS x FROM messages WHERE thread_id = ? UNION ALL SELECT 1 AS x FROM threads WHERE num = ? AND EXISTS (SELECT 1 FROM messages WHERE messages.thread_id = threads.id)").bind(t, `t${t}`, t).first());
async function contractRefusal(db, fields) {
  const c = fields.contract, d = fields.changes_definition;
  if (!(typeof c === "string" && c.trim())) return { rule: "card-contract", detail: "a flight-board card needs contract: the principle numbers and DATA.md rows or definitions it touches (or \"touches no definition\" and why), and changes_definition true or false" };
  if (![true, false, 1, 0].includes(d)) return { rule: "card-contract", detail: "a flight-board card needs changes_definition: true if it changes a principle or a DATA.md definition, else false" };
  if ((d === true || d === 1) && !(await threadKnown(db, fields.from_thread))) return { rule: "card-changes-definition", detail: `this changes ${c.trim().slice(0, 120)}: ask the owner first, then give from_thread, the number of the thread where the owner decided it` };
  return null;
}
const defaultFor = (c) => (c === "summary" ? "" : c === "track" ? "product" : c === "paused" || c === "dropped" ? 0 : null);

// #C1107: the open groups (a batch with a card that is neither dropped nor done), newest first, for the refusal to name. At most 12, then "and N more".
const OPEN_GROUPS_SHOWN = 12;
async function groupRefusal(db, what) {
  const rows = (await db.prepare("SELECT batch, MAX(num) AS newest FROM cards WHERE batch IS NOT NULL AND TRIM(batch) != '' AND dropped = 0 AND done_at IS NULL GROUP BY batch ORDER BY newest DESC").all()).results ?? [];
  const names = rows.map((r) => r.batch);
  const shown = names.slice(0, OPEN_GROUPS_SHOWN).join(", ");
  const more = names.length > OPEN_GROUPS_SHOWN ? ` and ${names.length - OPEN_GROUPS_SHOWN} more` : "";
  return { rule: "card-group", detail: `${what}; give batch an open group (${names.length ? `${shown}${more}` : "none is open"}) or a new group's id (lower case letters, digits and -)` };
}

// holds-need-an-end (#C838): hold_end names an OPEN ask or a card that is not dropped; null lifts it.
// #C1149: the known repos for the repo refusal: "flight-board" (the board's own) and every other word an existing card carries ("board" is read as flight-board).
async function repoRefusal(db) {
  const rows = (await db.prepare("SELECT DISTINCT repo FROM cards WHERE repo IS NOT NULL AND TRIM(repo) != '' ORDER BY repo").all()).results ?? [];
  const names = [...new Set(["flight-board", ...rows.map((r) => r.repo).filter((r) => r !== "board")])];
  return { rule: "card-repo-missing", detail: `a new card needs a repo: the repository its code is in (known: ${names.join(", ")}); the board reads a card with none as flight-board's own, so its review goes to that repository's reviewer` };
}
const holdEndUnknown = async (db, fields) => {
  const ref = fields.hold_end;
  if (ref === undefined || ref === null) return null;
  const ok = await db.prepare("SELECT 1 AS x FROM asks WHERE id = ? AND closed_at IS NULL AND outdated_at IS NULL UNION ALL SELECT 1 AS x FROM cards WHERE id = ? AND dropped = 0 AND done_at IS NULL").bind(ref, ref).first();
  return ok ? null : { rule: "hold-end-unknown", detail: `${ref} is no open ask and no live card` };
};

// #C1003: depends_on names cards that exist (a done or dropped card is still a known id; a list that is empty or null clears it). An unknown id
// is refused with the closest card id, so a typo (tests-clean-temp-folders for tests-clean-their-tmp) never becomes a dependency that cannot hold.
const editDistance = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};
// The words an id shares with another count most: "tests-clean-temp-folders" and "tests-clean-their-tmp" share two of three.
const closeness = (a, b) => {
  const wa = new Set(a.split("-")), wb = b.split("-");
  return wb.filter((w) => wa.has(w)).length * 100 - editDistance(a, b);
};
const dependsOnUnknown = async (db, fields) => {
  const list = fields.depends_on;
  if (!Array.isArray(list) || !list.length) return null;
  const ids = ((await db.prepare("SELECT id FROM cards").all()).results ?? []).map((r) => r.id);
  const known = new Set(ids);
  const missing = list.filter((d) => typeof d === "string" && !known.has(d));
  if (!missing.length) return null;
  const hint = (d) => {
    const best = ids.filter((x) => x !== fields.id).sort((x, y) => closeness(d, y) - closeness(d, x))[0];
    return best ? `${d} is no card on the board (closest: ${best})` : `${d} is no card on the board`;
  };
  return { rule: "depends-on-unknown", detail: missing.map(hint).join("; ") };
};

const CHECK_AT_WRITERS = ["Manager", "owner"];
const REVIEW_HOLD_WRITERS = ["Manager"];
// #C1048: a waiting_on in the review-hold form ends by itself when its reviewer signs (signoffClears), so only the lead or that reviewer may write
// one, on a new card (Security's F1 on 2f30cfc3: card_create passed it) as on an existing one; anyone else holds a card in other words.
function reviewHoldWriterRefusal(fields, who) {
  const role = fields && typeof fields === "object" && "waiting_on" in fields ? reviewHoldRole(fields.waiting_on) : null;
  if (!role || REVIEW_HOLD_WRITERS.includes(who) || who === role) return null;
  return { rule: "review-hold-writer", detail: `"${String(fields.waiting_on).trim().slice(0, 60)}" is a review hold, which ends by itself when ${role} signs: only ${REVIEW_HOLD_WRITERS.join(" or ")} or ${role} may write it; ${who ?? "unknown"} can hold the card in other words` };
}
// Card words changed later: checked against the probe's reading of this card (a typed word cannot contradict it).
// #C1107: through the card_update TOOL (opts.needGroup) a write that clears batch (null, empty or blanks) is refused: a card leaves a group only by moving to
// another one, or by the owner's pull-out (pullOutOfGroup, its own tool). A card that has no group yet is written only by a write that gives it one (below).
export async function updateCard(db, now, who, fields, opts = {}) {
  const id = fields?.id;
  if (opts.needGroup && fields && typeof fields === "object" && "batch" in fields && (fields.batch === null || (typeof fields.batch === "string" && !fields.batch.trim()))) return refuse(db, now, await groupRefusal(db, "a write cannot take a card out of its group (batch)"), id, who);
  const card = typeof id === "string" ? await db.prepare("SELECT id, next_note, waiting_on, blocked_reason, check_at, hold_end, held_at, hold_until, queue_set_by, queue_pos, owner_role, dropped, done_at, batch, repo FROM cards WHERE id = ?").bind(id).first() : null;
  if (!card) return refuse(db, now, { rule: "card-unknown", detail: String(id) }, id, who);
  // The lead's ruling (B, on the card's note): a card with no group is written only by a write that gives it one; closing it (done with its evidence, or dropped) needs none,
  // and a card already done or dropped is not asked for one.
  // Checker 2's round 2: an un-drop (dropped false or 0) puts the card back among the open ones, so it needs a group like any write to a loose card.
  const undrop = fields.dropped === false || fields.dropped === 0;
  if (opts.needGroup && !String(card.batch ?? "").trim() && (undrop || (!card.done_at && !card.dropped)) && !(typeof fields.batch === "string" && fields.batch.trim()) && !(fields.done === true || fields.dropped === true || fields.dropped === 1)) {
    return refuse(db, now, await groupRefusal(db, `${id} has no group yet: this write must set batch (a write that closes or drops the card needs none)`), id, who);
  }
  // #C1169: through the card_update TOOL (opts.needContract) a write that changes a flight-board card's summary, its contract or its changes_definition carries both, in the same write
  // (Checker 2's LOW 3: the flag alone, or a blanked contract, must not get past the from_thread rule).
  if (opts.needContract && ("summary" in fields || "contract" in fields || "changes_definition" in fields) && isBoardCard({ repo: "repo" in fields ? fields.repo : card.repo })) {
    const noContract = await contractRefusal(db, fields);
    if (noContract) return refuse(db, now, noContract, id, who);
  }
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
  // #C1150: a card never loses its repo after it is created: null on a card that has one is refused (a blank is refused above by the shape rule); another word is fine.
  if ("repo" in fields && fields.repo === null && typeof card.repo === "string" && card.repo !== "") return refuse(db, now, { rule: "card-repo-kept", detail: `${id} is in ${card.repo}: a card keeps its repo; write another repository word to move it` }, id, who);
  // #C748: the check date holds a card open past its live reading, so only the lead (or the owner) sets it or lifts it (null), as on the old board.
  if ("check_at" in fields && !CHECK_AT_WRITERS.includes(who)) return refuse(db, now, { rule: "check-at-lead-only", detail: `${who ?? "unknown"} cannot set or lift a card's check date; ${CHECK_AT_WRITERS.join(" or ")} can` }, id, who);
  // #C1048 (the lead's pick A and its condition): a waiting_on in the review-hold form ends by itself when its reviewer signs (signoffClears), so
  // only the lead or that reviewer may write one; anyone else (an agent, the owner's page) writes its hold in other words, which never auto-clear.
  const holdBad = reviewHoldWriterRefusal(fields, who);
  if (holdBad) return refuse(db, now, holdBad, id, who);
  const noEnd = holdEndRefusal(fields, card) ?? (await holdEndUnknown(db, fields)) ?? (await dependsOnUnknown(db, fields));
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
  // #C1008: a card put in a group again is no longer "pulled out".
  if (keys.includes("batch") && typeof fields.batch === "string" && fields.batch) sets.push("pulled_from = NULL", "pulled_by = NULL", "pulled_at = NULL");
  // When the hold began: set by the write that makes the card held, kept while it stays held, cleared (with its end) when it is lifted.
  if (keys.includes("waiting_on") || keys.includes("blocked_reason")) {
    const after = { waiting_on: "waiting_on" in fields ? fields.waiting_on : card.waiting_on, blocked_reason: "blocked_reason" in fields ? fields.blocked_reason : card.blocked_reason };
    sets.push("held_at = ?"); vals.push(holdWords(after) ? (holdWords(card) ? card.held_at ?? now : now) : null);
    if (!holdWords(after) && !("hold_end" in fields)) sets.push("hold_end = NULL");
    // a waiting_on with no explicit end gets one from the store (now + 2 h, renewed by each such write); lifting the hold, or an explicit end, clears it
    sets.push("hold_until = ?"); vals.push(holdWords(after) ? autoHoldEnd(fields, card, now, holdNoEndMsOf(await knobsStored(db))) : null);
  }
  await db.prepare(`UPDATE cards SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...vals, now, id).run();
  // #C1299: a card put in a group has the group's number minted (a new group gets its #G number here) and loses a single card's own place in the order list.
  if (keys.includes("batch") && typeof fields.batch === "string" && fields.batch.trim()) await joinedGroup(db, now, who, id, fields.batch);
  // #C875: a reason attached ends the rework's wait for one (the flag in the card's evidence goes) and is kept in the card's reason history.
  if (keys.includes("rework_reason") && typeof fields.rework_reason === "string") {
    await db.prepare("INSERT INTO rework_history (card_id, reason, at, who) VALUES (?, ?, ?, ?)").bind(id, fields.rework_reason, now, who ?? null).run();
    // #C1114 part 2: a reason attached to a rework that waits for one (the flag is true, or "unexplained" for a step back the Worker is holding) adds 1 to its counter,
    // once: the flag goes with this write, so the same reason written again adds nothing. "review findings" has no counter (the notes count those). A held step back
    // keeps the head the reason was given for in `reasoned`, so the reading at that head moves the card back without asking again.
    let ev = null; try { ev = JSON.parse((await db.prepare("SELECT value FROM evidence WHERE key = ?").bind(`cards.${id}`).first())?.value ?? "null"); } catch { /* none */ }
    const pending = ev && (ev.rework === true || ev.rework === "unexplained");
    const kind = REASON_COUNTER[fields.rework_reason];
    if (pending && kind) {
      const row = await db.prepare("SELECT issues FROM cards WHERE id = ?").bind(id).first();
      let have = {}; try { have = row?.issues ? JSON.parse(row.issues) : {}; } catch { /* none */ }
      if (!have || typeof have !== "object" || Array.isArray(have)) have = {};
      const next = { ...have, [kind]: Math.min(99, (Number.isInteger(have[kind]) ? have[kind] : 0) + 1) };
      await db.prepare("UPDATE cards SET issues = ?, issues_at = ? WHERE id = ?").bind(JSON.stringify(next), now, id).run();
    }
    if (ev && ev.rework !== undefined) {
      const { rework, reworkAt: _at, actual, ...rest } = ev;
      const cleared = rework === "unexplained" && typeof actual?.headSha12 === "string" ? { ...rest, reasoned: actual.headSha12 } : rest;
      await db.prepare("UPDATE evidence SET value = ? WHERE key = ?").bind(JSON.stringify(cleared), `cards.${id}`).run();
    }
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
export const THREAD_WINDOW_MS = KNOBS.threadWindowSec.default * 1000; // #C1113: the setting threadWindowSec; this is its default
const REF = /#([CT])(\d{1,7})\b/gi;
const refsOf = (...texts) => { const out = new Set(); for (const t of texts) for (const m of String(t ?? "").matchAll(REF)) out.add(`${m[1].toUpperCase()}${Number(m[2])}`); return out; };
const KEYS = ["A", "B", "C", "D"];

// The owner's open threads whose last owner message is within the window: { id, title, refs }.
async function openOwnerThreads(db, now) {
  const rows = (await db.prepare("SELECT thread_id, MAX(created_at) AS last FROM messages WHERE author = 'owner' AND created_at >= ? GROUP BY thread_id").bind(now - knobFrom(await knobsStored(db), "threadWindowSec") * 1000).all()).results;
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
  // #C1317: Manager's Terminal or Action ask may carry related_thread too (optional): the owner's thread id, or "none". The ask is still
  // one ask (its commands, Copy box and Done are answered as before); the thread it names is where the page draws it, so no second thread opens.
  if (who === "Manager" && (a.type === "Terminal" || a.type === "Action") && a.related_thread !== undefined) {
    const { related_thread: rel, ...ask } = a;
    if (typeof rel !== "string" || !rel.trim()) return refuse(db, now, { rule: "click-thread-shape", detail: "related_thread is the owner thread's id, or the literal \"none\"" }, ask.card_id, who);
    if (rel === "none") return createAsk(db, now, ask);
    const known = (await db.prepare("SELECT 1 AS x FROM asks WHERE id = ?").bind(rel).first()) || (await db.prepare("SELECT 1 AS x FROM cards WHERE id = ?").bind(rel).first()) || (await db.prepare("SELECT 1 AS x FROM threads WHERE id = ?").bind(rel).first());
    if (!known) return refuse(db, now, { rule: "click-thread-unknown", detail: rel }, ask.card_id, who);
    const r = await createAsk(db, now, ask);
    if (r.ok) await db.prepare("UPDATE asks SET body = json_set(body, '$.related_thread', ?) WHERE id = ?").bind(rel, r.id).run();
    return r.ok ? { ...r, thread_id: rel } : r;
  }
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
  // #C1254: a decision post on a card of a visual lane gets no Yes/No exemption, so the store tells the rule which card it is on.
  // #C1255 (Checker 2's LOW on c36d3415): a thread that is an ask's belongs to the ask's card, so the lane is read through it too.
  const lookCard = m.kind === "decision" && Array.isArray(m.options) ? ((await db.prepare("SELECT card_id FROM asks WHERE id = ?").bind(m.thread_id).first())?.card_id ?? m.thread_id) : null;
  const extra = messageExtrasRefusal(m, who, lookCard ? await lookContext(db, { card_id: lookCard }) : {});
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
  const ask = typeof id === "string" ? await db.prepare("SELECT id, type, asked_by, answered_at, closed_at, card_id, answer, answer_note, body FROM asks WHERE id = ?").bind(id).first() : null;
  // #C1046: the newest message on the ask's thread, for the rule that an agent closes only after the owner's word (not read for the owner).
  const last = ask && role !== "owner" ? await db.prepare("SELECT author FROM messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").bind(id).first() : null;
  const bad = closeRefusal(ask ? ask : null, who, role, last, now);
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
const ownerWordsPending = async (db) => {
  const m = await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE delivered_at IS NULL AND author = 'owner'").first();
  const a = await db.prepare("SELECT COUNT(*) AS n FROM asks WHERE answered_at IS NOT NULL AND answer_taken_at IS NULL").first();
  const p = await db.prepare("SELECT COUNT(*) AS n FROM stall_wakes WHERE taken_at IS NULL AND card_id LIKE ?").bind(`${PING_CARD}%`).first();
  return m.n + a.n + p.n;
};
const ownerWaiting = async (db) => (await ownerWordsPending(db)) > 0;
// #C1009: the owner's Ping on a thread is a wake of its own, not a comment: one row per (thread, minute) in stall_wakes under card_id
// "ping:<thread id>", which Manager's next read takes with the rest. A second press in the same minute renews the same row (untaken again).
// syncStalls leaves these rows alone (they are not a stall that can be over), and the view's threadPings gives the page "Pinged HH:MM".
export const PING_CARD = "ping:";
export async function pingThread(db, now, who, id) {
  const known = (await db.prepare("SELECT 1 AS x FROM asks WHERE id = ?").bind(id).first()) || (await db.prepare("SELECT 1 AS x FROM cards WHERE id = ?").bind(id).first()) || (await db.prepare("SELECT 1 AS x FROM threads WHERE id = ?").bind(id).first());
  if (!known) return refuse(db, now, { rule: "thread-unknown", detail: String(id).slice(0, 64) }, null, who);
  const reason = `The owner pinged thread ${id} at ${mtDayTime(now)}: his newest word there has not been answered`;
  await db.prepare("INSERT INTO stall_wakes (card_id, reason, created_at) VALUES (?, ?, ?) ON CONFLICT (card_id, reason) DO UPDATE SET created_at = excluded.created_at, taken_at = NULL").bind(`${PING_CARD}${id}`, reason, now).run();
  return { ok: true, id };
}
// #C732: the cards that wait 15 min at a phase while its agent is idle (stalledWaits, stallMsOf, shipSlowMsOf, board-rules.mjs), kept as one row per
// (card, reason): a new reason for a card is pending for Manager once, an older untaken reason of the card is replaced by it, and a stall
// that is over is no longer pending. A reason already sent is never sent again.
// #C990: the outages the step clocks skip: the recorded ones (the probe came back) and the one still open (the probe is silent now: from its last post to now).
export const OUTAGE_KEEP_MS = 7 * 24 * 3600e3;
// What counts as the probe being alive: its own evidence keys. A run's report (run.*) is not a heartbeat, and neither is a session's weekly-usage post
// (usage.week, written by the door tool while the probe may be silent: Checker 2's F1 on 896adf64).
const PROBE_KEYS_SQL = `key NOT LIKE 'run.%' AND key <> '${WEEK_USAGE_KEY}'`;
const isProbeKey = (key) => !key.startsWith("run.") && key !== WEEK_USAGE_KEY;
export async function outagesOf(db, now) {
  const rows = (await db.prepare("SELECT start_at, end_at FROM team_outages WHERE end_at >= ? ORDER BY start_at").bind(now - OUTAGE_KEEP_MS).all()).results ?? [];
  const out = rows.map((r) => ({ start: r.start_at, end: r.end_at }));
  const last = (await db.prepare(`SELECT MAX(read_at) AS at FROM evidence WHERE ${PROBE_KEYS_SQL}`).first())?.at;
  if (Number.isFinite(last) && now - last > await silentMsOf(db)) out.push({ start: last, end: now });
  return out;
}
async function syncStalls(db, now) {
  const cards = (await db.prepare("SELECT id, num, owner_role, blocked_reason, paused, dropped, done_at, waiting_on, repo, check_at, hold_end, held_at, hold_until, depends_on, updated_at, queue_pos, queue_set_by, moved_at, batch, rework_reason, next_note FROM cards").all()).results;
  const evRows = (await db.prepare("SELECT key, value, read_at FROM evidence WHERE key = 'agents' OR key LIKE 'cards.%'").all()).results;
  let agents = {}; const evidence = {}, readAt = {};
  for (const r of evRows) { let v; try { v = JSON.parse(r.value); } catch { continue; } if (r.key === "agents") agents = v; else { evidence[r.key.slice(6)] = v; readAt[r.key.slice(6)] = r.read_at; } }
  const openAskCards = new Set((await db.prepare("SELECT DISTINCT card_id FROM asks WHERE closed_at IS NULL AND outdated_at IS NULL AND card_id IS NOT NULL").all()).results.map((r) => r.card_id));
  const phaseStart = new Map((await db.prepare("SELECT card_id, phase, MAX(at) AS at FROM phase_history WHERE kind = 'start' AND wait IS NULL GROUP BY card_id, phase").all()).results.map((r) => [`${r.card_id}|${r.phase}`, r.at]));
  // holds-need-an-end (#C838): a held card whose end has passed, or that has had none for 2 h, wakes Manager once (one row per card and reason).
  // #C915 (b): a hold_end on any card (held or not) is read, so an open one silences the card's stall and a passed one does not.
  const refs = [...new Set(cards.filter((c) => c.hold_end).map((c) => c.hold_end))];
  const endsPassed = new Set();
  for (const ref of refs) {
    const ask = await db.prepare("SELECT closed_at, outdated_at FROM asks WHERE id = ?").bind(ref).first();
    if (ask) { if (ask.closed_at || ask.outdated_at) endsPassed.add(ref); continue; }
    const card = cards.find((c) => c.id === ref);
    if (card && (card.dropped || card.done_at || evidence[ref]?.lit?.[0] === "live")) endsPassed.add(ref);
  }
  // #C1104: a hold whose end has passed ends by itself (endedHolds, board-rules.mjs), before the lines below are built, so it never becomes a "lift or renew" line.
  // The words it held go to hold_history first, as #C1036's landing does. The update names the hold it read: a write that changed it since keeps its own.
  for (const h of endedHolds({ now, cards, endsPassed })) {
    const sets = ["waiting_on = NULL", "blocked_reason = NULL", "hold_end = NULL", "held_at = NULL", "hold_until = NULL", "updated_at = ?"];
    if (h.clearCheckAt) sets.push("check_at = NULL");
    const gone = await db.prepare(`UPDATE cards SET ${sets.join(", ")} WHERE id = ? AND done_at IS NULL AND dropped = 0 AND waiting_on IS ? AND blocked_reason IS ? AND hold_end IS ? AND check_at IS ? AND hold_until IS ?`).bind(now, h.id, h.waiting_on, h.blocked_reason, h.hold_end, h.check_at, h.hold_until).run();
    if (!(gone?.meta?.changes > 0)) continue;
    await db.prepare("INSERT INTO hold_history (card_id, at, waiting_on, blocked_reason, hold_end) VALUES (?, ?, ?, ?, ?)").bind(h.id, now, h.waiting_on, h.blocked_reason, h.hold_end).run();
    const c = cards.find((x) => x.id === h.id);
    if (c) Object.assign(c, { waiting_on: null, blocked_reason: null, hold_end: null, held_at: null, hold_until: null, ...(h.clearCheckAt ? { check_at: null } : {}) });
  }
  // #C904: an ask the owner has left 10 min wakes Manager once, before the owner's phone gets it at 30 (push-rules.mjs).
  const openAsks = (await db.prepare("SELECT id, num, type, eta_at, created_at, answered_at, closed_at, withdrawn_at, outdated_at, owed_by FROM asks WHERE closed_at IS NULL AND answered_at IS NULL AND withdrawn_at IS NULL AND outdated_at IS NULL").all()).results;
  // #C927: a repository whose oldest open card reading is over an hour old wakes Manager once per spell (staleCopies, board-rules.mjs). The row is
  // kept (taken or not) while the spell lasts, so a later sync never tells it again; it goes when the repository's readings are fresh again.
  const knobsNow = await knobsStored(db); // #C1106: the posted settings of the step clocks (a setting that is missing or out of bounds is its default)
  const postedFreshMs = postedFreshMsOf(knobsNow);
  const pushLim = pushLimits(knobsNow); // #C1106: the push rules settings (the nudge to Manager, the owner-word reminders, the prompt wait)
  const copies = staleCopies({ now, cards, evidence, readAt, staleMs: copyStaleMsOf(knobsNow) });
  const had = new Map((await db.prepare("SELECT card_id, reason FROM stall_wakes WHERE card_id LIKE ?").bind(`${COPY_CARD}%`).all()).results.map((r) => [r.card_id, r.reason]));
  for (const id of had.keys()) if (!copies.some((s) => s.card_id === id)) await db.prepare("DELETE FROM stall_wakes WHERE card_id = ?").bind(id).run();
  const copyStalls = copies.map((s) => ({ ...s, reason: had.get(s.card_id) ?? s.reason }));
  // #C885: a read-only role's own card is worked by posts on its thread; the newest post by the card's owner, per card.
  // #C931 (6), Security's note on #C885: only the last POSTED_FRESH_MS of messages is read, the only window the rule looks at, so the scan stays small; >= keeps the boundary the rule counts as fresh (#C943).
  const postedAt = new Map((await db.prepare("SELECT m.thread_id AS card_id, MAX(m.created_at) AS at FROM messages m JOIN cards c ON c.id = m.thread_id AND m.author = c.owner_role WHERE m.created_at >= ? GROUP BY m.thread_id").bind(now - postedFreshMs).all()).results.map((r) => [r.card_id, r.at]));
  // #C915 (d): the usual time of each work phase, from the finished rows of the history (newest 5000), for the "slow with no reason" line.
  const medians = phaseMedians((await db.prepare("SELECT id, card_id, phase, kind, at FROM phase_history WHERE wait IS NULL AND kind IN ('start', 'end') ORDER BY id DESC LIMIT 5000").all()).results);
  // A card already named by a "waits at" line this round is not named twice: that line is its one stall.
  const groupOrder = await orderList(db);
  await endClaims(db, now); // #C1094: a claim on a signed or landed tip is over before the dispatch reads who holds what
  // #C1084: the checker holding an open claim on a card's review, per card (a claim without a card id names no card).
  const claims = new Map((await db.prepare("SELECT card_id, checker FROM review_claims WHERE released_at IS NULL AND card_id IS NOT NULL ORDER BY claimed_at").all()).results.map((r) => [r.card_id, r.checker]));
  // #C1082: the stack switch, as the dispatch reads it, for the open-group rule behind the "next #C.." of the idle-agent line.
  // #C1295: per repository: the Set of the switch rows that are on ("board", "product"), as the dispatch builds it from the view.
  const stackOn = new Set((await db.prepare("SELECT repo FROM stack_switch WHERE stack = 1 AND repo IN ('board', 'product')").all()).results.map((r) => r.repo));
  // The dispatch holds a card only for an UNANSWERED open ask (an answered one left open does not), so the open-group rule is given that set (#C1082, Checker 2's F1).
  const unansweredAskCards = new Set((await db.prepare("SELECT DISTINCT card_id FROM asks WHERE closed_at IS NULL AND answered_at IS NULL AND outdated_at IS NULL AND card_id IS NOT NULL").all()).results.map((r) => r.card_id));
  // #C1073: a decision open on a thread holds its card as the dispatch does (collector/store-dispatch.mjs openDecisionCards), so the idle-agent line never counts or names it as queued.
  const decisionRows = (await db.prepare("SELECT id, thread_id, author, body, created_at, kind, resolved FROM messages WHERE thread_id IN (SELECT thread_id FROM messages WHERE kind = 'decision')").all()).results;
  const decisionHolds = openDecisionHolds(decisionRows, cards); // card id -> the open decision's message id: the held card is kept out of the idle count but named in its own row (Manager's second change)
  for (const id of decisionHolds.keys()) { openAskCards.add(id); unansweredAskCards.add(id); }
  const outages = await outagesOf(db, now);
  // #C1100: the config's collector.reviewers, which the probe posts (as `look`), so the line names the reviewer the dispatch wakes.
  const reviewers = (await evidenceOf(db, "reviewers"))?.reviewers;
  const waitsAll = stalledWaits({ now, cards, evidence, agents, openAskCards, phaseStart, postedAt, endsPassed, groupOrder, claims, stackOn, unansweredAskCards, outages, stallMs: stallMsOf(knobsNow), postedFreshMs, reviewers, decisionHolds });
  // #C1078: with the week's quota used up (the session's fresh reading), the idle-agent stall lines are held until the reset and one line goes to Manager.
  const weekRow = await db.prepare("SELECT value, read_at FROM evidence WHERE key = ?").bind(WEEK_USAGE_KEY).first();
  let weekValue = null; try { weekValue = weekRow ? JSON.parse(weekRow.value) : null; } catch { /* none */ }
  const quota = quotaHold({ now, week: sessionWeek({ evidence: { [WEEK_USAGE_KEY]: { value: weekValue, readAt: weekRow?.read_at } } }, now), stalls: waitsAll, outPct: quotaOutPctOf(knobsNow) });
  const waits = quota.stalls;
  // #C1120: when each card's newest rework reason was attached (a reason attached in the last hour is the slow line's reason).
  const reasonAt = new Map((await db.prepare("SELECT card_id, MAX(at) AS at FROM rework_history GROUP BY card_id").all()).results.map((r) => [r.card_id, r.at]));
  const slowAll = slowWakes({ now, cards, evidence, openAskCards, phaseStart, medians, endsPassed, outages, shipSlowMs: shipSlowMsOf(knobsNow), agents, reasonAt, stackOn });
  // A card the held stall line would have named is not named by the slow line in its place.
  const slow = slowAll.filter((s) => !waitsAll.some((w) => w.card_id === s.card_id));
  // The slow line's words are the same every spell, so its row (card, reason) must not outlive the spell: once a card is no longer slow with no
  // reason (a reason given, a hold, the card moved on), its row goes, taken or not, and a later spell wakes Manager again (Checker F1; as copyStalls).
  const slowRows = (await db.prepare("SELECT card_id, reason FROM stall_wakes WHERE reason LIKE ?").bind(`%${SLOW_ROW_END}`).all()).results;
  for (const r of slowRows) if (!slowAll.some((s) => s.card_id === r.card_id && s.reason === r.reason)) await db.prepare("DELETE FROM stall_wakes WHERE card_id = ? AND reason = ?").bind(r.card_id, r.reason).run();
  // #C1122: a role's Remote Control line is the same words every spell, so its row goes when the switch is on again (or the role is gone), taken or not, and a later spell wakes Manager again.
  // #C1135: a role counts by its exact name in the config's roster, which the probe posts as the `roster` evidence (no posting yet: the old list-plus-digits rule).
  const roster = (await evidenceOf(db, "roster"))?.roster;
  const rcOffNow = rcOffWakes(agents, roster);
  for (const r of (await db.prepare("SELECT card_id, reason FROM stall_wakes WHERE card_id LIKE ?").bind(`${RC_OFF_CARD}%`).all()).results) if (!rcOffNow.some((s) => s.card_id === r.card_id && s.reason === r.reason)) await db.prepare("DELETE FROM stall_wakes WHERE card_id = ? AND reason = ?").bind(r.card_id, r.reason).run();
  // #C1103: a card worked while a higher group has a card for the same role: one line to Manager per spell (its row goes when the spell is over, as the slow line's).
  // #C1118: the cards the owner role has worked itself, apart from a push (which the evidence shows): a step it logged (phase_history from the tool) or an ask it posted.
  const ownerOf = new Map(cards.filter((c) => c && typeof c.id === "string").map((c) => [c.id, c.owner_role]));
  const ownWork = new Set();
  for (const r of (await db.prepare("SELECT DISTINCT card_id, who FROM phase_history WHERE source = 'tool'").all()).results) if (ownerOf.get(r.card_id) === r.who) ownWork.add(r.card_id);
  for (const r of (await db.prepare("SELECT DISTINCT card_id, asked_by FROM asks WHERE card_id IS NOT NULL").all()).results) if (ownerOf.get(r.card_id) === r.asked_by) ownWork.add(r.card_id);
  const order = outOfOrderWork({ cards, evidence, agents, groupOrder, ownWork });
  const orderRows = (await db.prepare("SELECT card_id, reason FROM stall_wakes WHERE reason LIKE ?").bind(`%${ORDER_ROW_END}`).all()).results;
  for (const r of orderRows) if (!order.some((s) => s.card_id === r.card_id && s.reason === r.reason)) await db.prepare("DELETE FROM stall_wakes WHERE card_id = ? AND reason = ?").bind(r.card_id, r.reason).run();
  // #C1115: a review 30 minutes past its ETA (claimed time + the checker median + the reviewer's mutants at their measured time) wakes Manager with the reviewer's progress
  // line, once per spell; its row goes when the review is no longer late (signed, released, the card moved on), so a later spell wakes again.
  const claimsOpen = (await db.prepare("SELECT sha, card_id, checker, claimed_at, released_at, mutants, mutant_sec, progress, progress_at FROM review_claims WHERE released_at IS NULL").all()).results;
  const reviewLate = reviewLateWakes({ now, claims: claimsOpen, cards, evidence, medians, outages });
  const lateRows = (await db.prepare("SELECT card_id, reason FROM stall_wakes WHERE reason LIKE ?").bind(`%${REVIEW_LATE_MARK}%`).all()).results;
  for (const r of lateRows) if (!reviewLate.some((s) => s.card_id === r.card_id && s.reason === r.reason)) await db.prepare("DELETE FROM stall_wakes WHERE card_id = ? AND reason = ?").bind(r.card_id, r.reason).run();
  // #C987: an answered Decision whose card moved on: one line to Manager, then the store closes it at its time (movedOnAsks, board-rules.mjs).
  const answered = (await db.prepare("SELECT id, num, type, card_id, answered_at, answer_taken_at, answer_status, closed_at, withdrawn_at, auto_closed_at FROM asks WHERE type = 'Decision' AND answered_at IS NOT NULL AND closed_at IS NULL AND withdrawn_at IS NULL AND auto_closed_at IS NULL").all()).results;
  // Each such ask's newest thread message (one bound query per ask; a handful at most).
  const lastWord = new Map();
  for (const a of answered) {
    const m = await db.prepare("SELECT author, created_at FROM messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").bind(a.id).first();
    if (m) lastWord.set(a.id, { author: m.author, at: m.created_at });
  }
  const movedOn = movedOnAsks({ now, asks: answered, cards, lastWord, closeMs: autoCloseMsOf(knobsNow) });
  for (const m of movedOn.filter((x) => x.due)) await db.prepare("UPDATE asks SET closed_at = ?, closed_by = ?, auto_closed_at = ? WHERE id = ? AND closed_at IS NULL").bind(now, AUTO_CLOSED_BY, now, m.ask_id).run();
  const closing = movedOn.filter((x) => !x.due).map(({ card_id, num, reason }) => ({ card_id, num, reason }));
  // #C1005 (b): a role stopped on a prompt for 30+ min (the probe's fresh "stuck" reading, kind user), by day: one line per stop (prompt-watch's rule).
  const stuckRow = await db.prepare("SELECT value, read_at FROM evidence WHERE key = 'stuck'").first();
  let stuckNow = null; try { stuckNow = stuckRow && now - stuckRow.read_at <= 15 * 60e3 ? JSON.parse(stuckRow.value) : null; } catch { /* none */ }
  // #C1005 (c): the probe's `watch` reading (an app restart, new permission prompts, a silent ledger), fresh only; one row each, told once.
  const watchRow = await db.prepare("SELECT value, read_at FROM evidence WHERE key = 'watch'").first();
  let watchNow = null; try { watchNow = watchRow && now - watchRow.read_at <= 15 * 60e3 ? JSON.parse(watchRow.value) : null; } catch { /* none */ }
  // #C1076: a board card landed 30+ min ago that no deploy pair holds: a line to Manager, whatever its owner is doing (landedUnbuilt, board-rules.mjs).
  const installStart = new Map((await db.prepare("SELECT card_id, MAX(at) AS at FROM phase_history WHERE kind = 'start' AND wait = ? GROUP BY card_id").bind(INSTALL_WAIT).all()).results.map((r) => [r.card_id, r.at]));
  const landed = landedUnbuilt({ now, cards, evidence, installStart, unbuiltMs: landedUnbuiltMsOf(knobsNow) });
  // #C1162: a paused card whose every depends_on card has landed: one line to Manager per spell; its row goes when the line is no longer current, so a later spell tells again (never unpaused by itself).
  const pausedDep = pausedDepLanded({ now, cards, evidence, endsPassed });
  for (const r of (await db.prepare("SELECT card_id, reason FROM stall_wakes WHERE reason LIKE ?").bind(`%${PAUSE_DEP_END}`).all()).results) if (!pausedDep.some((s) => s.card_id === r.card_id && s.reason === r.reason)) await db.prepare("DELETE FROM stall_wakes WHERE card_id = ? AND reason = ?").bind(r.card_id, r.reason).run();
  // #C1081: threads whose newest message is the owner's (the last OWNER_WORD_DAYS days only), joined to what says whether the thread is still open.
  const ownerLast = (await db.prepare("SELECT m.thread_id AS thread_id, m.created_at AS at, m.resolved AS resolved, m.body AS body, (SELECT p.body FROM messages p WHERE p.thread_id = m.thread_id AND p.author <> 'owner' AND p.created_at < m.created_at ORDER BY p.created_at DESC, p.id DESC LIMIT 1) AS prev_team_body, (m.screenshots IS NOT NULL OR EXISTS (SELECT 1 FROM file_links l WHERE l.ref_kind = 'message' AND l.ref_id = m.id)) AS has_files,a.num AS ask_num, a.closed_at AS ask_closed_at, a.withdrawn_at AS ask_withdrawn_at, a.outdated_at AS ask_outdated_at, c.num AS card_num, c.dropped AS card_dropped, c.done_at AS card_done_at, t.num AS thread_num FROM messages m LEFT JOIN asks a ON a.id = m.thread_id LEFT JOIN cards c ON c.id = m.thread_id LEFT JOIN threads t ON t.id = m.thread_id WHERE m.author = 'owner' AND m.created_at >= ? AND NOT EXISTS (SELECT 1 FROM messages n WHERE n.thread_id = m.thread_id AND (n.created_at > m.created_at OR (n.created_at = m.created_at AND n.id > m.id)))").bind(now - pushLim.wordDays * 864e5).all()).results;
  const stalls = [...waits, ...quota.line, ...landed, ...pausedDep, ...ownerWordWakes({ rows: ownerLast, now, lim: pushLim }),...heldWakes({ now, cards, endsPassed, holdMs: holdNoEndMsOf(knobsNow) }), ...slow, ...order, ...reviewLate,...await syncE2e(db, now), ...await syncTruth(db, now),...askWakes({ asks: openAsks, now, lim: pushLim }), ...promiseWakes({ asks: openAsks, now }), ...promptWakes({ stuck: stuckNow, now, lim: pushLim }), ...watchWakes({ watch: watchNow }), ...rcOffNow, ...copyStalls, ...closing];
  for (const s of stalls) await db.prepare("INSERT OR IGNORE INTO stall_wakes (card_id, reason, created_at) VALUES (?, ?, ?)").bind(s.card_id, s.reason, now).run();
  // #C1097: the idle-agent stalls that are current (after the quota hold) are kept as taken rows the dispatch reads through the view (agentStallRow, board-rules.mjs);
  // a row whose stall is over goes, so a later spell starts its 30 minutes again.
  const agentNow = waits.map(agentStallRow).filter(Boolean);
  for (const r of agentNow) await db.prepare("INSERT OR IGNORE INTO stall_wakes (card_id, reason, created_at, taken_at) VALUES (?, ?, ?, ?)").bind(r.card_id, r.reason, now, now).run();
  const agentKeep = new Set(agentNow.map((r) => `${r.card_id}|${r.reason}`));
  for (const r of (await db.prepare("SELECT card_id, reason FROM stall_wakes WHERE card_id LIKE ?").bind(`${AGENT_STALL}%`).all()).results) {
    if (!agentKeep.has(`${r.card_id}|${r.reason}`)) await db.prepare("DELETE FROM stall_wakes WHERE card_id = ? AND reason = ?").bind(r.card_id, r.reason).run();
  }
  // Whatever is untaken and no longer current (the stall is over, or its reason changed) is no longer pending: a card's older reason is
  // replaced by its new one here, so Manager never reads both.
  const current = new Set(stalls.map((s) => `${s.card_id}|${s.reason}`));
  // #C1005 (Checker 2's F2): at night the prompt rows are held back, not over: an untaken one stays while the role is still stopped, so the first
  // run after 7 am finds it and Manager is told once (a row retired at 10 pm would be ignored by the 7 am insert).
  for (const s of promptWakes({ stuck: stuckNow, now, byNight: true, lim: pushLim })) current.add(`${s.card_id}|${s.reason}`);
  const pending = (await db.prepare("SELECT card_id, reason FROM stall_wakes WHERE taken_at IS NULL").all()).results;
  // #C1005 (Checker 2's F1): a watch line is an event (the app restarted, prompts came in), not a state that can be over, so it stays until Manager
  // takes it, as a ping does: a later reading (the ledger a minute after a restart) must not retire an earlier one unread.
  for (const p of pending) if (!p.card_id.startsWith(PING_CARD) && !p.card_id.startsWith(WATCH_WAKE_PREFIX) && !current.has(`${p.card_id}|${p.reason}`)) await db.prepare("UPDATE stall_wakes SET taken_at = ? WHERE card_id = ? AND reason = ?").bind(now, p.card_id, p.reason).run();
}
// #C873: the product's daily full test run (evidence e2e). Manager's batch gets ONE line when it turns red, missed or unknown from something else:
// the row stays (taken or not) while the state holds, so a later probe run never tells it again; it goes when the state changes or turns ok.
// A reading gone stale or absent leaves the row alone (nothing current, so an untaken line is dropped as over, as any stall).
async function syncE2e(db, now) {
  const row = await db.prepare("SELECT value, read_at FROM evidence WHERE key = 'e2e'").first();
  let value = null; try { value = row ? JSON.parse(row.value) : null; } catch { /* none */ }
  const staleMs = staleMsOf(await knobsStored(db));
  const fresh = row && now - row.read_at <= staleMs;
  if (fresh && value?.state === "ok") { await db.prepare("DELETE FROM stall_wakes WHERE card_id = ?").bind(E2E_CARD).run(); return []; }
  const wake = e2eWake({ now, value, readAt: row?.read_at ?? 0, staleMs });
  if (!wake) return [];
  await db.prepare("DELETE FROM stall_wakes WHERE card_id = ? AND reason NOT LIKE ?").bind(E2E_CARD, `${e2eWakeLine(wake.state)}%`).run();
  const had = await db.prepare("SELECT reason FROM stall_wakes WHERE card_id = ?").bind(E2E_CARD).first();
  return [{ card_id: E2E_CARD, num: null, reason: had?.reason ?? wake.reason }];
}
// #C1386: the truth check (evidence truth). ONE row per spell of disagreement: written when the fresh reading has count > 0, kept (taken or not) while it
// holds, so a later run, even with another count or sample, never tells it again; deleted when the count is 0 or the reading is stale or absent, so a
// later spell wakes Manager again.
async function syncTruth(db, now) {
  const row = await db.prepare("SELECT value, read_at FROM evidence WHERE key = 'truth'").first();
  let value = null; try { value = row ? JSON.parse(row.value) : null; } catch { /* none */ }
  const fresh = row && now - row.read_at <= staleMsOf(await knobsStored(db));
  const wake = fresh ? truthWake(value) : null;
  if (!wake) { await db.prepare("DELETE FROM stall_wakes WHERE card_id = ?").bind(TRUTH_CARD).run(); return []; }
  const had = await db.prepare("SELECT reason FROM stall_wakes WHERE card_id = ?").bind(TRUTH_CARD).first();
  return [{ card_id: TRUTH_CARD, num: null, reason: had?.reason ?? wake.reason }];
}
// #C1112: the shipped branches the probe lists (evidence branches.shipped) become ONE Terminal ask a week, asked as the lead (who used to batch them by hand), with
// the delete lines. Nothing is asked while a sweep ask is still open or one was made in the last 7 days, or when the list is over 2 days old or empty.
const SWEEP_EVERY_MS = 7 * 86_400_000, SWEEP_FRESH_MS = 2 * 86_400_000;
export async function syncBranchSweep(db, now) {
  const row = await db.prepare("SELECT value, read_at FROM evidence WHERE key = 'branches.shipped'").first();
  if (!row || !(now - row.read_at <= SWEEP_FRESH_MS)) return null;
  let value = null; try { value = JSON.parse(row.value); } catch { /* none */ }
  const ask = sweepAsk(value);
  if (!ask) return null;
  const had = await db.prepare("SELECT 1 AS x FROM asks WHERE type = 'Terminal' AND title LIKE ? AND ((closed_at IS NULL AND outdated_at IS NULL) OR created_at > ?) LIMIT 1").bind(`${SWEEP_TITLE}%`, now - SWEEP_EVERY_MS).first();
  if (had) return null;
  return createAsk(db, now, { type: "Terminal", title: ask.title, asked_by: "Manager", commands: ask.commands });
}
const wakeFacts = (w, askedAt) => ({ askedAt, batchId: w.batch_id, count: w.batch_count, batchAt: w.batch_at, takenAt: w.taken_at, lastSendAt: w.last_send_at ?? undefined, lastSendBatch: w.last_send_batch, lastSendOk: w.last_send_ok === null ? undefined : w.last_send_ok === 1, lastSendReason: w.last_send_reason ?? undefined, lastSendFix: w.last_send_fix ?? undefined });

// The probe's 20-second ask: the heartbeat, and the answer to "anything for Manager?". Opens a batch when something is
// pending and none is open; says whether to send now (once per batch, again at most every 5 minutes) and with which line.
// #C1213 (inbox-delivers-new-threads; 11-18 from 16:01Z the probe's ask timed out at its 8 s on every run, so the owner's new threads #T2053 and #T2055 never
// opened a batch and Manager was never woken for them): the owner's own words (messages, answers, pings) open the batch BEFORE the stall sync, which is the slow
// part and the part that can throw; a sync that throws is only a missed stall line, never a missed owner word. With `after` (the Worker's waitUntil) the sync
// runs after the answer is built, so a slow sync no longer holds the answer back: its lines join the batch from the next ask (20 s later) on.
// #C1214 (Checker 2's L2 on #C1213): the count before the sync is the owner's words only. A stall row that is over is retired by the sync, so counting it here
// could open a batch for a line that never reaches Manager (a wake to an empty inbox); the count after the sync is the whole of it, as before.
async function openBatch(db, now, ownerOnly = false) {
  const w = await db.prepare("SELECT * FROM wake WHERE id = 1").first();
  const n = ownerOnly ? await ownerWordsPending(db) : await pendingForManager(db);
  const open = w.batch_id && w.taken_at < w.batch_at;
  if (n > 0 && !open) {
    await db.prepare("UPDATE wake SET batch_id = ?, batch_count = ?, batch_at = ? WHERE id = 1").bind(`b-${now}`, n, now).run();
  } else if (n > 0 && !ownerOnly) await db.prepare("UPDATE wake SET batch_count = ? WHERE id = 1").bind(n).run();
  return n;
}
// #C1214: the sync's own time (when it took 1 s or more) and any failure go to the Worker's log (wrangler tail), one line per run, so the slow ask of 11-18 16:01Z can be read there next time:
// {"wakeSync":{"ms":..,"stalls":"ok"|"<message>","sweep":"ok"|"<message>"}}. Nothing is stored; no reader of the board's data sees it.
async function syncAll(db, now) {
  const t0 = Date.now(), out = { stalls: "ok", sweep: "ok" };
  try { await syncStalls(db, now); } catch (e) { out.stalls = String(e?.message ?? e).slice(0, 200); /* a stall line is never worth the owner's word */ }
  const t1 = Date.now();
  try { await syncBranchSweep(db, now); } catch (e) { out.sweep = String(e?.message ?? e).slice(0, 200); /* a sweep ask is never worth the wake */ }
  const ms = Date.now() - t0;
  if (ms >= 1000 || out.stalls !== "ok" || out.sweep !== "ok") { try { console.log(JSON.stringify({ wakeSync: { ms, stallsMs: t1 - t0, ...out } })); } catch { /* a log line is never worth the ask */ } }
}
export async function wakeAsk(db, now, after = null) {
  await db.prepare("UPDATE wake SET alive_at = ? WHERE id = 1").bind(now).run();
  const owner = await openBatch(db, now, true);
  // #C1214 (Checker 2's F1): the sync is handed to `after` only when the owner's words already hold the batch open; with none pending nothing is urgent, so the
  // sync runs first and the count below is of rows it has retired (a stall line that is over can no longer open a batch on the Worker's route either).
  if (typeof after === "function" && owner > 0) after(syncAll(db, now));
  else { await syncAll(db, now); }
  const n = await openBatch(db, now);
  let w = await db.prepare("SELECT * FROM wake WHERE id = 1").first();
  const facts = { ...wakeFacts(w, now), ownerWaiting: n > 0 && await ownerWaiting(db) };
  const lim = wakeLimits(await knobsStored(db)); // #C1106: the posted wake settings (a missing or out-of-bounds one is its default)
  const status = wakeStatus(facts, now, lim);
  const tellOwner = shouldTellOwner(status, w.told_reason);
  if (tellOwner) await db.prepare("UPDATE wake SET told_reason = ? WHERE id = 1").bind(status.reason).run();
  return { send: n > 0 && shouldSend(facts, now, lim), line: n > 0 ? nudgeLine(w.batch_count, w.batch_id) : null, batchId: n > 0 ? w.batch_id : null, count: n, status, tellOwner };
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
// #C1018 / #C1035: one checker per tip. claimReview: the first claim of a tip wins (one statement: an insert that only takes over a RELEASED row), and any other
// checker is told "<checker> has this" (a refusal, logged). The same checker claiming again is fine. A tip that already carries a Checker note (the probe's
// reading: signed or findings by the checker lane) is refused too: the review is done. A re-cut keeps the claim: with card_id, the checker who holds
// another tip of the card holds the new one, and anyone else is refused. Manager claims a tip for a named checker up front.
const MAX_OPEN_CLAIMS = 6;
const hasCheckerNote = (v) => [...(Array.isArray(v?.signed) ? v.signed : []), ...(Array.isArray(v?.findings) ? v.findings : [])].some((x) => /checker/i.test(String(x)));
// #C1094 (11-16: Checker 2 hit the cap of 6 and Manager released 5 by hand, each on a tip already signed, re-cut or landed): a claim ends by itself when (1) the probe's reading
// of the card's head is this tip and it carries a Checker note (signed or findings), (2) that reading has the tip on main, or its card is done or dropped, or (3) the claimer's
// own card has a newer head than the claim's tip, read after the claim was made (the old tip was handed on or is dead). (1) and (2) are free for anyone; (3) is only for the
// claims of `checker` (the one claiming now), so another checker's hold on a re-cut tip stays what the re-cut rule in claimReview says. Called after each card reading, at each
// stall sync and at each claim.
export async function endClaims(db, now, { checker = null } = {}) {
  const open = (await db.prepare("SELECT rc.sha AS sha, rc.card_id AS card_id, rc.checker AS checker, rc.claimed_at AS claimed_at, c.done_at AS done_at, c.dropped AS dropped FROM review_claims rc LEFT JOIN cards c ON c.id = rc.card_id WHERE rc.released_at IS NULL").all()).results ?? [];
  if (open.length === 0) return 0;
  const byHead = new Map(), byCard = new Map();
  for (const e of (await db.prepare("SELECT key, value, read_at FROM evidence WHERE key LIKE 'cards.%'").all()).results ?? []) {
    let v; try { v = JSON.parse(e.value); } catch { continue; }
    if (!v || typeof v !== "object") continue;
    byCard.set(String(e.key).slice(6), { v, readAt: e.read_at });
    if (typeof v.headSha12 === "string") byHead.set(v.headSha12, v);
  }
  let ended = 0;
  for (const r of open) {
    const tip = r.sha.slice(0, 12), v = byHead.get(tip), cur = r.card_id ? byCard.get(r.card_id) : null;
    let why = null;
    if (r.done_at != null || r.dropped === 1) why = "landed";
    else if (v && hasCheckerNote(v)) why = "signed";
    else if (v && v.onMain === true) why = "landed";
    else if (!v && checker !== null && r.checker === checker && cur && typeof cur.v.headSha12 === "string" && cur.v.headSha12 !== tip && cur.readAt > r.claimed_at) why = `superseded by ${cur.v.headSha12}`;
    if (!why) continue;
    await db.prepare("UPDATE review_claims SET released_at = ?, released_by = ? WHERE sha = ? AND released_at IS NULL").bind(now, why, r.sha).run();
    ended++;
  }
  return ended;
}
export async function claimReview(db, now, who, b) {
  const bad = reviewClaimRefusal(b, who, "claim");
  if (bad) return refuse(db, now, bad, null, who);
  const checker = b.checker ?? "Checker";
  // The card comes from the probe's evidence (the card whose head is this commit), not from the caller: a checker that passes no card_id, or the wrong
  // one, is still held to the re-cut rule below (Checker's F2). The caller's card_id is only the fallback for a tip the probe has not read yet.
  let card = b.card_id ?? null;
  // The tip already reviewed by Checker: the probe's evidence for a card whose head is this commit.
  const evs = (await db.prepare("SELECT key, value FROM evidence WHERE key LIKE 'cards.%'").all()).results ?? [];
  for (const e of evs) {
    let v; try { v = JSON.parse(e.value); } catch { continue; }
    if (v?.headSha12 !== b.sha.slice(0, 12)) continue;
    card = String(e.key).slice("cards.".length);
    if (hasCheckerNote(v)) return refuse(db, now, { rule: "review-claim-noted", detail: `${b.sha.slice(0, 12)} already has a Checker note` }, card, who);
  }
  // A re-cut keeps the claim: another tip of this card is held by an active claim of someone else.
  if (card) {
    const other = await db.prepare("SELECT sha, checker FROM review_claims WHERE card_id = ? AND released_at IS NULL AND sha <> ? AND checker <> ?").bind(card, b.sha, checker).first();
    if (other) return refuse(db, now, { rule: "review-claim-held", detail: `${other.checker} has this` }, card, who);
  }
  // #C1040: a claim on a card that is done (its tip landed) or dropped is stale: free it; #C1094: so is one on a tip that is signed, landed or handed on to a newer tip of
  // the claimer's own card (endClaims). Then cap what one checker holds at once.
  await endClaims(db, now, { checker });
  const held = await db.prepare("SELECT COUNT(*) AS n FROM review_claims WHERE checker = ? AND released_at IS NULL AND sha <> ?").bind(checker, b.sha).first();
  if (held.n >= MAX_OPEN_CLAIMS) return refuse(db, now, { rule: "review-claim-cap", detail: `${checker} already holds ${held.n} open claims (the most is ${MAX_OPEN_CLAIMS}): release one first` }, card, who);
  await db.prepare("INSERT INTO review_claims (sha, card_id, checker, claimed_by, claimed_at, released_at, released_by) VALUES (?, ?, ?, ?, ?, NULL, NULL) ON CONFLICT(sha) DO UPDATE SET card_id = excluded.card_id, checker = excluded.checker, claimed_by = excluded.claimed_by, claimed_at = excluded.claimed_at, released_at = NULL, released_by = NULL WHERE review_claims.released_at IS NOT NULL").bind(b.sha, card, checker, who, now).run();
  const row = await db.prepare("SELECT checker FROM review_claims WHERE sha = ?").bind(b.sha).first();
  if (row.checker !== checker) return refuse(db, now, { rule: "review-claim-held", detail: `${row.checker} has this` }, card, who);
  // #C1115: the mutant count, the seconds each takes and a progress line go on the holder's claim; a claim repeated with only some of them keeps the others.
  if (b.mutants !== undefined || b.mutant_sec !== undefined || b.progress !== undefined) {
    await db.prepare("UPDATE review_claims SET mutants = COALESCE(?, mutants), mutant_sec = COALESCE(?, mutant_sec), progress = COALESCE(?, progress), progress_at = CASE WHEN ? IS NULL THEN progress_at ELSE ? END WHERE sha = ?").bind(b.mutants ?? null, b.mutant_sec ?? null, b.progress ?? null, b.progress ?? null, now, b.sha).run();
  }
  // The old tips of the card this checker held are handed on to the new one.
  if (card) await db.prepare("UPDATE review_claims SET released_at = ?, released_by = ? WHERE card_id = ? AND sha <> ? AND checker = ? AND released_at IS NULL").bind(now, `moved to ${b.sha.slice(0, 12)}`, card, b.sha, checker).run();
  return { ok: true, sha: b.sha, checker };
}
// Released by its holder (a Checker session, when its own name matches the claim's) or by Manager (the checker is gone). Nothing else changes.
export async function releaseReview(db, now, who, b) {
  const bad = reviewClaimRefusal(b, who, "release");
  if (bad) return refuse(db, now, bad, null, who);
  const row = await db.prepare("SELECT checker, released_at FROM review_claims WHERE sha = ?").bind(b.sha).first();
  if (!row || row.released_at != null) return { ok: true, sha: b.sha, released: false };
  // Both Checker sessions authenticate as the role Checker, so the holder is the name the caller gives (the same trust as a claim): it must be the claim's.
  if (who === "Checker" && (b.checker ?? "Checker") !== row.checker) return refuse(db, now, { rule: "review-claim-held", detail: `${row.checker} has this; only that checker or Manager releases it` }, null, who);
  await db.prepare("UPDATE review_claims SET released_at = ?, released_by = ? WHERE sha = ?").bind(now, who, b.sha).run();
  return { ok: true, sha: b.sha, released: true };
}
// #C871: the owner moves a card that has not started up or down in its agent's queue. The queue is the agent's cards not dropped and with no
// commit pushed (the probe's reading), in queue_pos order (a card with none after those with one), then by number. The queue is renumbered
// 1..n, and the two cards swapped carry the owner's stamp, so an agent cannot move them back (queueWriteRefusal).
// An agent's queue, in order (queueRank): its cards not dropped and with nothing pushed (the probe's reading), each { id, num, queue_pos, owner
// (the owner placed it), held (a depends_on that is not live) }. The same list serves the move, and the floor an agent's write may not pass.
export async function queueCards(db, role) {
  const all = (await db.prepare("SELECT id, num, owner_role, queue_pos, queue_set_by, depends_on, dropped, done_at, batch, rework_reason FROM cards").all()).results ?? [];
  // #C1053: the order is the dispatch's (agentRank): started group, the owner's group order, then queue_pos; so a move never fights what the agent is woken for.
  const order = await orderList(db);
  const seen = new Map();
  for (const c of all) if (groupOf(c)) seen.set(c.id, await evidenceOf(db, `cards.${c.id}`));
  const started = startedGroupSet(all.map((c) => ({ ...c, batch: groupOf(c) })), (id) => seen.get(id));
  const evidence = {};
  for (const c of all) if (c.depends_on) for (const d of (() => { try { const l = JSON.parse(c.depends_on); return Array.isArray(l) ? l : []; } catch { return []; } })()) if (typeof d === "string" && !(d in evidence)) evidence[d] = await evidenceOf(db, `cards.${d}`);
  const queue = [];
  for (const r of all.filter((c) => c.owner_role === role && !c.dropped && !c.done_at)) {
    const e = await evidenceOf(db, `cards.${r.id}`);
    if (e?.headSha12 || e?.phase === "live") continue;
    queue.push({ id: r.id, num: r.num, queue_pos: r.queue_pos, owner: r.queue_set_by === "owner", held: dependsNotLive(r, all, evidence), group: groupOf(r), groupStarted: started.has(groupOf(r)), rework: isRework(r, e) });
  }
  return queue.sort((a, b) => agentRank(a, b, order));
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
  // #C1053: nor does a card cross into another group: the groups are worked whole, in the owner's order, so a swap there would change nothing the agent sees.
  if (to < 0 || to >= queue.length || queue[to].held !== queue[at].held || queue[to].group !== queue[at].group) return { ok: true, id: b.id, moved: false, order: queue.map((r) => r.id) };
  [queue[at], queue[to]] = [queue[to], queue[at]];
  const swapped = new Set([queue[at].id, queue[to].id]);
  for (let n = 0; n < queue.length; n++) {
    const r = queue[n];
    if (swapped.has(r.id)) await db.prepare("UPDATE cards SET queue_pos = ?, queue_set_by = ?, queue_set_at = ?, updated_at = ? WHERE id = ?").bind(n + 1, who, now, now, r.id).run();
    else if (r.queue_pos !== n + 1) await db.prepare("UPDATE cards SET queue_pos = ?, updated_at = ? WHERE id = ?").bind(n + 1, now, r.id).run();
  }
  return { ok: true, id: b.id, moved: true, order: queue.map((r) => r.id) };
}
// #C1008: the owner pulls an urgent card out of its group. The card leaves its batch and keeps where it came from, who and when.
// A card in no group, done or dropped has nothing to pull out of: refused, and logged like every refusal.
export async function pullOutOfGroup(db, now, who, b) {
  const bad = pullOutRefusal(b, who);
  if (bad) return refuse(db, now, bad, b?.id, who);
  const card = await db.prepare("SELECT id, batch, dropped, done_at FROM cards WHERE id = ?").bind(b.id).first();
  if (!card || card.dropped || card.done_at) return refuse(db, now, { rule: "card-unknown", detail: String(b.id) }, b.id, who);
  if (!card.batch) return refuse(db, now, { rule: "pull-out-no-group", detail: `${b.id} is in no group` }, b.id, who);
  // #C1299: the card becomes a single card in the one order list, just above the group it left.
  const slots = await openSlots(db);
  await db.prepare("UPDATE cards SET batch = NULL, pulled_from = ?, pulled_by = ?, pulled_at = ?, updated_at = ? WHERE id = ?").bind(card.batch, who, now, now, b.id).run();
  const at = slots.indexOf(card.batch);
  slots.splice(at < 0 ? slots.length : at, 0, slotKeyOf(b.id));
  // A group whose only open card this was has no card now: it disappears from the list.
  const left = await db.prepare("SELECT 1 AS x FROM cards WHERE batch = ? AND COALESCE(dropped, 0) = 0 AND done_at IS NULL LIMIT 1").bind(card.batch).first();
  await writeOrder(db, now, who, left ? slots : slots.filter((k) => k !== card.batch));
  return { ok: true, id: b.id, from: card.batch };
}
// #C1299: the order list rows. A row is a group's batch id or a single card's "c:<card id>"; writeOrder renumbers the given keys 1..n and drops every other row.
async function writeOrder(db, now, who, keys) {
  await db.batch([db.prepare("DELETE FROM group_order"), ...keys.map((g, n) => db.prepare("INSERT INTO group_order (batch, pos, set_by, set_at) VALUES (?, ?, ?, ?)").bind(g, n + 1, who, now))]);
}
// #C1372: the order list the rules read (groupRank): the owner's placed rows { batch, pos }, and for each group nobody placed its { batch, num }, so a new group ranks after
// an older one by its number. Nothing is written for a group nobody placed.
async function orderList(db) {
  const placed = (await db.prepare("SELECT batch, pos FROM group_order").all()).results ?? [];
  const names = (await db.prepare("SELECT batch, num FROM groups").all()).results ?? [];
  return orderListOf(placed, names);
}
// A group's number and name, minted the first time the store sees the group (a card written into it, or a rename). Returns { num, name }.
export async function ensureGroup(db, now, who, batch) {
  if (typeof batch !== "string" || !batch.trim()) return null;
  const have = await db.prepare("SELECT num, name FROM groups WHERE batch = ?").bind(batch).first();
  if (have) return have;
  // One statement picks the number (the highest plus one) and writes the row. The UNIQUE on num keeps a number from repeating: a writer that loses the race on it has its
  // INSERT OR IGNORE skipped (no error, no row), and the read below then finds nothing. Checker 2 and Security on 5855d06c: it tries again, with the new highest number,
  // a few times; a row some other writer made for this batch is the answer too. Only if all four miss does it answer { num: null }, which no caller treats as an error.
  for (let n = 0; n < 4; n++) {
    await db.prepare("INSERT OR IGNORE INTO groups (batch, num, name, created_by, created_at) SELECT ?, COALESCE(MAX(num), 0) + 1, NULL, ?, ? FROM groups").bind(batch, who ?? "store", now).run();
    const g = await db.prepare("SELECT num, name FROM groups WHERE batch = ?").bind(batch).first();
    if (g) return g;
  }
  return { num: null, name: null };
}
// A card put in a group by any write: the group has its number, and a place of its own as a single card is gone (it is in the group's place now).
const joinedGroup = async (db, now, who, id, batch) => {
  await ensureGroup(db, now, who, batch);
  await db.prepare("DELETE FROM group_order WHERE batch = ?").bind(slotKeyOf(id)).run();
};
// #C1299: the owner renames a group. The batch id stays (every card carries it); the name is for the page.
export async function renameGroup(db, now, who, b) {
  const bad = groupRenameRefusal(b, who);
  if (bad) return refuse(db, now, bad, null, who);
  const open = await db.prepare("SELECT 1 AS x FROM cards WHERE batch = ? AND COALESCE(dropped, 0) = 0 AND done_at IS NULL LIMIT 1").bind(b.batch).first();
  if (!open) return refuse(db, now, { rule: "group-unknown", detail: `${b.batch} is not an open group` }, null, who);
  const g = await ensureGroup(db, now, who, b.batch);
  await db.prepare("UPDATE groups SET name = ? WHERE batch = ?").bind(b.name.trim(), b.batch).run();
  return { ok: true, batch: b.batch, num: g.num, name: b.name.trim() };
}
// #C1299: the owner moves a card to an open group of its own repository, or to a new group made from a name (no empty groups: the group exists with the card in it).
// A group with a card past Build is in review, and adding a card restarts its review: without `confirm: true` the store answers { ok: false, warn: "in-review" } and writes nothing.
// A new group takes the place the card had in the order list (a single card's own place, or just above the group it left).
export async function moveToGroup(db, now, who, b) {
  const bad = moveToGroupRefusal(b, who);
  if (bad) return refuse(db, now, bad, b?.id, who);
  const card = await db.prepare("SELECT id, batch, repo, dropped, done_at FROM cards WHERE id = ?").bind(b.id).first();
  if (!card || card.dropped || card.done_at) return refuse(db, now, { rule: "card-unknown", detail: String(b.id) }, b.id, who);
  let target = b.batch;
  if ("batch" in b) {
    if (target === card.batch) return refuse(db, now, { rule: "move-to-same", detail: `${b.id} is already in ${target}` }, b.id, who);
    const members = (await db.prepare("SELECT id, repo FROM cards WHERE batch = ? AND COALESCE(dropped, 0) = 0 AND done_at IS NULL").bind(target).all()).results ?? [];
    if (!members.length) return refuse(db, now, { rule: "group-unknown", detail: `${target} is not an open group` }, b.id, who);
    if (members.some((m) => String(m.repo ?? "").toLowerCase() !== String(card.repo ?? "").toLowerCase())) return refuse(db, now, { rule: "move-to-repo", detail: `${target} holds cards of another repository than ${b.id}` }, b.id, who);
    if (b.confirm !== true) {
      const phases = [];
      for (const m of members) { const e = await evidenceOf(db, `cards.${m.id}`); phases.push(e?.phase ?? e?.lit?.[0] ?? null); }
      if (groupPastBuild(phases)) return { ok: false, warn: "in-review", batch: target, message: "This group is in review: adding a card restarts its review" };
    }
  } else {
    const base = slugOfName(b.new_name);
    let n = 1;
    target = base;
    while (await db.prepare("SELECT 1 AS x FROM groups WHERE batch = ? UNION ALL SELECT 1 AS x FROM cards WHERE batch = ?").bind(target, target).first()) target = `${base}-${++n}`;
  }
  const slots = await openSlots(db);
  const was = card.batch ? card.batch : slotKeyOf(b.id);
  await db.prepare("UPDATE cards SET batch = ?, pulled_from = NULL, pulled_by = NULL, pulled_at = NULL, updated_at = ? WHERE id = ?").bind(target, now, b.id).run();
  await joinedGroup(db, now, who, b.id, target);
  if (!("batch" in b)) {
    await db.prepare("UPDATE groups SET name = ? WHERE batch = ?").bind(b.new_name.trim(), target).run();
    // The new group takes the card's place: a single card's own slot, or just above the group it left.
    const at = slots.indexOf(was);
    if (card.batch) slots.splice(at < 0 ? slots.length : at, 0, target);
    else if (at >= 0) slots[at] = target;
    else slots.push(target);
  }
  // The card's old group may be empty now (it disappears from the list), and a single card's own place is gone: write the list as it is.
  const open = new Set(await openSlots(db));
  const next = [...new Set(slots)].filter((k) => open.has(k));
  await writeOrder(db, now, who, next);
  const g = await db.prepare("SELECT num, name FROM groups WHERE batch = ?").bind(target).first();
  return { ok: true, id: b.id, batch: target, from: card.batch ?? null, num: g.num, name: g.name ?? null, created: !("batch" in b) };
}
// #C1053: the open groups in the owner's order. A group is a batch id of a card not done and not dropped; the order is group_order's places, a group
// with none after the placed ones (by id): groupCompare, the rule the dispatch and the page read too.
export async function openGroups(db) {
  const rows = (await db.prepare("SELECT DISTINCT batch FROM cards WHERE batch IS NOT NULL AND batch <> '' AND COALESCE(dropped, 0) = 0 AND done_at IS NULL").all()).results ?? [];
  const order = await orderList(db);
  return rows.map((r) => r.batch).sort((a, b) => groupCompare(a, b, order));
}
// #C1053: the owner (or Manager, as the fallback) moves a group one place up or down. Every open group is renumbered 1..n and so placed (a new group
// stays at the bottom until then); a row of a group that is no longer open goes. At the top going up, or the bottom going down, nothing moves.
// #C1299: the one order list: the open groups and the single cards the owner has placed ("c:<card id>"), by place. A single card nobody placed is in no place and
// not in the list (it sorts after everything, as before); the first move of its own arrows puts it at the end of the list, then moves it.
export async function openSlots(db) {
  const groups = await openGroups(db);
  const order = await orderList(db);
  const singles = (await db.prepare("SELECT id FROM cards WHERE (batch IS NULL OR TRIM(batch) = '') AND COALESCE(dropped, 0) = 0 AND done_at IS NULL").all()).results ?? [];
  const placed = singles.map((r) => slotKeyOf(r.id)).filter((k) => hasPlace(k, order));
  return [...groups, ...placed].sort((a, b) => groupCompare(a, b, order));
}
export async function moveGroup(db, now, who, b) {
  const bad = groupMoveRefusal(b, who);
  if (bad) return refuse(db, now, bad, null, who);
  const groups = await openSlots(db);
  let at = groups.indexOf(b.batch);
  if (at < 0 && b.batch.startsWith(SLOT_PREFIX)) {
    // A single card with no place of its own yet: it joins the end of the list, then moves.
    const id = b.batch.slice(SLOT_PREFIX.length);
    const card = await db.prepare("SELECT id FROM cards WHERE id = ? AND (batch IS NULL OR TRIM(batch) = '') AND COALESCE(dropped, 0) = 0 AND done_at IS NULL").bind(id).first();
    if (card) { groups.push(b.batch); at = groups.length - 1; }
  }
  if (at < 0) return refuse(db, now, { rule: "group-unknown", detail: `${b.batch} is not an open group or a single card` }, null, who);
  const to = b.dir === "up" ? at - 1 : at + 1;
  if (to < 0 || to >= groups.length) return { ok: true, batch: b.batch, moved: false, order: groups };
  [groups[at], groups[to]] = [groups[to], groups[at]];
  await writeOrder(db, now, who, groups);
  return { ok: true, batch: b.batch, moved: true, order: groups };
}
// #C1298 (11-19: a session that was not Manager's wrote through Manager's connector, and the board signed it "Manager"; the owner got a new-reply badge for it): the door guard that read_inbox has
// now covers every write on Manager's door. A write names the caller's session (`session`, taken off the arguments before the tool sees them) and the Worker compares it with the door
// session, as read_inbox does: no session named is refused, and so is one that is not the set one, whether or not one is set (with none set, a named session goes through, unguarded, so a deploy
// never shuts Manager out). A refusal is logged like any (the refusal log, rule door-session-mismatch) and says to stop and tell Manager; the expected id is never echoed back. Returns the refusal
// result, or null when the write may go on. Reads (read_view) and the two door tools (read_inbox and set_door_session, which carry their own guards) are not covered.
export const DOOR_UNGUARDED_TOOLS = new Set(["read_view", "read_inbox", "set_door_session"]);
export async function doorWriteRefusal(db, now, tool, session) {
  if (DOOR_UNGUARDED_TOOLS.has(tool)) return null;
  const expected = await db.prepare("SELECT session, set_by, set_at FROM door_session WHERE id = 1").first();
  const claimed = typeof session === "string" && session.trim() ? session.slice(0, 80) : null;
  if (claimed !== null && (!expected || claimed === expected.session)) return null;
  const lastSet = expected ? `the door's session was last set by ${expected.set_by} at ${mtDayTime(expected.set_at)}` : "no session has been set for the door yet";
  return refuse(db, now, { rule: "door-session-mismatch", detail: `${claimed === null ? `${tool} on Manager's door needs the \`session\` argument: Manager's own session id.` : "the session given is not the one set for Manager's door."} Nothing was written. If you are not Manager's session, stop and tell Manager, and write through the shared connector with your own \`as\`; never call set_door_session to get past this refusal. (${lastSet})` }, null, "Manager");
}
// #C1324 (the owner on #C1321's card, "that wasn't for me"): a note Manager wrote for an agent on a card's thread showed to the owner as "1 new reply". On Manager's
// own door a `post` on a card's thread (thread_id is a card id) is refused when the owner has written nothing there: nobody is replying to him, so the note is an
// agent's and goes by send_message. Never refused: the owner's own threads (a free thread), an ask's thread, and a card thread where the owner has a message.
// Returns the refusal (already logged) or null.
// #C1336 (11-20: an agent posted "resetting after this" on #C1331's thread through the shared connector and the owner got "1 new reply"): the same rule on the shared connector's post.
// `door` is the door the call came in on; on Manager's it names send_message to the agent, on the shared one it tells the agent to send its note to Manager by message.
// Security's and Checker 2's LOW on dfda43f5: callTool's `name === "post"` carries no door test, so the owner's own Access connector (door "access", callTool's default) reached this rule too. The owner is no
// agent: his post is never an agent's note, whatever the thread holds or the door. An agent's service token on the Access route is still an agent (the rule is by who writes, not by the route).
export async function agentNoteRefusal(db, now, who, args, door = "manager") {
  if (who === "owner") return null; // Checker 2's LOW: the owner's own first post on a card thread is never an agent's note, on whatever door it comes
  const t = args?.thread_id;
  if (typeof t !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(t)) return null; // a malformed post is the message-shape rule's
  // Checker 2's F1 on 7b72da97: a decision (kind "decision": #C1294 puts them on card threads before he has written) and a post that carries screenshots are meant for the owner.
  if (args?.kind === "decision" || (Array.isArray(args?.screenshots) && args.screenshots.length)) return null;
  if (!(await db.prepare("SELECT 1 AS x FROM cards WHERE id = ?").bind(t).first())) return null; // not a card's thread
  if (await db.prepare("SELECT 1 AS x FROM messages WHERE thread_id = ? AND author = 'owner' LIMIT 1").bind(t).first()) return null;
  return refuse(db, now, { rule: "agent-note-on-card", detail: `the owner has written nothing on ${t}'s thread, so a post there would show to him as a reply that is not one: ${door === "manager" ? "a note for an agent goes by send_message to that agent" : "send it to Manager by message (send_message), not as a post on a card thread"}` }, t, who);
}
// #C1332 (the owner, t-1795159050363: a mockup made Manager's A/B moot and the buttons stayed, with no tool to take them away): Manager's door withdraws a decision message it posted that the
// owner has not answered. The buttons go (options null), the message reads "No longer needed", and its kind becomes "withdrawn", so the card it held is released (openDecisionHolds
// reads kind = 'decision' only). Refused: another author's message (the owner's included), a message that is no open decision, and one the owner has already answered (any message
// of his that picks one of its options, "Chose <key>: <label>", at or after it; his other messages after it do not count).
export const WITHDRAWN_TEXT = "No longer needed";
export async function withdrawDecision(db, now, who, args) {
  const id = args?.message_id;
  if (!args || typeof args !== "object" || Object.keys(args).some((k) => k !== "message_id") || typeof id !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(id)) return refuse(db, now, { rule: "message-shape", detail: "message_id, the id of the decision message; nothing else" }, null, who);
  if (who !== "Manager") return refuse(db, now, { rule: "withdraw-manager-only", detail: `${who ?? "unknown"} cannot withdraw a decision: Manager's own door does` }, null, who);
  const m = await db.prepare("SELECT id, thread_id, author, created_at, kind, options FROM messages WHERE id = ?").bind(id).first();
  if (!m) return refuse(db, now, { rule: "withdraw-no-message", detail: `no message ${id}` }, null, who);
  if (m.author !== who) return refuse(db, now, { rule: "withdraw-not-yours", detail: `${id} was written by ${m.author}, not by ${who}: only your own decision is withdrawn` }, m.thread_id, who);
  if (m.kind !== "decision") return refuse(db, now, { rule: "withdraw-not-open-decision", detail: `${id} is not an open decision message` }, m.thread_id, who);
  // The owner's pick is his message "Chose <key>: <label>" (the page's optionText) after the decision; his other words after it are not an answer to it (#C1284: he wrote under a
  // decision and it stayed open). Manager, t-1795159050363: the owner wrote five messages after the A/B and never picked, and that is the case this tool is for.
  // Manager's edge: the pick must be this decision's own. Its text is one of this message's options as the page sends it ("Chose <key>: <label>"), and it comes before any LATER decision of
  // the thread (a pick after a second decision answers that one, as the page's openDecision reads it), so picking a newer decision never blocks withdrawing an older one.
  let own = [];
  try { own = JSON.parse(m.options ?? "[]"); } catch { /* an unreadable options column offers no pick */ }
  const picks = new Set((Array.isArray(own) ? own : []).filter((o) => o && typeof o.key === "string" && typeof o.label === "string").map((o) => `Chose ${o.key}: ${o.label}`));
  const later = await db.prepare("SELECT MIN(created_at) AS t FROM messages WHERE thread_id = ? AND created_at > ? AND kind = 'decision'").bind(m.thread_id, m.created_at).first();
  const heard = (await db.prepare("SELECT body FROM messages WHERE thread_id = ? AND created_at >= ? AND id <> ? AND author = 'owner' AND substr(body, 1, 6) = 'Chose ' AND (? IS NULL OR created_at < ?)").bind(m.thread_id, m.created_at, m.id, later?.t ?? null, later?.t ?? null).all()).results;
  const picked = heard.some((r) => picks.has(String(r.body ?? "").trim()));
  if (picked) return refuse(db, now, { rule: "withdraw-answered", detail: `the owner has already picked on ${id} in ${m.thread_id}: an answered decision stays as it is` }, m.thread_id, who);
  await db.prepare("UPDATE messages SET kind = 'withdrawn', options = NULL, screenshots = NULL, body = ? WHERE id = ?").bind(WITHDRAWN_TEXT, id).run();
  return { ok: true, id, thread_id: m.thread_id, withdrawn: true };
}
// #C1409: Manager's door calls off a Terminal, Action or Later ask (args: id, reason, replaced_by?). The ask is NOT closed: it stays where the owner reads it, marked Outdated with
// the reason, and he closes it himself; but it is owed by no one, so no stall, push, wake, hold or count reads it as waiting (isOutdated, board-rules.mjs). Nothing is deleted.
export async function outdateAsk(db, now, who, args) {
  const keys = ["id", "reason", "replaced_by"];
  if (!args || typeof args !== "object" || Object.keys(args).some((k) => !keys.includes(k)) || typeof args.id !== "string") return refuse(db, now, { rule: "outdate-shape", detail: "id, reason and optionally replaced_by; nothing else" }, null, who);
  const ask = await db.prepare("SELECT id, num, type, answered_at, closed_at, outdated_at, card_id FROM asks WHERE id = ?").bind(args.id).first();
  const n = replacedByNum(args.replaced_by);
  const replacement = n === null ? null : await db.prepare("SELECT id, num FROM asks WHERE num = ?").bind(n).first();
  const bad = outdatedRefusal(ask ?? null, who, { reason: args.reason, replacedBy: args.replaced_by, replacement });
  if (bad) return refuse(db, now, bad, ask?.card_id ?? null, who);
  await db.prepare("UPDATE asks SET outdated_at = ?, outdated_by = ?, outdated_reason = ?, replaced_by = ? WHERE id = ?").bind(now, who, args.reason.trim(), n, args.id).run();
  return { ok: true, id: args.id, outdated: true, ...(n !== null ? { replaced_by: n } : {}) };
}
export async function guardedInbox(db, now, session) {
  const expected = await db.prepare("SELECT session, set_by, set_at FROM door_session WHERE id = 1").first();
  const claimed = typeof session === "string" && session.trim() ? session.slice(0, 80) : null;
  const log = (ok, reason) => db.prepare("INSERT INTO inbox_takes (at, claimed, ok, reason) VALUES (?, ?, ?, ?)").bind(now, claimed, ok ? 1 : 0, reason).run();
  // #C1213 (11-18: a Boardsmith session called read_inbox with no `session` and took Manager's batch, because no door session was set and the guard let
  // every take through): a take that names no session is refused whether or not one is set; with none set, a take that names one still goes through
  // unguarded, so a deploy never shuts Manager out.
  if (claimed === null || (expected && claimed !== expected.session)) {
    await log(false, claimed === null ? "no session given" : "session does not match");
    // The expected id is never echoed back.
    const lastSet = expected ? `the door's session was last set by ${expected.set_by} at ${mtDayTime(expected.set_at)}` : "no session has been set for the door yet";
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
  const answers = (await db.prepare("SELECT id, num, title, answer, answer_status, answer_note, answered_at, answered_by, outdated_at, outdated_reason FROM asks WHERE answered_at IS NOT NULL AND answer_taken_at IS NULL ORDER BY answered_at").all()).results;
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
  // #C1409: an answer to an ask Manager called off still reaches Manager through this same answers list (answered_at wakes it, as for any answer), and says so:
  // `outdated_note` tells him his own call-off and that his action may need undoing. Only what is returned changes.
  for (const a of answers) {
    if (a.outdated_at != null) a.outdated_note = `You called ask #T${a.num} off ('${a.outdated_reason}'); the owner answered it anyway: ${a.answer}. Check whether his action still needs undoing.`;
    delete a.outdated_at; delete a.outdated_reason;
  }
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
  // #C990: the first post after a silence of probeSilentSec (default PROBE_SILENT_MS) or more closes an outage: from the last post before it to this one. A run's own report (run.*)
  // is no heartbeat (readView counts the same way). INSERT OR IGNORE: two posts of one batch cannot record it twice.
  if (isProbeKey(key)) {
    const last = (await db.prepare(`SELECT MAX(read_at) AS at FROM evidence WHERE ${PROBE_KEYS_SQL}`).first())?.at;
    if (Number.isFinite(last) && now - last > await silentMsOf(db)) {
      await db.prepare("INSERT OR IGNORE INTO team_outages (start_at, end_at) VALUES (?, ?)").bind(last, now).run();
      await db.prepare("DELETE FROM team_outages WHERE end_at < ?").bind(now - OUTAGE_KEEP_MS).run();
    }
  }
  const upsertOf = (v) => db.prepare("INSERT INTO evidence (key, value, read_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, read_at = excluded.read_at").bind(key, JSON.stringify(v), now);
  if (!key.startsWith("cards.")) { await upsertOf(value).run(); return { ok: true }; }
  // A card's lit phase changed (or is read for the first time): the phase history gets its rows in the same write (#C723 B3b).
  // The phase it was in: the last evidence reading, else (the first reading after the one-time import) the phase the history left open.
  const cardId = key.slice(6);
  const before = await evidenceOf(db, key);
  // #C875: the Rework flag is the Worker's, never the probe's: a `rework` the probe sends is dropped. It is set on a transition between two readings
  // (reworkTriggered), kept across the readings that follow, and cleared when a reason is attached (updateCard) or the card is on main or live.
  const { rework: _sent, ...sent } = value;
  // #C1114 part 2: a step back from a review phase with no FINDINGS and no reason does not move the card: the stored review reading stays, flagged rework:
  // "unexplained" (`reworkAt` when it began, `actual` the reading the probe really saw); the first reading that is no step back, or the one at the head a
  // reason was attached for, moves it on. A reading that stays held keeps its `reworkAt`.
  const holding = unexplainedStepBack(before, sent);
  const { rework: _r, reworkAt: _at, actual: _a, reasoned: _rs, ...kept } = before ?? {};
  const reading = holding ? { ...kept, actual: { headSha12: sent.headSha12, phase: sent.lit[0] } } : sent;
  const next = reading.lit[0];
  const reasonedHere = typeof before?.reasoned === "string" && before.reasoned !== "" && before.reasoned === sent.headSha12;
  // #C1406: a card sent back (the flag) is back in review once it is read at a review phase again with no findings of its own (its READY is declared: the same tip read past build, or a newer tip): the
  // flag clears with no hand step. A flag set while the card sat at review (an older reading) clears only on a newer tip.
  const inReview = (p) => ["language", "design", "checker", "security", "ship"].includes(p);
  const backInReview = before?.rework === true && inReview(next) && !(Array.isArray(sent.findings) && sent.findings.length)
    && (!inReview(before.lit?.[0]) || (typeof sent.headSha12 === "string" && typeof before.headSha12 === "string" && sent.headSha12 !== before.headSha12));
  const rework = holding ? false : before?.rework === true && reading.onMain !== true && next !== "live" && !backInReview ? true : !reasonedHere && !backInReview && reworkTriggered(before, reading);
  const upsert = upsertOf(holding ? { ...reading, rework: "unexplained", reworkAt: before.rework === "unexplained" && Number.isFinite(before.reworkAt) ? before.reworkAt : now, reworkCounts: before.rework === "unexplained" && Number.isInteger(before.reworkCounts) ? before.reworkCounts : issueTotal(sent.issueCounts) } : rework ? { ...reading, rework: true } : reading);
  let prev = before?.lit?.[0] ?? null;
  // A wait step (the step tool, #C739) is not the lit phase: the three reads of the history below take the probe's own rows only (wait IS NULL).
  if (!prev) { const last = await db.prepare("SELECT phase, kind FROM phase_history WHERE card_id = ? AND wait IS NULL ORDER BY at DESC, id DESC LIMIT 1").bind(cardId).first(); if (last?.kind === "start") prev = last.phase; }
  const prevWho = prev && prev !== next ? (await db.prepare("SELECT who FROM phase_history WHERE card_id = ? AND phase = ? AND kind = 'start' AND wait IS NULL ORDER BY at DESC, id DESC LIMIT 1").bind(cardId, prev).first())?.who ?? null : null;
  const cardRow = await db.prepare("SELECT owner_role, repo, waiting_on, blocked_reason FROM cards WHERE id = ?").bind(cardId).first();
  const agents = (await evidenceOf(db, "agents")) ?? {}, ownerRole = cardRow?.owner_role;
  // #C1114: the counters the probe counted from the review notes raise the card's issues (raisedIssues: never lower, never double).
  // #C1397: when the probe's issueBase (the merge-base the counts were read from) differs from the one in the card's previous reading, the range changed: the review kinds are
  // set to this range's counts (an absent issueCounts is the range with none). No previous issueBase (a card not yet carrying it): raise only, as before.
  const rangeChanged = typeof sent.issueBase === "string" && typeof before?.issueBase === "string" && sent.issueBase !== before.issueBase;
  // #C1406: a reading that carries tipIssues (the open findings on the current tip alone) SETS the four review kinds to them every time: the count is a per-tip record, never an older tip's. A reading
  // without it (a probe from before) keeps the rules above.
  const perTip = sent.tipIssues && typeof sent.tipIssues === "object" && !Array.isArray(sent.tipIssues);
  if (cardRow && (perTip || sent.issueCounts || rangeChanged)) {
    const stored = await db.prepare("SELECT issues FROM cards WHERE id = ?").bind(cardId).first();
    let have = null; try { have = stored?.issues ? JSON.parse(stored.issues) : null; } catch { /* none */ }
    const up = perTip ? raisedIssues(have, sent.tipIssues, true) : raisedIssues(have, sent.issueCounts ?? {}, rangeChanged);
    if (up) await db.prepare("UPDATE cards SET issues = ?, issues_at = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(up), now, now, cardId).run();
  }
  // #C1110: a branch that touches the customer-text paths sets the card's flag; only ever raised (null or 0 becomes 1), never cleared.
  if (cardRow && sent.customerText === true) await db.prepare("UPDATE cards SET customer_text = 1, updated_at = ? WHERE id = ? AND (customer_text IS NULL OR customer_text = 0)").bind(now, cardId).run();
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
  // #C1378 (replaces #C1104 part 2, which closed a card of a named non-board repository the moment its commit was on main): no card closes at landing. A product card
  // closes when it reads live, like a board card (no install wait, no pack); a part marked in its next_note that is not on main keeps it reading ship (`partsMissing`, #C890).
  const link = next === "live" ? liveDoneEvidence(reading) : null;
  const closes = link
    ? [db.prepare("UPDATE cards SET done_at = ?, done_evidence = ?, updated_at = ? WHERE id = ? AND done_at IS NULL AND dropped = 0 AND check_at IS NULL").bind(now, link, now, cardId)] : [];
  // #C1036: the first reading with the card's commit on main ends its holds: what a hold waited for has landed. The words go to hold_history first;
  // a card with no hold, a done or dropped card, and a card read on main before change nothing.
  const clears = [];
  if (reading.onMain === true && before?.onMain !== true) {
    // check_at is NOT cleared (Checker 2's F1 on b3958bfd, the lead's ruling on #C1036): it is the lead's or the owner's date that holds a card open past
    // its live reading, lifted only by them; clearing it here would let the next live reading close the card.
    const held = await db.prepare("SELECT waiting_on, blocked_reason, hold_end FROM cards WHERE id = ? AND done_at IS NULL AND dropped = 0").bind(cardId).first();
    if (held && (held.waiting_on || held.blocked_reason || held.hold_end)) {
      clears.push(db.prepare("INSERT INTO hold_history (card_id, at, waiting_on, blocked_reason, hold_end) VALUES (?, ?, ?, ?, ?)").bind(cardId, now, held.waiting_on ?? null, held.blocked_reason ?? null, held.hold_end ?? null));
      clears.push(db.prepare("UPDATE cards SET waiting_on = NULL, blocked_reason = NULL, hold_end = NULL, held_at = NULL, hold_until = NULL, updated_at = ? WHERE id = ?").bind(now, cardId));
    }
  }
  // #C992: the reviewer a card waited on has just signed it: that waiting_on is over. It is cleared with the hold it made (its end goes too unless a
  // blocked_reason still holds the card), and the card moved on. Only the value read here is cleared (a write that changed it since keeps its own).
  const signedRole = cardRow ? signoffClears(before, reading, cardRow.waiting_on) : null;
  const stillBlocked = typeof cardRow?.blocked_reason === "string" && cardRow.blocked_reason.trim() !== "";
  const unwait = signedRole
    ? [db.prepare(`UPDATE cards SET waiting_on = NULL, hold_until = NULL${stillBlocked ? "" : ", held_at = NULL, hold_end = NULL"}, moved_at = ?, updated_at = ? WHERE id = ? AND waiting_on = ?`).bind(now, now, cardId, cardRow.waiting_on)] : [];
  // Both in one batch: a sign-off and a landing in the same reading clear the waiting_on once; #C1036's history keeps the words it read above.
  await db.batch([upsert, ...ins, ...closes, ...unwait, ...clears]);
  await noteShip(db, now, cardId, value);
  await endClaims(db, now); // #C1094: a claim on the tip this reading signed or landed ends here
  return signedRole ? { ok: true, cleared: { waiting_on: cardRow.waiting_on, signedBy: signedRole } } : { ok: true };
}

// #C988: a session's reading of the week ("Weekly · all models" from get_usage), through the week_usage door tool. It is no status (the
// probe alone writes those, evidenceRefusal): one key, usage.week, of its own shape. Its `by` is the role the caller names (on the shared connector, its own `as`): a claim, never proof
// of who wrote it, so nothing relies on it (Security's LOW 1 on 1305a74).
export async function writeWeekUsage(db, now, who, args) {
  const r = weekUsageValue(args, now, who);
  if (r.refused) return refuse(db, now, { rule: "week-usage-shape", detail: r.refused }, null, who);
  await db.prepare("INSERT INTO evidence (key, value, read_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, read_at = excluded.read_at").bind(WEEK_USAGE_KEY, JSON.stringify(r.value), now).run();
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
  const last = Math.max(0, ...Object.entries(evidence).filter(([k]) => isProbeKey(k)).map(([, e]) => e.readAt));
  // #C997: the probe's own settings (evidence key knobs) feed both edges; no reading, or a value out of bounds, keeps the default.
  const knobsRead = evidence.knobs?.value;
  const probe = last && now - last <= knobFrom(knobsRead, "probeSilentSec") * 1000 ? { state: "ok", lastAt: last } : { state: "silent", since: last || null };
  const live = liveNow(evidence.live ? { version: evidence.live.value.version, readAt: evidence.live.readAt } : null, now, staleMsOf(knobsRead));
  const history = await all("SELECT id, card_id, phase, kind, at, who, wait FROM phase_history ORDER BY at, id");
  const historyCards = await all("SELECT id, num, title, size, review_level, created_at, done_at FROM history_cards ORDER BY done_at");
  const stackSwitch = (await all("SELECT repo, stack, set_by, set_at FROM stack_switch ORDER BY repo")).map((r) => ({ ...r, stack: r.stack === 1 }));
  const threads = await readThreads(db), files = await readFiles(db, asks, threads.messages), ships = await readShips(db), usage = await readUsage(db);
  const reworkHistory = await all("SELECT card_id, reason, at, who FROM rework_history ORDER BY at, id");
  const pings = (await db.prepare("SELECT card_id, MAX(created_at) AS at FROM stall_wakes WHERE card_id LIKE ? GROUP BY card_id").bind(`${PING_CARD}%`).all()).results.map((r) => ({ id: r.card_id.slice(PING_CARD.length), at: r.at }));
  // #C1018: the review claims still held (a released one is history): the dispatch reads them so a claimed tip wakes no second checker.
  const reviewClaims = await all("SELECT sha, card_id, checker, claimed_at, mutants, mutant_sec, progress, progress_at FROM review_claims WHERE released_at IS NULL ORDER BY claimed_at, sha");
  // #C1053: the owner's order of the groups (pos 1 goes live first), read by the page and the dispatch.
  const groupOrder = await all("SELECT batch, pos, set_by, set_at FROM group_order ORDER BY pos, batch");
  // #C1299: each group's number and name (the page draws "#G12 name"; a group with no name shows its batch id).
  const groupNames = await all("SELECT batch, num, name FROM groups ORDER BY num");
  // #C1097: the idle-agent stalls now current, each with the time the store first raised it; the dispatch wakes the stalled role once one is 30 minutes old.
  const agentStalls = (await db.prepare("SELECT card_id, reason, created_at FROM stall_wakes WHERE card_id LIKE ? ORDER BY created_at, card_id").bind(`${AGENT_STALL}%`).all()).results.map(agentStallOf).filter(Boolean);
  const content = { pings, agentStalls, cards, asks, lists, evidence, refusals, wake, history, historyCards, files, ships, usage, threads, stackSwitch, reviewClaims, reworkHistory, groupOrder, groupNames };
  // The tag covers what the page shows; a probe going silent changes it, the clock moving alone does not.
  const wakeState = wakeStatus(wakeFacts(wake, wake.alive_at || undefined), now, wakeLimits(knobsRead));
  const tag = (await sha256hex(JSON.stringify([content, probe.state, wakeState.state, wakeState.reason ?? null]))).slice(0, 16);
  return { tag, now, live, probe, wakeState, ...content };
}
