// What the board pushes to the owner's phone, and when (#C904; #C874's push, #C879's unanswered asks). Pure: rows and the
// time in, lines out. The store (push-store.mjs) reads the rows, sends and records; the page never decides any of it.
//   An open ask waits on the owner from its creation, or from its date: a Later ask's eta_at, a Decision's "not before"
//   (eta_at, #C823). Answered, closed or withdrawn, it waits on nobody here.
//   At MANAGER_NUDGE_MIN Manager is woken once (a stall line, the wake's own path), so Manager can make it clearer first.
//   At OWNER_PUSH_MIN the owner's phone gets it, once per ask.
//   A ship the probe recorded and the owner hasn't acknowledged, from the last SHIP_DAYS (the page's "Went live, not yet
//   acknowledged" list), is pushed once per version.
//   #C1016: when the newest evidence write (the probe's heartbeat, as the page's "probe silent" chip reads it) is SILENT_PUSH_MIN
//   old, the phone is told once for that silence, with the time the board last heard from the Mac. A write after it ends the
//   silence, and the next silence is told again.
// A push says only counts, ask numbers, versions and times: never an ask's, card's or message's text (it leaves through the push
// service).

import { mtDayTime, mtHour } from "./team-time.mjs";
import { KNOBS, knobFrom } from "./knobs.mjs";

const MIN = 60e3, DAY = 864e5;
// #C1106: each number is the default of a setting the probe posts (worker/knobs.mjs); the store passes the posted ones as `lim` (pushLimits). In minutes and
// days, as these names always were.
export const MANAGER_NUDGE_MIN = KNOBS.managerNudgeSec.default / 60, OWNER_PUSH_MIN = KNOBS.ownerPushSec.default / 60, SHIP_DAYS = KNOBS.shipWindowSec.default / 86400, SILENT_PUSH_MIN = KNOBS.silentPushSec.default / 60;
// What each rule takes: minutes (and days for the two windows). `lim` is optional everywhere; a field that is missing is the default.
export const pushLimits = (stored) => ({
  nudgeMin: knobFrom(stored, "managerNudgeSec") / 60, pushMin: knobFrom(stored, "ownerPushSec") / 60, wordMin: knobFrom(stored, "ownerWordSec") / 60,
  wordRepeatMin: knobFrom(stored, "ownerWordRepeatSec") / 60, wordSlowRepeatMin: knobFrom(stored, "ownerWordSlowRepeatSec") / 60, wordDays: knobFrom(stored, "ownerWordWindowSec") / 86400,
  promptMin: knobFrom(stored, "promptSec") / 60, silentMin: knobFrom(stored, "silentPushSec") / 60, shipDays: knobFrom(stored, "shipWindowSec") / 86400,
});
// Minutes in a line's words: whole minutes, a part of a minute rounded up.
const minTxt = (m) => `${Math.ceil(m)}`;
export const ASK_WAKE_PREFIX = "ask:";

export function askWaitsFrom(a) {
  if (!a || a.closed_at != null || a.answered_at != null || a.withdrawn_at != null || a.outdated_at != null) return null; // an outdated ask (#C1409) is called off: the owner owes nothing on it
  // #C925: a promise (owed_by) waits on its promiser, never on the owner: no 10-minute nudge, no phone push (promiseWakes below).
  if (typeof a.owed_by === "string" && a.owed_by) return null;
  if (a.type === "Later") return typeof a.eta_at === "number" ? a.eta_at : null;
  if (a.type === "Decision" && typeof a.eta_at === "number" && a.eta_at > a.created_at) return a.eta_at;
  return typeof a.created_at === "number" ? a.created_at : null;
}
const waited = (a, now, min) => { const from = askWaitsFrom(a); return from !== null && now - from >= min * MIN; };

// Manager's wake lines: one row per ask (the stall_wakes key is "ask:<id>"), a reason that never changes for that ask, so
// it is told once. #C922 (Checker's LOW2 on #C904): it promises no push, since the owner may have no key or device set; it
// says the push comes only if one is, so the words never change with the setup (a new reason would wake Manager again).
export function askWakes({ asks, now, lim = {} }) {
  const nudge = lim.nudgeMin ?? MANAGER_NUDGE_MIN, push = lim.pushMin ?? OWNER_PUSH_MIN;
  return asks.filter((a) => waited(a, now, nudge)).map((a) => ({
    card_id: `${ASK_WAKE_PREFIX}${a.id}`,
    reason: `ask #T${Number(a.num)} has waited ${minTxt(nudge)} min for the owner: make it clearer or answer what you can; at ${minTxt(push)} min it goes to the owner's phone, if phone pushes are on`,
  }));
}

// #C1081 (11-16: three threads ended on the owner's words with no reply, #T166 "ok close then" and t1949 "here"; read_inbox shows a message once, so a
// thread answered somewhere else stayed unanswered): a thread whose NEWEST message is the owner's, is MORE than OWNER_WORD_MIN old and is still open gets a
// stall line for Manager, and again every OWNER_WORD_REPEAT_MIN until someone posts in it (the newest message is then not the owner's, so the line ends).
// One row per thread ("ownerword:<thread>"); the reason carries the owner's time and the reminder number (never the minutes, which would change every
// sync), so a later reminder is a new reason and is told again, and an older untaken one is replaced by it. Open: a closed or withdrawn ask, a dropped or
// done card and a message that resolved its thread are over. Only the last OWNER_WORD_DAYS days are read, so an old thread does not flood Manager. Never
// the message's text: the line says the number and the time.
export const OWNER_WORD_PREFIX = "ownerword:", OWNER_WORD_MIN = KNOBS.ownerWordSec.default / 60, OWNER_WORD_REPEAT_MIN = KNOBS.ownerWordRepeatSec.default / 60, OWNER_WORD_DAYS = KNOBS.ownerWordWindowSec.default / 86400;
// An owner's word that only acknowledges needs no answer (#C887, #C933): the page's rule (ACK_WORDS and ACK_IF_NO_QUESTION in page/board.template.html),
// copied here because the Worker cannot read the page; tests/owner-last-word-stall.test.mjs fails on ANY difference between the two lists
// (#C1083; "closed" and "done" were this Worker's alone for a while, and the page still showed "answer coming" for a lone "Closed."). yes, yep, yup, great and
// perfect are acks only when the team's last post before it asked nothing (no "?").
export const OWNER_ACK_WORDS = ["ack", "acked", "ok", "okay", "k", "kk", "thanks", "thank you", "thx", "ty", "got it", "noted", "sounds good", "will do", "cool", "nice", "closed", "done", "👍"];
export const OWNER_ACK_IF_NO_QUESTION = ["yes", "yep", "yup", "great", "perfect"];
const ackKey = (t) => typeof t === "string" ? t.trim().toLowerCase().replace(/[\s.!,]+$/g, "").replace(/^[\s]+/, "") : "";
export function ownerAck(body, prevTeamBody) {
  const k = ackKey(body);
  if (OWNER_ACK_WORDS.includes(k)) return true;
  return OWNER_ACK_IF_NO_QUESTION.includes(k) && !(typeof prevTeamBody === "string" && prevTeamBody.includes("?"));
}
// Manager's cap, to save quota: reminders 1 to OWNER_WORD_FAST_REMINDERS come every OWNER_WORD_REPEAT_MIN, after that every OWNER_WORD_SLOW_REPEAT_MIN. The
// reminder number for a word `ageMs` old: 0 until OWNER_WORD_MIN + 30 min, 1 from then, ... 4 from 130 min, 5 from 310 min, 6 from 490 min, and so on.
export const OWNER_WORD_FAST_REMINDERS = 4, OWNER_WORD_SLOW_REPEAT_MIN = KNOBS.ownerWordSlowRepeatSec.default / 60;
export function ownerWordReminder(ageMs, lim = {}) {
  const wordMin = lim.wordMin ?? OWNER_WORD_MIN, repeatMin = lim.wordRepeatMin ?? OWNER_WORD_REPEAT_MIN, slowMin = lim.wordSlowRepeatMin ?? OWNER_WORD_SLOW_REPEAT_MIN;
  const since = ageMs - wordMin * MIN, fastEnd = OWNER_WORD_FAST_REMINDERS * repeatMin * MIN;
  if (since < fastEnd) return Math.max(0, Math.floor(since / (repeatMin * MIN)));
  return OWNER_WORD_FAST_REMINDERS + Math.floor((since - fastEnd) / (slowMin * MIN));
}
export function ownerWordWakes({ rows, now, lim = {} }) {
  const wordMin = lim.wordMin ?? OWNER_WORD_MIN, wordDays = lim.wordDays ?? OWNER_WORD_DAYS;
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.thread_id !== "string" || !Number.isFinite(r.at)) continue;
    // A message that only acknowledges, with nothing attached, is no word to answer (the newest message decides: an ack after an earlier question ends it).
    if (!r.has_files && ownerAck(r.body, r.prev_team_body)) continue;
    const age = now - r.at;
    if (age < wordMin * MIN || age > wordDays * DAY) continue;
    if (r.resolved || r.ask_closed_at != null || r.ask_withdrawn_at != null || r.ask_outdated_at != null || r.card_dropped || r.card_done_at != null) continue;
    const label = Number.isInteger(r.ask_num) ? `#T${r.ask_num}` : Number.isInteger(r.card_num) ? `#C${r.card_num}` : Number.isInteger(r.thread_num) ? `#T${r.thread_num}` : null;
    if (label === null) continue;
    const k = ownerWordReminder(age, lim);
    out.push({ card_id: `${OWNER_WORD_PREFIX}${r.thread_id}`, reason: `${label} ends on the owner's word of ${mtDayTime(r.at)}, unanswered for ${minTxt(wordMin)}+ min${k ? ` (reminder ${k})` : ""}: post in the thread, even one line saying it is done` });
  }
  return out;
}

// #C925: at a promise's date the store wakes its promiser (the lead) once, through the same stall rows: one row per ask
// ("promise:<id>"), a reason that never changes for that ask, so it is told once. Open only: a closed or answered promise is kept.
export const PROMISE_WAKE_PREFIX = "promise:";
export function promiseWakes({ asks, now }) {
  return asks.filter((a) => a && typeof a.owed_by === "string" && a.owed_by && a.type === "Later" && a.closed_at == null && a.answered_at == null && a.withdrawn_at == null && a.outdated_at == null
    && typeof a.eta_at === "number" && a.eta_at <= now && Number.isInteger(Number(a.num))).map((a) => ({
    card_id: `${PROMISE_WAKE_PREFIX}${a.id}`,
    reason: `#T${Number(a.num)} is due now: you promised it to the owner for this time; do it, or post on its thread when it will be`,
  }));
}

// What is due on the phone now and not pushed yet: { asks, ships, deploy } (asks and ships arrays of rows, deploy a 40-hex commit or null), and the push's words.
// #C968: deploy is the commit the Worker was deployed from (BUILD_SHA), told once per commit ("board deployed <short sha>"), so a deploy the owner did
// not start by hand is seen within minutes. Anything that is not a full lower-case sha is no deploy.
export const DEPLOY_SHA = /^[0-9a-f]{40}$/;
// #C1016: silent is the time (ms) of the newest evidence write when it is SILENT_PUSH_MIN old or more and this silence has not been told, else null.
// Recorded in push_sent as kind 'ship', ref "silent:<that time>" (no migration): a new write changes the time, so the next silence is told again.
// No evidence at all (lastEvidenceAt null or 0) is a board that has not started, not a silence.
// #C1005: a role stuck on a step (the probe's evidence.stuck, kind "step") is told once per session and per `since` (its last activity), as kind 'ship',
// ref "stuck:<role>:<since>" (no migration). Held from NIGHT_FROM to NIGHT_TO o'clock MT: nothing goes at night, and the first run after 7 am sends what
// is still stuck. A stuck reading that is gone (the role moved) is never told. A `user` stuck is the prompt watch's, not this push.
export const NIGHT_FROM = 22, NIGHT_TO = 7;
export const isNight = (now) => { const h = mtHour(now); return h !== null && (h >= NIGHT_FROM || h < NIGHT_TO); };
const ROLE_WORD = /^[A-Za-z][A-Za-z0-9 -]{0,31}$/;
export function stuckDue({ stuck, sent, now }) {
  if (isNight(now) || !stuck || typeof stuck !== "object" || Array.isArray(stuck)) return [];
  return Object.entries(stuck)
    .filter(([role, s]) => ROLE_WORD.test(role) && s && s.kind === "step" && Number.isInteger(s.since) && s.since > 0 && !sent.has(`ship:stuck:${role}:${s.since}`))
    .map(([role, s]) => ({ role, since: s.since })).sort((a, b) => (a.role < b.role ? -1 : 1));
}
// #C1005 (b), the prompt watch (scripts/prompt-watch.mjs's rule): a role stopped on a call the owner must answer (evidence.stuck, kind "user") for PROMPT_MIN
// is one line to Manager's batch (a stall row "prompt:<role>:<since>", told once) and one phone push (push_sent ship "prompt:<role>:<since>"); both held at
// night and sent at the first run after 7 am. The words carry a role and a time, never the prompt's text.
export const PROMPT_MIN = KNOBS.promptSec.default / 60;
const promptRows = (stuck, now, byNight = false, promptMin = PROMPT_MIN) => (stuck && typeof stuck === "object" && !Array.isArray(stuck) && (byNight || !isNight(now))
  ? Object.entries(stuck).filter(([role, s]) => ROLE_WORD.test(role) && s && s.kind === "user" && Number.isInteger(s.since) && s.since > 0 && now - s.since >= promptMin * MIN)
    .map(([role, s]) => ({ role, since: s.since })).sort((a, b) => (a.role < b.role ? -1 : 1)) : []);
export const promptDue = ({ stuck, sent, now, lim = {} }) => promptRows(stuck, now, false, lim.promptMin ?? PROMPT_MIN).filter((p) => !sent.has(`ship:prompt:${p.role}:${p.since}`));
export const PROMPT_WAKE_PREFIX = "prompt:";
// byNight: ignore the night hold, to name the rows the hold keeps back (the store keeps an untaken one until 7 am while the role is still stopped; Checker 2's F2).
export function promptWakes({ stuck, now, byNight = false, lim = {} }) {
  const promptMin = lim.promptMin ?? PROMPT_MIN;
  return promptRows(stuck, now, byNight, promptMin).map((p) => ({ card_id: `${PROMPT_WAKE_PREFIX}${p.role}:${p.since}`, reason: `${p.role} has waited on a prompt in its session since ${mtDayTime(p.since)} (${minTxt(promptMin)}+ min): open it in the Claude app and answer it` }));
}
// #C1005 (c): the watchdog task's other lines to Manager's batch, from the probe's `watch` reading (evidence key "watch", written only on a run that has
// something): the app restarted, the prompt ledger's new prompts, a silent ledger. One stall row each, keyed by the reading's own time, so each is told once.
// The words carry roles, tool words, counts and times, never a command or a message. No night hold: Manager reads them whenever it wakes.
export const WATCH_WAKE_PREFIX = "watch:";
export const RESTART_LINE = "app restarted: re-watch the board, re-check models and Remote Control";
export function watchWakes({ watch }) {
  if (!watch || typeof watch !== "object" || Array.isArray(watch) || !Number.isInteger(watch.at)) return [];
  const out = [];
  if (watch.restart === true) out.push({ card_id: `${WATCH_WAKE_PREFIX}restart:${watch.at}`, reason: RESTART_LINE });
  const l = watch.ledger;
  if (l && typeof l === "object" && Array.isArray(l.prompts) && Number.isInteger(l.others)) {
    const bits = l.prompts.filter((p) => p && /^[A-Za-z][A-Za-z0-9]{1,23}$/.test(String(p.role)) && /^[A-Za-z][A-Za-z0-9_.:-]{0,47}$/.test(String(p.tool)) && Number.isInteger(p.n) && p.n > 0).slice(0, 12).map((p) => `${p.role} ${p.tool} x${p.n}`);
    const parts = [];
    if (bits.length) parts.push(`Permission prompts since the last check: ${bits.join(", ")}`);
    if (l.others > 0) parts.push(`${l.others} other notification${l.others === 1 ? "" : "s"}`);
    if (parts.length) out.push({ card_id: `${WATCH_WAKE_PREFIX}ledger:${watch.at}`, reason: parts.join(" | ") });
  }
  const q = watch.quiet;
  if (q && typeof q === "object" && Number.isInteger(q.running) && q.running > 0) {
    const since = Number.isInteger(q.since) ? q.since : null;
    const gap = since ? `since ${mtDayTime(since)} (${Number.isInteger(q.days) ? q.days : "?"} days)` : "at all";
    out.push({ card_id: `${WATCH_WAKE_PREFIX}quiet:${since ?? "none"}`, reason: `Prompt ledger silent: no line ${gap} while ${q.running} agent session(s) ran. The Notification hook may be off: check ~/.claude/settings.json against README "Prompt ledger"` });
  }
  return out;
}
export function pushesDue({ asks, ships, sent, now, deploy = null, lastEvidenceAt = null, stuck = null, lim = {} }) {
  const pushMin = lim.pushMin ?? OWNER_PUSH_MIN, silentMin = lim.silentMin ?? SILENT_PUSH_MIN, shipDays = lim.shipDays ?? SHIP_DAYS;
  const was = (kind, ref) => sent.has(`${kind}:${ref}`);
  const dueStuck = stuckDue({ stuck, sent, now });
  const duePrompt = promptDue({ stuck, sent, now, lim });
  const dueSilent = Number.isInteger(lastEvidenceAt) && lastEvidenceAt > 0 && now - lastEvidenceAt >= silentMin * MIN && !was("ship", `silent:${lastEvidenceAt}`) ? lastEvidenceAt : null;
  // Recorded in push_sent as kind 'ship', ref "deploy:<sha>" (its kind is checked to ask or ship, and a ship's ref is a version, never "deploy:..."): no migration.
  const dueDeploy = typeof deploy === "string" && DEPLOY_SHA.test(deploy) && !was("ship", `deploy:${deploy}`) ? deploy : null;
  const dueAsks = asks.filter((a) => waited(a, now, pushMin) && !was("ask", a.id)).sort((x, y) => x.num - y.num);
  const dueShips = ships.filter((s) => s.acked_at == null && typeof s.shipped_at === "number" && now - s.shipped_at <= shipDays * DAY && !was("ship", s.version))
    .sort((x, y) => x.shipped_at - y.shipped_at);
  return { asks: dueAsks, ships: dueShips, deploy: dueDeploy, silent: dueSilent, stuck: dueStuck, prompts: duePrompt, payload: dueAsks.length || dueShips.length || dueDeploy || dueSilent || dueStuck.length || duePrompt.length ? pushWords(dueAsks, dueShips, dueDeploy, dueSilent, dueStuck, duePrompt, lim) : null };
}

const VERSION = /^v?\d+(?:\.\d+){1,3}$/;
const list = (items) => (items.length <= 3 ? items.join(", ") : `${items.slice(0, 3).join(", ")} and ${items.length - 3} more`);
export function pushWords(asks, ships, deploy = null, silent = null, stuck = [], prompts = [], lim = {}) {
  const parts = [];
  if (prompts.length) parts.push(`${list(prompts.map((p) => p.role))} ${prompts.length === 1 ? "is" : "are"} waiting on a prompt in ${prompts.length === 1 ? "its session" : "their sessions"}: open ${prompts.length === 1 ? "it" : "each"} in the Claude app and answer`);
  if (stuck.length) parts.push(`${list(stuck.map((s) => `${s.role} (quiet since ${mtDayTime(s.since)})`))} ${stuck.length === 1 ? "looks" : "look"} stuck mid-turn: open ${stuck.length === 1 ? "its" : "each"} session`);
  if (Number.isInteger(silent) && silent > 0) parts.push(`board jobs silent since ${mtDayTime(silent)}: the Mac may have crashed, log back in`);
  if (typeof deploy === "string" && DEPLOY_SHA.test(deploy)) parts.push(`board deployed ${deploy.slice(0, 7)}`);
  if (ships.length) {
    const vs = ships.map((s) => (VERSION.test(String(s.version)) ? String(s.version) : "a version"));
    parts.push(`${list(vs)} went live: acknowledge ${ships.length === 1 ? "it" : "them"}`);
  }
  if (asks.length) parts.push(`${asks.length === 1 ? "an ask has" : `${asks.length} asks have`} waited ${minTxt(lim.pushMin ?? OWNER_PUSH_MIN)}+ min (${list(asks.map((a) => `#T${Number(a.num)}`))})`);
  return JSON.stringify({ title: "Flight board", body: parts.join(". ") + ".", url: "/", tag: "board" });
}
