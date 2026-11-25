// The board's state without a model (#C420): node collector/state.mjs --config <board.config.json> [--no-fetch] [--no-post]
// launchd runs it every minute from the owner's pinned copy (scripts/state-install.mjs writes the plist; condition A:
// a board release never changes it). It reads, on this machine only:
//   - each open card on the last board export (<stateDir>/<board>/mirror/initiatives): its branch tip from git, the
//     sign-off notes on it, whether it is on main and deployed (the phase rule below, phaseOf), and the CI run on it (gh);
//   - each roster role's newest session in the app (its session file: title, transcript id, last activity) and the last
//     TAIL_ENTRIES entries of its transcript: working or idle, the class of the last tool it called, and the card it is
//     on: only an exact board id (or #C<num> of a card on the board) found there leaves, never the text it was found in.
// It writes <stateDir>/<board>/state.json (0600) and POSTs the same to the state Worker with the board's token
// (<stateDir>/<board>/state-secrets/secrets.json, 0600 in a 0700 folder, made by the owner's install). What leaves is
// exactly collector/state-schema.mjs's allowlist. It prints one line, never a token, a path secret or transcript text.
// Beside it, <stateDir>/<board>/waiting-prompt.json (0600, never posted): { at, roles: { <role>: <since> }, tools:
// { <role>: <tool class> } }, the roles stopped on a prompt in their session (promptSince, promptTool), for the
// Collector's alarm (collector/prompt-alarm.mjs, #C526) and the watchdog (scripts/prompt-watch.mjs, #C529).
import { readFileSync, writeFileSync, renameSync, readdirSync, lstatSync, openSync, fstatSync, readSync, closeSync, realpathSync, readlinkSync, constants } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId, TASK_ID, MODEL_WORD, EFFORT_WORD } from "../scripts/config.mjs";
import { STATE_VERSION, stateErrors, pickState, toolClass, CARD_ID, CARD_ID_MAX, ROLE, MAX_BYTES, MAX_CARDS, MAX_RELEASES, PUBLISHED_FILE, STORE_CARDS_FILE } from "./state-schema.mjs";
import { shippedBase, fetchBranches } from "./after-ship.mjs";
import { boardIdOf, boardIdsOf, misplacedBoardId } from "./board-id.mjs";
import { readStack, stackFields, STACK_HOLD_FROM } from "./stack.mjs";
import { reviewsFromPaths, pathPhases } from "./review-paths.mjs";
import { countFindings } from "./findings-count.mjs";
import { pairsIn, packOf, isBoardRepo } from "./pairs.mjs";
import { isSignoff, isFindings, securityAlways, DESIGNER_REF, PAGE_DIR } from "./signoff.mjs";
import { wakePaths, readWakeFile, nextWakeFile, ALIVE_FILE, SEEN_FILE } from "../gate/wake.mjs";
import { NOEVIDENCE_FILE, evidenceAt, noEvidenceSince, DISPATCH_FILE, DISPATCH_STATE_FILE, dispatchItems } from "../gate/reset.mjs";
import { contextTokens, ctxReadings, resetAsks, stuckReadings, usageReading, wakeNeeds, askOnce, ownerAsks, askSince, boardTruth } from "./readings.mjs";
import { restartReading, ledgerReading, watchReading } from "./watch-readings.mjs";

// The folder this run's code lives in: the pinned copy <install root>/<full sha>, whose sha is the board's probe.
const CODE = dirname(dirname(fileURLToPath(import.meta.url)));
export const TAIL_ENTRIES = 20;
// A transcript's tail read at most (its last entries are what counts), and a session file at most.
const TAIL_BYTES = 1024 * 1024, SESSION_BYTES = 4 * 1024 * 1024;
// A turn whose transcript has been quiet this long is read as idle (a session closed mid-turn).
export const WORKING_QUIET_MS = 15 * 60e3;
// #C711: how long the Collector has been quiet, counted only inside its own schedule (8 am to 8 pm, Mountain time: the manager's
// word), so a night without runs is no outage. quietMinutes is the schedule's minutes between the last publish and now, over
// the last two days at most; the page's chip goes red past 75 of them (the task is hourly and its real gaps run up to 60m43s).
// America/Boise: the same offsets and summer-time dates as the Mountain zone the schedule is kept in.
export const SCHEDULE = { tz: "America/Boise", from: 8, to: 20 };
export const QUIET_LOOKBACK_MS = 48 * 3600e3;
const SCHEDULE_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: SCHEDULE.tz, hour: "numeric", hourCycle: "h23" });
export function quietMinutes(from, now) {
  if (!Number.isFinite(from) || !Number.isFinite(now) || from >= now) return 0;
  let n = 0;
  for (let t = Math.max(Math.floor(from / 60e3) * 60e3, Math.floor((now - QUIET_LOOKBACK_MS) / 60e3) * 60e3); t < now; t += 60e3) {
    const h = Number(SCHEDULE_HOUR.format(t));
    if (h >= SCHEDULE.from && h < SCHEDULE.to) n++;
  }
  return n;
}
// The marker the fence leaves (PUBLISHED_FILE: { at }); with none yet, the probe starts one now, so a Collector that never publishes
// after an install is counted from the install and not missed. Never throws: no reading leaves the key out of the state.
export function publishedReading(path, now, read = readTail, write = writeAtomic) {
  let at = null;
  try { const r = read(path, 4096); if (r?.whole) { const v = JSON.parse(r.text)?.at; if (Number.isInteger(v) && v >= 1577836800000 && v <= now + 60e3) at = Math.min(v, now); } } catch { /* none, or not ours */ }
  // The lower bound is the schema's time range: a smaller number would make buildState refuse the whole state (Security R2).
  if (at === null) { at = now; try { write(path, JSON.stringify({ at, baseline: true })); } catch { return null; } }
  return { at, quietMin: quietMinutes(at, now) };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const home = (p) => String(p).replace(/^~(?=\/|$)/, homedir());
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sha12 = (s) => (/^[0-9a-f]{40}$/.test(String(s ?? "")) ? s.slice(0, 12) : null);

// A regular file of this user's, read without following a link and without blocking on a fifo: its last `max` bytes
// (all of it when smaller) and whether that was the whole file; null when it isn't one.
export function readTail(path, max, uid = process.getuid()) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== uid) return null;
    const from = Math.max(0, st.size - max), buf = Buffer.alloc(st.size - from);
    let n = 0;
    while (n < buf.length) { const k = readSync(fd, buf, n, buf.length - n, from + n); if (!k) break; n += k; }
    return { text: buf.subarray(0, n).toString("utf8"), whole: from === 0, mtimeMs: st.mtimeMs };
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

// The app's sessions: <root>/<account>/<org>/local_<id>.json, each kept to { title, transcript, cwd, at } (an open one
// with a transcript id; nothing else of the file is kept).
// includeArchived (#C1006, Checker 2's F1): the schedule reading needs a task's newest run even after the app archived it (a task's runs get archived
// while it still runs and drifts); everything else leaves archived sessions out, as before.
export function appSessions(root, uid = process.getuid(), { includeArchived = false } = {}) {
  const out = [], dirs = (p) => { try { return readdirSync(p).filter((d) => UUID.test(d) && lstatSync(join(p, d)).isDirectory()); } catch { return []; } };
  for (const a of dirs(root)) for (const o of dirs(join(root, a))) {
    let files = [];
    try { files = readdirSync(join(root, a, o)).filter((f) => /^local_[0-9a-f-]{36}\.json$/.test(f)); } catch { continue; }
    for (const f of files) {
      const r = readTail(join(root, a, o, f), SESSION_BYTES, uid);
      if (!r?.whole) continue;
      let s;
      try { s = JSON.parse(r.text); } catch { continue; }
      if (!plain(s) || (s.isArchived === true && !includeArchived) || typeof s.title !== "string" || !UUID.test(String(s.cliSessionId ?? "")) || typeof s.cwd !== "string" || !s.cwd.startsWith("/")) continue;
      // #C970: from is the session that started this one (spawnedFrom.sessionId), when it is a session id; nothing else of spawnedFrom is kept.
      const from = typeof s.spawnedFrom?.sessionId === "string" && /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s.spawnedFrom.sessionId) ? s.spawnedFrom.sessionId : null;
      // #C1006: model (the model this session ran on) and scheduledTaskId (set on a scheduled task's run), each only when it is a plain word, else null.
      const word = (v, re) => (typeof v === "string" && re.test(v) ? v : null);
      out.push({ id: f.slice(0, -5), title: s.title, transcript: s.cliSessionId, cwd: s.cwd, at: Number.isFinite(s.lastActivityAt) ? Math.round(s.lastActivityAt) : null, from, model: word(s.model, MODEL_WORD), effort: word(s.effort, EFFORT_WORD), scheduledTaskId: word(s.scheduledTaskId, TASK_ID),
        // #C1122: the file's remoteControlUserEnabled is the only Remote Control key read, as a boolean: true only when it is exactly false (the switch turned off by hand, which the
        // live try of 11-16 showed it follows within 5 s both ways). Null or absent is unknown, never off (a session whose switch was never touched has none); steeredByRemoteClient is history, not read.
        rcOff: s.remoteControlUserEnabled === false });
    }
  }
  return out;
}

// A session's transcript: <home>/.claude/projects/<cwd, every character but a letter or digit as "-">/<id>.jsonl, a
// file that really sits there: neither it nor its folder a link out of the projects folder (Security).
export function transcriptPath(homeDir, cwd, id) {
  const root = join(homeDir, ".claude", "projects"), dir = join(root, String(cwd).replace(/[^A-Za-z0-9]/g, "-"));
  const p = join(dir, `${id}.jsonl`);
  try {
    const realDir = realpathSync(dir);
    if (!realDir.startsWith(realpathSync(root) + "/")) return null;
    return realpathSync(p) === join(realDir, `${id}.jsonl`) ? p : null;
  } catch { return null; }
}

// Its last TAIL_ENTRIES user and assistant entries, oldest first (a line cut by the tail's start is dropped).
export function lastEntries(tail) {
  const lines = String(tail?.text ?? "").split("\n");
  if (!tail?.whole) lines.shift();
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (plain(e) && (e.type === "user" || e.type === "assistant") && plain(e.message)) out.push(e);
  }
  return out.slice(-TAIL_ENTRIES);
}

const blocks = (e) => (Array.isArray(e.message.content) ? e.message.content.filter(plain) : []);
const timeOf = (e) => { const t = Date.parse(e?.timestamp ?? ""); return Number.isFinite(t) ? t : null; };
// A user entry the person (or another session) typed: not a tool's result coming back.
const isPrompt = (e) => e.type === "user" && (typeof e.message.content === "string" || !blocks(e).some((b) => b.type === "tool_result"));

// The card a session is on: the newest entry naming a card on the board, and in it the last such name (an exact id, or
// #C<num> of a card on the board). Only the id leaves; the text is read here and dropped.
// #C1311 (lead, not proven as the cause of the outlined tile): what a tool printed back (a git log, a test run, a board read) names whatever cards its
// text happens to hold, so a reviewer working on one card read as on another. A tool_result block is not read; the prompt, the agent's own words and its
// tool calls are.
const withoutResults = (content) => (Array.isArray(content) ? content.filter((b) => !(plain(b) && b.type === "tool_result")) : content);
export function cardIn(entries, ids, nums) {
  const known = [...ids].filter((id) => CARD_ID.test(id) && id.length <= CARD_ID_MAX).sort((a, b) => b.length - a.length);
  const re = new RegExp(`${known.length ? `(?<![A-Za-z0-9-])(${known.join("|")})(?![A-Za-z0-9-])|` : ""}#C(\\d{1,6})(?!\\d)`, "g");
  for (let k = entries.length - 1; k >= 0; k--) {
    let text = "";
    try { text = JSON.stringify(withoutResults(entries[k].message.content) ?? ""); } catch { continue; }
    let last = null;
    for (const m of text.matchAll(re)) {
      const id = m[1] ?? nums.get(Number(m[2]));
      // #C960: a card the probe cannot read (an id over CARD_ID, which the store once took) is never an agent's card, whether named by id or by #C<num>:
      // the schema refuses the whole state for one such id, and no card's reading was rewritten for an hour.
      if (id && CARD_ID.test(id) && id.length <= CARD_ID_MAX) last = id;
    }
    if (last) return last;
  }
  return null;
}

// #C1427 (11-24: a session that works several cards at once, Release shipping a candidate that carries four, read working only on the newest one it named): the cards a session is on, newest first,
// each named (as cardIn names one) in the prompt, the agent's own words or its tool calls of the current turn: the entries since the last prompt a person or another session typed (a task
// notification is no prompt: the turn it wakes is the same work). Only when two or more are named: one card is `card` alone. At most SESSION_CARDS, so a session that lists the board names no crowd.
export const SESSION_CARDS = 6;
const isNotice = (e) => e.type === "user" && typeof e.message.content === "string" && e.message.content.startsWith("<task-notification>");
export function cardsIn(entries, ids, nums) {
  const known = [...ids].filter((id) => CARD_ID.test(id) && id.length <= CARD_ID_MAX).sort((a, b) => b.length - a.length);
  const re = new RegExp(`${known.length ? `(?<![A-Za-z0-9-])(${known.join("|")})(?![A-Za-z0-9-])|` : ""}#C(\\d{1,6})(?!\\d)`, "g");
  const start = Math.max(0, entries.findLastIndex((e) => isPrompt(e) && !isNotice(e)));
  const out = [];
  for (let k = entries.length - 1; k >= start && out.length < SESSION_CARDS; k--) {
    let text = "";
    try { text = JSON.stringify(withoutResults(entries[k].message.content) ?? ""); } catch { continue; }
    const named = [];
    for (const m of text.matchAll(re)) {
      const id = m[1] ?? nums.get(Number(m[2]));
      if (id && CARD_ID.test(id) && id.length <= CARD_ID_MAX && !named.includes(id)) named.push(id);
    }
    for (const id of named.reverse()) if (!out.includes(id) && out.length < SESSION_CARDS) out.push(id);
  }
  return out.length > 1 ? out : [];
}

// A turn stopped on a call the person must answer (#C526: Mainsite's site approval sat from 05:50Z to 15:49Z, read as
// idle): mid-turn and quiet over WORKING_QUIET_MS, with a tool call since the last prompt that has no result. A subagent
// call (Agent) may run that long on its own, so it never counts. The first such call ({ b, e }), else null.
function waitingCall(entries, { mtimeMs, now }) {
  const last = entries.at(-1);
  if (!last || now - mtimeMs <= WORKING_QUIET_MS) return null;
  if (!(last.type === "user" || (last.type === "assistant" && last.message.stop_reason === "tool_use"))) return null;
  const turn = entries.slice(entries.findLastIndex(isPrompt) + 1);
  const answered = new Set(turn.filter((e) => e.type === "user").flatMap((e) => blocks(e).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id)));
  const open = turn.filter((e) => e.type === "assistant").flatMap((e) => blocks(e).filter((b) => b.type === "tool_use" && !answered.has(b.id)).map((b) => ({ b, e })));
  if (!open.length || open.some(({ b }) => toolClass(b.name) === "Agent")) return null;
  return open[0];
}
// Its time, else null.
export function promptSince(entries, opts) {
  const w = waitingCall(entries, opts);
  return w ? timeOf(w.e) : null;
}
// Its tool's class (#C529: the push names what the prompt is; toolClass's enum, never the call's input), else null.
export function promptTool(entries, opts) {
  const w = waitingCall(entries, opts);
  return w ? toolClass(w.b.name) : null;
}

// #C1423 (the owner, 11-24: #C1421 read "waits for Checker" while Checker's npm test ran): a turn that ends with a background command still running
// (a Bash call with input.run_in_background true, whose tool-use id no <task-notification> has named yet) is the session's work going on, not an idle
// session, for up to WORKING_QUIET_MS from the call. The dispatch watch is a background command that runs for hours by design, so it never counts.
// Checker 2's F1 on 23644dc6: a notification that arrives WHILE the turn runs is not a user entry in the transcript: it is {"type":"queue-operation","operation":"enqueue","content":"<task-notification>..."} and
// {"type":"attachment","attachment":{"type":"queued_command","prompt":"<task-notification>..."}}, which lastEntries drops. noticeIds reads those lines (and the user entry of a notification that woke an idle
// turn) from the tail itself, and backgroundRun takes the set, so a finished run is no longer work.
const NOTIFIED = /<tool-use-id>([^<]{1,100})<\/tool-use-id>/g;
const noticeOf = (e) => {
  if (!plain(e)) return "";
  if (e.type === "queue-operation") return typeof e.content === "string" ? e.content : "";
  if (e.type === "attachment") return plain(e.attachment) && e.attachment.type === "queued_command" && typeof e.attachment.prompt === "string" ? e.attachment.prompt : "";
  if (e.type === "user") { try { return JSON.stringify(plain(e.message) ? e.message.content ?? "" : ""); } catch { return ""; } }
  return "";
};
const noticedIn = (text, into) => { if (text.includes("<task-notification>")) for (const m of text.matchAll(NOTIFIED)) into.add(m[1]); return into; };
export function noticeIds(tail) {
  const out = new Set(), text = String(tail?.text ?? "");
  if (!text.includes("<task-notification>")) return out;
  for (const l of text.split("\n")) {
    if (!l.includes("<task-notification>")) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    noticedIn(noticeOf(e), out);
  }
  return out;
}
export function backgroundRun(entries, { now, notified: seen = null }) {
  const notified = new Set(seen ?? []);
  const calls = [];
  for (const e of entries) {
    if (e.type === "user") noticedIn(noticeOf(e), notified);
    else if (e.type === "assistant") {
      for (const b of blocks(e)) {
        const i = b.input;
        if (b.type === "tool_use" && b.name === "Bash" && typeof b.id === "string" && plain(i) && i.run_in_background === true && !String(i.command ?? "").includes("wake-watch.mjs")) calls.push({ id: b.id, at: timeOf(e) });
      }
    }
  }
  return calls.some((c) => !notified.has(c.id) && Number.isFinite(c.at) && now - c.at <= WORKING_QUIET_MS && c.at <= now);
}

// One role's activity from its transcript's last entries: { state, tool, card, since, prompt, promptTool } (prompt:
// promptSince's time, promptTool its class; they stay on this machine, never in the state that leaves).
export function activity(entries, { mtimeMs, now, ids, nums, notified = null }) {
  const last = entries.at(-1);
  if (!last) return { state: "unknown", tool: null, card: null, since: null, prompt: null, promptTool: null, tokens: null };
  const midTurn = last.type === "user" || (last.type === "assistant" && last.message.stop_reason === "tool_use");
  const state = (midTurn && now - mtimeMs <= WORKING_QUIET_MS) || backgroundRun(entries, { now, notified }) ? "working" : "idle";
  let tool = null;
  for (let k = entries.length - 1; k >= 0 && !tool; k--) if (entries[k].type === "assistant") tool = toolClass(blocks(entries[k]).filter((b) => b.type === "tool_use").at(-1)?.name);
  const since = state === "working" ? timeOf(entries.findLast(isPrompt)) : timeOf(entries.findLast((e) => e.type === "assistant"));
  const cards = cardsIn(entries, ids, nums);
  return { state, tool, card: cardIn(entries, ids, nums), ...(cards.length ? { cards } : {}), since, prompt: promptSince(entries, { mtimeMs, now }), promptTool: promptTool(entries, { mtimeMs, now }), tokens: contextTokens(entries) };
}

// Every roster role's agent, from the session whose id the config holds for it (sessionIds, #C633), never from a recency
// list; a role with no id there is found by its newest open session titled exactly as the role and marked by: "title". A
// role whose id is set but is not among the open sessions has no agent. prompts, when given, gets each
// role stopped on a prompt and since when (promptSince), and tools, when given, that prompt's tool class (promptTool):
// the local waiting-prompt.json, not the state.
// #C970 (the owner, 11-12: the tiles did not show Checker 2): besides the roster, every open session started by spawnedBy (the lead's session id: sessions
// the lead started, not archived) is an agent too when its title is a roster role name plus optional digits ("Checker 2" is "Checker2"; any
// other title is ignored, so no free text becomes a key), marked by: "spawn", so a new role shows up by itself. A roster role keeps its own rule above; two spawned sessions with the
// same name give the newest.
export function agentStates({ roles, sessions, homeDir, now, ids, nums, uid = process.getuid(), prompts = null, tools = null, tokens = null, sessionIds = {}, spawnedBy = null }) {
  const out = {};
  const read = (role, s, by) => {
    const p = transcriptPath(homeDir, s.cwd, s.transcript);
    const tail = p ? readTail(p, TAIL_BYTES, uid) : null;
    const a = tail ? activity(lastEntries(tail), { mtimeMs: tail.mtimeMs, now, ids, nums, notified: noticeIds(tail) }) : { state: "unknown", tool: null, card: null, since: null };
    out[role] = { state: a.state, lastActivityAt: s.at, tool: a.tool, card: a.card, ...(a.cards ? { cards: a.cards } : {}), since: a.since, ...(by ? { by } : {}), ...(s.rcOff === true ? { rcOff: true } : {}) };
    if (prompts && a.prompt != null) prompts[role] = a.prompt;
    if (tools && a.promptTool != null) tools[role] = a.promptTool;
    if (tokens && a.tokens != null) tokens[role] = a.tokens;
  };
  const named = roles.filter((r) => ROLE.test(r));
  for (const role of named) {
    const byId = Object.hasOwn(sessionIds, role) && sessionIds[role];
    const s = byId ? sessions.find((x) => x.id === byId) : sessions.filter((x) => x.title === role).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
    if (!s) continue;
    read(role, s, byId ? null : "title");
  }
  if (typeof spawnedBy === "string" && spawnedBy) {
    for (const s of sessions.filter((x) => x.from === spawnedBy).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
      // Checker's finding on 6c7f684c: a free-text title must not become a key (it would leave the Mac). Only a roster role name, then optional
      // digits, with spaces between them allowed ("Checker2" and "Checker 2" are both the agent "Checker 2", as the roster and the store name it, #C1117), is taken; any other title is ignored.
      const m = /^([A-Za-z]+)\s*(\d*)$/.exec(String(s.title));
      const role = m && named.includes(m[1]) ? (m[2] ? `${m[1]} ${m[2]}` : m[1]) : null;
      if (!role || !ROLE.test(role) || named.includes(role) || Object.hasOwn(out, role)) continue;
      read(role, s, "spawn");
    }
  }
  return out;
}

// The phase rule (headsFor, reviewsFor, phaseOf below, with repoOf and closed): this file is pinned (condition A) and moves with
// the probe, so it is the one place the rule lives (#C1388: collector/derive.mjs's second copy is gone). repoOf and closed
// are still copied in derive.mjs for collector/expected.mjs.
export const closed = (card) => card.status === "done" || card.status === "dropped";
// #C697, #C701: the cards as the board has them now. #C999: the store's cards, which the evidence job writes each run to
// <stateDir>/<id>/store-cards.json (collector/store-cards.mjs); nothing of the old board's own files is read.
export function readStoreCards(stateDir, id) {
  try { const r = readTail(join(stateDir, id, STORE_CARDS_FILE), 4 * 1024 * 1024); if (r?.whole) { const d = JSON.parse(r.text); if (plain(d) && plain(d.cards)) return { at: Number.isFinite(d.at) ? d.at : 0, cards: d.cards }; } } catch { /* none yet */ }
  return { at: 0, cards: {} };
}
export function liveCards(stateDir, id) {
  return Object.entries(readStoreCards(stateDir, id).cards).filter(([, d]) => plain(d)).map(([cid, d]) => ({ ...d, id: cid }));
}
export { boardIdOf }; // #C1166: git's last-paragraph reading, one file for every reader (collector/board-id.mjs)
// #C985: a repo word that names no listed repository is read as no word (derive.mjs keeps a copy of namedRepo and repoOf for collector/expected.mjs).
export const namedRepo = (card, config) => (card.repo ? (config.collector.repos ?? []).find((r) => r.name === card.repo) ?? null : null);
export function repoOf(card, config) {
  const repos = config.collector.repos ?? [];
  return namedRepo(card, config) ?? repos.find((r) => (r.idPrefixes ?? []).some((p) => String(card.id).startsWith(p))) ?? null;
}
// #C649: a commit whose message starts "#C<num>:" belongs to the card with that number too (num, when the card has one), so a card
// worked on without its Board-Id trailer or a branch named for it still has a head: the board then shows it as build.
// #C1204: "#C<num> (<Role>):" is read the same way, and a branch whose last segment starts "c<num>-" names the card by number.
export const subjectNum = (message) => { const m = /^#C(\d{1,6})(?::| \()/.exec(String(message ?? "")); return m ? Number(m[1]) : null; };
export const branchNum = (branch) => { const m = /^c(\d{1,6})-/.exec(String(branch ?? "").split("/").pop()); return m ? Number(m[1]) : null; };
const namesCard = (card, branch) => String(branch).split("/").pop() === card.id || (Number.isInteger(card.num) && branchNum(branch) === card.num);
// #C671 (done-when 2): a branch named for the card (its last path segment is the card's id) whose tip carries neither the card's
// Board-Id trailer nor its "#C<num>:" subject: the name alone found it. When that tip is also on main it is a branch pushed
// before any commit, and it shows the card as being worked (build), never as shipped or live.
const isTimeMs = (v) => Number.isInteger(v) && v >= 1577836800000 && v <= 4102444800000; // #C1377
// #C1377 (Checker 2's F2 on 69f0c5d3: this sat in the entry block, so no test ran it): each repository's last fresh read, kept from run to run. `repos` is { name: { fresh } } and
// each gets freshAt set: now when it was read fresh this run; otherwise the stamp it had (`before`, read from repo-fresh.json), never the new time, and none when it never had one
// or the stamp is not a real past time (a future stamp is dropped). Returns the map to write: { name: ms } for the repositories with a stamp.
export function repoFreshAt(repos, before, now) {
  const out = {};
  for (const [name, r] of Object.entries(repos ?? {})) {
    const prev = isTimeMs(before?.[name]) && before[name] <= now ? before[name] : null;
    r.freshAt = r.fresh === false ? prev : now;
    if (r.freshAt !== null) out[name] = r.freshAt;
  }
  return out;
}
export function bareBranch(card, head) {
  if (!head || head.afterShip || head.shipped || !namesCard(card, head.branch)) return false;
  return boardIdOf(head.message) !== card.id && !(Number.isInteger(card.num) && subjectNum(head.message) === card.num);
}
// #C1204 (Checker 2's M1): a head found only by its branch's number, whose tip is not this card's own commit, is work started (build) with no sign-offs.
export function byNumberOnly(card, head) {
  return !!head && Number.isInteger(card.num) && String(head.branch).split("/").pop() !== card.id && branchNum(head.branch) === card.num && boardIdOf(head.message) !== card.id && subjectNum(head.message) !== card.num;
}
// #C1325 (11-19 night, twice: the dispatch said "nothing pushed" for a card whose only branch was <id>-v3 or -v4): a re-cut branch is named <id>-v<N> (the collector follows only
// -vN, branchFamily), so the last part of a branch name names the card with or without that suffix. A tip whose commit has no usable Board-Id trailer is still found this way.
export const slugOfBranch = (branch) => String(branch).split("/").pop().replace(/-v\d{1,3}$/, "");
export function headsFor(id, heads, num = null) {
  const tips = new Map();
  for (const h of heads) {
    if (boardIdOf(h.message) !== id && String(h.branch).split("/").pop() !== id && slugOfBranch(h.branch) !== id && !(Number.isInteger(num) && (subjectNum(h.message) === num || branchNum(h.branch) === num))) continue;
    const had = tips.get(h.branch);
    if (!had || (h.at ?? 0) > (had.at ?? 0)) tips.set(h.branch, h);
  }
  return [...tips.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}
function reviewsFor(card, config) {
  const skip = new Set(Array.isArray(card.skip) ? card.skip : []);
  for (const k of config.skips ?? []) {
    if (k.unlessLevel && card.level && card.level !== k.unlessLevel) skip.add(k.phase);
    if (k.whenFalse && card[k.whenFalse] === false) skip.add(k.phase);
    if (k.unlessTrue && card[k.unlessTrue] !== true) skip.add(k.phase);
  }
  return Object.keys(config.collector.notes).filter((p) => !skip.has(p));
}
// The phase a card reads (the one phase rule): null when the card has no head.
export function phaseOf(card, facts, config) {
  const c = config.collector;
  if (!facts.head) return null;
  if (facts.onMain && bareBranch(card, facts.head)) return c.buildPhase;
  if (facts.onMain) return facts.deployed ? c.livePhase : c.shipPhase;
  if (boardIdOf(facts.head.message) !== card.id && facts.signed.size === 0) return c.buildPhase;
  const order = config.phases.map((p) => p[0]);
  const waiting = (Array.isArray(facts.needs) ? facts.needs : reviewsFor(card, config)).filter((p) => !facts.signed.has(p)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return waiting[0] ?? c.shipPhase;
}

// A repository as the cards read it: git(args) and gh(args) in its clone, its remote, main branch, sign-off notes and
// the commit live there (the deploy run's for the team's, the installed link's for another).
// #C1160: the word WIP at the start of a commit's first line, or right after one card token ("#C1128 WIP", "1128 WIP", "rc-field-after-clear WIP"), as gate/first-push.mjs tells builders to write it.
const WIP_START = /^(?:(?:#?C?\d+|[a-z0-9]+(?:-[a-z0-9]+)+)\s+)?WIP\b/;
// #C1133: git's answer to "is A an ancestor of B" in three values: true (exit 0), false (exit 1: it is not) and null (ANY other failure: a timeout, a spawn error, git's own
// error 128 under load). `ok` folds the third into "no", which read a cited part as present-or-absent by luck; a caller of this one must say what unknown means.
const ancestry = (fn) => { try { fn(); return true; } catch (e) { return e?.status === 1 ? false : null; } };
export function remoteTips(git, remote) {
  const out = git(["for-each-ref", `refs/remotes/${remote}`, "--format=%(refname:lstrip=3)%1f%(objectname)%1f%(committerdate:unix)%1f%(contents)%1e"]);
  return out.split("\x1e").map((r) => r.replace(/^\n/, "")).filter((r) => r.includes("\x1f")).map((r) => {
    const [branch, sha, at, message] = r.split("\x1f");
    return { branch, sha, at: Number(at) * 1000, message };
  }).filter((h) => h.branch && h.branch !== "HEAD");
}

// The CI run on a commit: { ci, ciMin }, from gh's newest run on it.
// #C1395: "none" is only "no run exists on the commit" (gh answered, with no run); a call that FAILED is "unread" (failed: true), never "none". The reader below adds "backoff" (a call not made: the back-off)
// and "capped" (a call not made: the call limit), so the four reasons for no run to show are four words.
export function ciOf(gh, sha, now) {
  let runs = [];
  try { runs = JSON.parse(gh(["run", "list", "--commit", sha, "--limit", "1", "--json", "status,conclusion,createdAt,updatedAt"])); } catch { return { ci: "unread", ciMin: null, failed: true }; }
  return ciFromRun(Array.isArray(runs) ? runs[0] : null, now);
}
// The { ci, ciMin } of one run object (gh's status, conclusion, createdAt, updatedAt); none for anything that is not a run.
export function ciFromRun(r, now) {
  if (!plain(r)) return { ci: "none", ciMin: null };
  const status = String(r.status ?? ""), conclusion = String(r.conclusion ?? "");
  const ci = status === "completed" ? (conclusion === "success" ? "passed" : ["cancelled", "skipped", "neutral"].includes(conclusion) ? "cancelled" : "failed") : status === "in_progress" ? "running" : "queued";
  const from = Date.parse(r.createdAt ?? ""), to = ci === "running" || ci === "queued" ? now : Date.parse(r.updatedAt ?? "");
  const min = Number.isFinite(from) && Number.isFinite(to) ? Math.round((to - from) / 60e3) : null;
  return { ci, ciMin: Number.isInteger(min) && min >= 0 && min <= 10000 ? min : null };
}

// GitHub's API allows 5,000 calls an hour, shared with every agent's gh: a finished run never changes, so it is kept by
// commit (cache: { sha: { ci, ciMin } }, saved by the caller), and a run asks gh at most MAX_CI_CALLS times; a card past
// that shows no CI this minute (Checker, #C420).
export const MAX_CI_CALLS = 10;
// A cached entry counts only as exactly a finished { ci, ciMin }, and only those two leave it (Security: a bad entry must
// neither override a card's other fields nor stop every run); anything else is asked again.
const FINISHED = ["passed", "failed", "cancelled"];
export const ciEntry = (v) => (v && FINISHED.includes(v.ci) && (v.ciMin === null || (Number.isInteger(v.ciMin) && v.ciMin >= 0 && v.ciMin <= 10000)) ? { ci: v.ci, ciMin: v.ciMin } : null);
// Back-off (#C591): a gh call that fails (GitHub's rate limit answers an error, and gh's stderr is not read here) stops
// every gh call until backoff.until, then tries again; each failure in a row doubles the wait, from BACKOFF_MIN_MS to
// BACKOFF_MAX_MS, and one success clears it. backoff: { until, wait }, kept from run to run by the caller.
export const BACKOFF_MIN_MS = 60e3, BACKOFF_MAX_MS = 30 * 60e3;
const wholeMs = (v) => (Number.isInteger(v) && v >= 0 && v <= 4102444800000 ? v : 0);
export const backoffOf = (v) => ({ until: wholeMs(v?.until), wait: Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, wholeMs(v?.wait))) });
// #C996 part 3: with `batch`, the first card that needs a run reading asks gh ONCE for the repository's newest CI_BATCH_LIMIT runs (all workflows) and
// every commit among them is read from that list (its newest run, as `--limit 1` on the commit gives); a commit not in the list is asked alone, as
// before, and counts against MAX_CI_CALLS. A failed list is a failed call: the back-off starts and no card gets a reading this run. A run whose
// cards are all cached asks nothing. Off by default: only the probe's own repository read turns it on.
export const CI_BATCH_LIMIT = 100;
export function ciReader(gh, now, cache, backoff = { until: 0, wait: BACKOFF_MIN_MS }, { batch = false } = {}) {
  let calls = 0, listed = null;
  const fail = () => { backoff.until = now + backoff.wait; backoff.wait = Math.min(BACKOFF_MAX_MS, backoff.wait * 2); };
  const list = () => {
    if (listed) return listed;
    calls++;
    let runs;
    try { runs = JSON.parse(gh(["run", "list", "--limit", String(CI_BATCH_LIMIT), "--json", "headSha,status,conclusion,createdAt,updatedAt"])); } catch { fail(); return (listed = { failed: true, by: new Map() }); }
    const by = new Map();
    if (Array.isArray(runs)) for (const r of runs) if (plain(r) && /^[0-9a-f]{40}$/.test(String(r.headSha)) && !by.has(r.headSha)) by.set(r.headSha, r);
    backoff.until = 0; backoff.wait = BACKOFF_MIN_MS;
    return (listed = { failed: false, by });
  };
  return (sha) => {
    const kept = ciEntry(cache[sha]);
    if (kept) return kept;
    if (now < backoff.until) return { ci: "backoff", ciMin: null };
    if (batch) {
      if (!listed && calls >= MAX_CI_CALLS) return { ci: "capped", ciMin: null };
      const l = list();
      if (l.failed) return { ci: "unread", ciMin: null };
      const run = l.by.get(sha);
      if (run) {
        const r = ciFromRun(run, now);
        if (FINISHED.includes(r.ci)) cache[sha] = { ci: r.ci, ciMin: r.ciMin };
        return { ci: r.ci, ciMin: r.ciMin };
      }
    }
    if (calls >= MAX_CI_CALLS) return { ci: "capped", ciMin: null };
    calls++;
    const r = ciOf(gh, sha, now);
    if (r.failed) { backoff.until = now + backoff.wait; backoff.wait = Math.min(BACKOFF_MAX_MS, backoff.wait * 2); }
    else { backoff.until = 0; backoff.wait = BACKOFF_MIN_MS; }
    if (FINISHED.includes(r.ci)) cache[sha] = { ci: r.ci, ciMin: r.ciMin };
    return { ci: r.ci, ciMin: r.ciMin };
  };
}

// #C617: the ship runs on now, from GitHub's own runs. A ship run is titled "vX.Y.Z: <branch>@<sha>[, <branch>@<sha> ...]": a ship
// combines every signed branch, and GitHub cuts a long title with "…" (a branch may keep only a short sha, the last may lose its
// end). Every "branch@sha" pair is read from the title, the cut ones too; and when the repository's shippedPattern is set the same
// pairs are read, whole, from the run's own commit subjects (git log -5 of its head sha, as the Collector's shipping() does for the
// candidate branch), so a cut title doesn't hide a branch. Only the branch and the sha ever matter (they pick the card; nothing of
// a title leaves). One gh call a minute, in a back-off of its own. null when gh can't be asked (the cards then say nothing of
// shipping, never "not shipping").
const SHIP_HEAD = /^v\d{1,4}\.\d{1,4}\.\d{1,4}: (.+)$/;
const SHIP_PAIR = /^([A-Za-z0-9._/-]{1,100})[@＠]([0-9a-f]{4,40})…?$/;
export const SHIP_TITLE = SHIP_HEAD;
export function shipTitlePairs(title) {
  const m = SHIP_HEAD.exec(String(title ?? ""));
  if (!m) return [];
  return m[1].split(/,\s*/).map((p) => SHIP_PAIR.exec(p.trim())).filter(Boolean).map((p) => ({ branch: p[1], sha: p[2] }));
}
const RUNNING = ["in_progress", "queued", "waiting", "pending", "requested"];
export function shipRuns(gh, now, backoff = { until: 0, wait: BACKOFF_MIN_MS }, { git = null, shippedPattern = "" } = {}) {
  if (now < backoff.until) return null;
  let runs;
  try { runs = JSON.parse(gh(["run", "list", "--limit", "30", "--json", "status,displayTitle,headSha"])); } catch { backoff.until = now + backoff.wait; backoff.wait = Math.min(BACKOFF_MAX_MS, backoff.wait * 2); return null; }
  if (!Array.isArray(runs)) return null;
  backoff.until = 0; backoff.wait = BACKOFF_MIN_MS;
  const out = [];
  for (const r of runs.filter((x) => plain(x) && RUNNING.includes(String(x.status)) && SHIP_HEAD.test(String(x.displayTitle ?? "")))) {
    out.push(...shipTitlePairs(r.displayTitle));
    out.push(...commitPairs(git, r.headSha, shippedPattern));
  }
  return out;
}
// The "branch@sha" pairs a ship commit's own subjects name (git log -5, the repository's shippedPattern), whole; none when it can't be read.
export function commitPairs(git, sha, shippedPattern) {
  const out = [];
  if (git && shippedPattern && /^[0-9a-f]{40}$/.test(String(sha ?? ""))) {
    try {
      const re = new RegExp(shippedPattern, "g");
      for (const s of git(["log", "-5", "--format=%s", sha]).split("\n")) for (const m of s.matchAll(re)) if (m[1] && /^[0-9a-f]{7,40}$/.test(m[2] ?? "")) out.push({ branch: m[1], sha: m[2] });
    } catch { /* the title's pairs stand */ }
  }
  return out;
}
// #C1426: the commits of the deploy runs on now (the repository's deployWorkflow on main: in progress, queued, waiting), from GitHub's own runs. A landed card whose commit is inside one of them is
// being deployed: a ship in progress, Release's work with no session on it. null when gh can't be asked (a card then says nothing of it, never "not deploying").
export function deployRuns(gh, workflow, now, backoff = { until: 0, wait: BACKOFF_MIN_MS }, main = "main") {
  if (!workflow || now < backoff.until) return null;
  let runs;
  try { runs = JSON.parse(gh(["run", "list", "--branch", main, "--workflow", workflow, "--limit", "5", "--json", "status,headSha"])); } catch { backoff.until = now + backoff.wait; backoff.wait = Math.min(BACKOFF_MAX_MS, backoff.wait * 2); return null; }
  if (!Array.isArray(runs)) return null;
  backoff.until = 0; backoff.wait = BACKOFF_MIN_MS;
  return runs.filter((x) => plain(x) && RUNNING.includes(String(x.status)) && /^[0-9a-f]{40}$/.test(String(x.headSha ?? ""))).map((x) => x.headSha);
}
// Whether a ship run is for this card's tip: its branch is the tip's, whole ("admin/x" and "build/x" are two cards), or its sha
// (7 characters at least: a cut title's short sha alone names nothing) starts the tip or the head.
export const shipsCard = (ships, tip, head) => ships.some((s) => s.branch === tip.branch || (s.sha.length >= 7 && (tip.sha.startsWith(s.sha) || head.sha.startsWith(s.sha))));

// #C679: a ship candidate in flight. Release pushes a candidate branch (collector.candidatePattern, "build/ship-v1.2.3") and its CI
// run merges the cards and deploys: from the push to the merge a restart cuts the ship (2026-11-04: the badge was green while
// v1.200.6 waited on CI, the owner restarted, and the ship died). The page's cards see a ship only through an open card a running
// run's title names, which misses a candidate whose cards are closed or whose queued run's title doesn't match. So the candidate
// itself is read: the newest remote tip matching the pattern that is not on main yet, under SHIP_CANDIDATE_MAX_MS old (an old one
// stays on GitHub after a red run), whose CI run is not finished badly (failed or cancelled: the ship is over). { version, ci,
// at } or null. A CI read that can't be made (back-off, the call limit) is "none": the candidate still counts, never a green badge.
export const SHIP_CANDIDATE_MAX_MS = 6 * 3600e3;
// #C1395: the CI words a candidate can carry (a copy of SHIP_CI in collector/state-schema.mjs, which this pinned file does not import; a test holds the two equal).
const SHIP_CI_STATES = ["none", "backoff", "capped", "unread", "queued", "running", "passed"];
// #C1038 (2026-11-12: the badge read "Ship v1.210.5 CI running" after v1.210.5 was live and its CI on main green): the merge does not make
// the candidate's tip an ancestor of main, and the board holds no ship record to close it by. So main's own deploy closes it: the commit
// of main's newest successful deploy run (repos[""].live) is read back along its first parents, and a candidate whose version that
// history names (shipped(version): versionsOn) is over, whatever its own run reads. No deploy run read: the candidate stands.
export const SHIPPED_LOOKBACK = 100;
export function versionsOn(git, ref, pattern) {
  const out = new Set();
  try {
    const re = new RegExp(pattern);
    for (const s of git(["log", "--first-parent", `--max-count=${SHIPPED_LOOKBACK}`, "--format=%s", ref]).split("\n")) {
      const m = re.exec(s), v = m ? m[1] ?? m[0] : null;
      if (v && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v)) out.add(v);
    }
  } catch { /* no reading: the candidate stands */ }
  return out;
}
// The run's reading of the candidate, from the team's repository ({ git, remote, main, tips, ci, live }) and the collector config: the merge
// check against main, the CI reader, and (#C1038) main's deployed history read lazily, once, for the shipped check. Exported so a test drives
// the wiring itself.
// #C1426: the candidate is read ONCE a run (its CI is a gh call): the cards' ships list takes the cards it carries (candidateShips) and the state's ship tile takes the reading (teamShip).
const SHIP_READ = new WeakMap();
export function teamShip(team, c, now) { return teamShipRead(team, c, now).ship; }
// The pairs of "branch@sha" the open candidate's commit subjects name, [] with no candidate: each is a card in flight in the ship (shipsCard reads them like a run's title).
export function candidateShips(team, c, now) {
  const { sha } = teamShipRead(team, c, now);
  return sha ? commitPairs(team.git, sha, c.shippedPattern) : [];
}
// The team repository's reads of a ship in flight, put on it for the cards' reading: the candidate's cards join its ship-run list (only when that list was read: a list that could not be is not made up),
// and the deploy runs on main are listed (null: not read). A failure here leaves the lists as they were.
export function addShipReads(team, c, now, gh, backoff) {
  if (c.candidatePattern && Array.isArray(team.ships)) { try { team.ships = [...team.ships, ...candidateShips(team, c, now)]; } catch { /* the run titles' list stands */ } }
  if (c.deployWorkflow) { try { team.deploying = deployRuns(gh, c.deployWorkflow, now, backoff, c.mainBranch ?? team.main); } catch { team.deploying = null; } }
  return team;
}
function teamShipRead(team, c, now) {
  const hit = SHIP_READ.get(team);
  if (hit && hit.now === now && hit.c === c) return hit.out;
  const note = {}, ship = teamShipOnce(team, c, now, note), out = { ship, sha: ship ? note.sha ?? null : null };
  SHIP_READ.set(team, { now, c, out });
  return out;
}
function teamShipOnce(team, c, now, note) {
  let shippedSet = null;
  // #C1377 (Manager: the card's own example, the ship tile's "CI running" an hour after v1.226.22 was live): a candidate read from a repository that was not read fresh this run is marked
  // stale, with the time of its last good read, as the cards are; the badge says so instead of reading current.
  const marked = (r) => (r && team.fresh === false ? { ...r, stale: true, ...(isTimeMs(team.freshAt) ? { staleSince: team.freshAt } : {}) } : r);
  return marked(shipCandidate({ tips: team.tips, pattern: c.candidatePattern, now, onMain: (sha) => ancestry(() => team.git(["merge-base", "--is-ancestor", sha, `${team.remote}/${team.main}`])), ci: team.ci, note,
    shipped: (v) => { if (!c.versionPattern || !team.live) return false; shippedSet ??= versionsOn(team.git, team.live, c.versionPattern); return shippedSet.has(v); } }));
}
// #C1426: `note` (optional) gets sha = the candidate's tip when one is returned, so the cards it carries can be read from its commit subjects.
export function shipCandidate({ tips, pattern, now, onMain, ci, shipped = () => false, note = null }) {
  if (!pattern) return null;
  let re;
  try { re = new RegExp(pattern); } catch { return null; }
  const found = (tips ?? []).filter((t) => t && typeof t.branch === "string" && re.test(t.branch) && /^[0-9a-f]{40}$/.test(String(t.sha)) && Number.isFinite(t.at) && now - t.at <= SHIP_CANDIDATE_MAX_MS && t.at - now <= 60e3)
    .sort((a, b) => b.at - a.at).slice(0, 3);
  for (const t of found) {
    // #C1395: onMain answers true, false (git's exit 1) or null (the call FAILED): a failed read is not "not on main", but the candidate still stands (never a green badge) and says it has no fresh reading.
    const placed = onMain(t.sha);
    if (placed) continue;
    const m = /v(\d{1,4}\.\d{1,4}\.\d{1,4})/.exec(t.branch);
    if (m && shipped(m[1])) continue;
    // #C1395: the CI word is one of SHIP_CI_STATES (none: no run exists; backoff, capped: no call was made; unread: the call failed); an answer that is none of them is "unread", never "none".
    const r = ci(t.sha), state = r && SHIP_CI_STATES.includes(r.ci) ? r.ci : r && (r.ci === "failed" || r.ci === "cancelled") ? r.ci : "unread";
    if (state === "failed" || state === "cancelled") continue;
    if (note) note.sha = t.sha;
    return { version: m ? m[1] : null, ci: state, at: t.at, ...(placed === null ? { stale: true } : {}) };
  }
  return null;
}

// The version a commit went live in: the first subject naming one (versionPattern), from the commit itself on along
// the main line's first parents that descend from it.
// #C1376: `git log --first-parent --ancestry-path sha..ref` answers nothing for a commit that reached main INSIDE a group (under the head main merged): with
// --first-parent the ancestry-path is judged along the first-parent line only, which the commit is not on (#C1315, #C1320 to #C1323, #C1333, #C1224). So the two are asked
// apart: the main line's first-parent commits after sha, oldest first, and the set of commits that descend from sha; the first main-line commit in that set is the first one that
// contains it. A commit main took directly gives what it gave before.
// #C1387: `note` (optional) gets failed = true when a git call FAILED (no version found is null with failed false; a failed read is null with failed true).
function versionAfter(git, sha, ref, pattern, note = null) {
  try {
    const re = new RegExp(pattern);
    const descends = new Set(git(["rev-list", "--ancestry-path", `${sha}..${ref}`]).split("\n").filter(Boolean));
    const line = git(["log", "--first-parent", "--reverse", "--format=%H%x1f%s", `${sha}..${ref}`]).split("\n").filter(Boolean).map((l) => l.split("\x1f")).filter(([h]) => descends.has(h)).map(([, s]) => s ?? "");
    const subjects = [git(["log", "-1", "--format=%s", sha]).trim(), ...line];
    for (const s of subjects) {
      const m = re.exec(s);
      const v = m ? m[1] ?? m[0] : null;
      if (v && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v)) return v;
    }
  } catch { if (note) note.failed = true; }
  return null;
}

// A commit's change, context out (#C433, as collector/collect.mjs's changeId, copied, never imported: this file is pinned
// and the collector moves with the link; a test holds the two equal): its files and changed lines, whitespace and line
// numbers out. ids: { sha: id } kept from run to run by the caller, so each commit is read once.
export const MAIN_LOOKBACK = 400;
export function changeId(git, sha, ids = {}) {
  if (!Object.hasOwn(ids, sha)) {
    const d = git(["show", "--format=", "-U0", "--no-color", "--no-ext-diff", sha]);
    const keep = d.split("\n").filter((l) => /^(\+\+\+ |--- |[+-])/.test(l)).map((l) => l.replace(/\s+/g, ""));
    ids[sha] = keep.length ? createHash("sha256").update(keep.join("\n")).digest("hex") : null;
  }
  return ids[sha];
}
// Where a tip's change landed on main when the tip itself isn't there (a restack, a cherry-pick: #C400's READY sat in
// ship a day): the newest main commit carrying one of its changes, when every commit it has beyond main is on main as
// the same change; else null.
// #C1387: `note` (optional) gets failed = true when a git call failed (null with failed false is "not landed").
export function landedOn(git, ref, sha, ids = {}, note = null) {
  try {
    const lines = (args) => git(args).split("\n").filter((s) => /^[0-9a-f]{40}$/.test(s));
    const beyond = lines(["rev-list", sha, `^${ref}`]);
    if (!beyond.length) return null;
    const onMain = lines(["rev-list", `--max-count=${MAIN_LOOKBACK}`, ref, `^${sha}`]), byId = new Map();
    for (const s of onMain) { const id = changeId(git, s, ids); if (id && !byId.has(id)) byId.set(id, s); }
    const found = beyond.map((s) => byId.get(changeId(git, s, ids)));
    return found.every(Boolean) ? onMain.find((s) => found.includes(s)) : null;
  } catch { if (note) note.failed = true; return null; }
}

// #C620: the phases a card has evidence for, in the board's order, whatever the hand-written steps say: build (a branch
// commit), test (a passed CI run), each sign-off note's phase, ship (on main, or a ship run on now), live (deployed).
export function seenPhases(config, facts) {
  const c = config.collector, seen = new Set();
  if (facts.head) seen.add(c.buildPhase);
  if (facts.ci === "passed") seen.add("test"); // a failed, cancelled, queued or running run is not a test done
  for (const p of facts.signed ?? []) seen.add(p);
  if (facts.onMain || facts.shipping) seen.add(c.shipPhase);
  if (facts.deployed) seen.add(c.livePhase);
  return config.phases.map((p) => p[0]).filter((p) => seen.has(p));
}

// What is installed from a repository whose installedLink moves with every board release (#C639, after #C621 was told to close
// while only on main): the link follows main, but the hooks and this job stay on the pinned copy until the owner installs
// a pack. When this run's own code is a pinned copy (<install root>/<40 hex>) beside the link's target, that copy is what is
// installed; any other run (a checkout, another install root) reads the link as before. null when nothing is installed.
// The link's target is compared as written, so it must be absolute, as swapLink writes it: a pack that made the link with
// a relative `ln -s` would read as the link's sha (Checker).
// #C737: on the store a board-repository card is live only when its commit is inside BOTH the commit the store Worker was deployed from and
// the commit of the tree the probe runs from (the launchd jobs'); the installed link is not read for it. The one sha both contain: the older
// of the two when one is an ancestor of the other. Either unknown (not 40 hex), not in this repository, or the two on different lines: null,
// and the card stays at ship (never live).
// #C1387: `note` (optional) gets failed = true when an ancestry question FAILED (git status other than 1); the two on different lines, or a commit this repository lacks, stay null with failed false.
export function deployedSha(git, worker, tree, note = null) {
  const hex = (v) => /^[0-9a-f]{40}$/.test(String(v ?? ""));
  if (!hex(worker) || !hex(tree)) return null;
  try {
    for (const s of [worker, tree]) git(["cat-file", "-e", `${s}^{commit}`]);
    if (worker === tree) return worker;
    const behind = (a, b) => { const r = ancestry(() => git(["merge-base", "--is-ancestor", a, b])); if (r === null && note) note.failed = true; return r === true; };
    if (behind(worker, tree)) return worker;
    if (behind(tree, worker)) return tree;
  } catch { /* not in this repository */ }
  return null;
}
export function installedSha(link, code = CODE, readlink = readlinkSync) {
  let target = null;
  try { target = readlink(link); } catch { /* no link: nothing installed */ }
  const sha = (p) => { const s = basename(String(p)); return /^[0-9a-f]{40}$/.test(s) ? s : null; };
  if (target === null || !sha(target)) return null;
  return sha(code) && dirname(code) === dirname(target) ? sha(code) : sha(target);
}
// One card: its phase by the evidence (the declared one when the repository shows nothing), and the facts beside it.
// A tip whose change landed on main as other commits (landedOn) is read as the main commit that carries it.
// #C621: a card with two or more branch tips also carries `branches`, each tip read on its own (tipState), so the page can
// draw one row per branch; the card's own fields stay those of its newest tip.
export const MAX_BRANCH_ROWS = 6;
// A branch's name for the state: its last path segment when that is a card-id shape (5 parts of 16 characters, 40 in all), else
// the segment with "-2", "-3" ... when a twin took it and that still fits, else branch-N. Every name that leaves is a card id
// shape, because one the schema refuses would stop the whole state from posting (#C621, Checker).
const idShape = (name) => CARD_ID.test(name) && name.length <= CARD_ID_MAX;
export function branchName(branch, taken, n) {
  const last = String(branch).split("/").pop().toLowerCase();
  let name = [last, ...[2, 3, 4, 5, 6].map((k) => `${last}-${k}`)].find((c) => idShape(c) && !taken.has(c));
  for (let k = n + 1; !name; k += 6) if (!taken.has(`branch-${k}`)) name = `branch-${k}`;
  taken.add(name);
  return name;
}
// #C731 B4b slice 3: facts.mjs's signedTimes, copied (this pinned file cannot import it): when each signed review was signed, from
// the notes ref's own history (the newest commit of the ref that touched the commit's note, at <sha>, <aa>/<rest> or <aa>/<bb>/<rest>);
// a sign-off the history can't date takes the READY commit's time, never the present. { phase: ms } for the signed phases only.
export function signedTimesOf(git, sha, notes, signed, fallback = null) {
  const out = {};
  if (!/^[0-9a-f]{40}$/.test(String(sha))) return out;
  const paths = [sha, `${sha.slice(0, 2)}/${sha.slice(2)}`, `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha.slice(4)}`];
  for (const p of signed) {
    let at = null;
    try {
      const t = Number(git(["log", "-1", "--format=%ct", notes[p], "--", ...paths]).trim());
      if (Number.isFinite(t) && t > 0) at = t * 1000;
    } catch { /* the ref's history can't date it */ }
    if (at === null) at = Number.isFinite(fallback) ? fallback : null;
    if (at !== null && at >= 1577836800000 && at <= 4102444800000) out[p] = at;
  }
  return out;
}
// `cover` (#C859 slice 3, design 4): the full sha of the stack tip the card sits under. A note on the tip counts for every card whose commits
// are ancestors of it, so the card's sign-offs (and findings) are its own commit's together with the tip's.
// #C895: the repository as owner/name, from its remote's address (https or ssh, with or without .git), read once per repository run. null when
// the remote cannot be read or does not look like owner/name: the line then simply does not name a repository.
const REPO_FULL = new WeakMap();
export function repoFullOf(repo) {
  if (!repo || typeof repo.git !== "function") return null;
  if (REPO_FULL.has(repo)) return REPO_FULL.get(repo);
  let full = null;
  try {
    const m = /[:\/]([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(String(repo.git(["remote", "get-url", repo.remote])).trim());
    if (m && !m[1].startsWith("-") && !m[2].startsWith("-")) full = `${m[1]}/${m[2]}`;
  } catch { /* no such remote */ }
  REPO_FULL.set(repo, full);
  return full;
}
const BRANCH_NAME = /^[A-Za-z0-9._\/-]{1,100}$/;
// #C882: whether the commit changed only paths nothing is deployed or installed from (docs, the readme, the changelog, tests: the groups
// scripts/make-pair.mjs lists apart from the Worker, migrations, config, page, probe, gate and hooks). A commit whose changes cannot be read, or
// that changed nothing, is not one: it keeps waiting for the install, as before. `git` is (args) -> text.
export const DOCS_ONLY = /^(docs\/|tests\/|README\.md$|CHANGELOG\.md$|CHANGELOG\.d\/[^/]+\.md$)/;
// Security R1 on 212d6b1: the card's LAST commit alone is not the landing. A card whose first commit changes the Worker and whose tip is a docs-only
// fix-up would read Live while its Worker change was never deployed. So every commit on main that carries the card's Board-Id counts (the last
// 400 of main, at most 30 of them), and the card needs no install only when ALL of them changed nothing but docs and tests; more than 30, or a
// log that cannot be read, keeps it waiting.
const MAX_CARD_COMMITS = 30;
const NO_INSTALL = new WeakMap(); // a commit's paths never change, so one diff per commit and repository run
// #C1395: true (no install needed), false (it needs one) or null (a git read of the card's landing FAILED, so whether it needs one is unread: not "waits for install"). A commit that needs one by its paths
// ("code") settles false whatever else failed; a failed log or a failed diff otherwise gives null.
function noInstallCard(repo, card, mainRef, headSha) {
  if (!NO_INSTALL.has(repo)) NO_INSTALL.set(repo, new Map());
  const memo = NO_INSTALL.get(repo), byCommit = (sha) => { if (!memo.has(sha)) { const n = {}, k = landingKind(repo.git, sha, n); memo.set(sha, n.failed ? "failed" : k); } return memo.get(sha); };
  const shas = new Set([headSha]);
  try {
    const out = String(repo.git(["log", "-400", "--fixed-strings", `--grep=Board-Id: ${card.id}`, "--format=%H%x1f%B%x1e", mainRef]));
    for (const r of out.split("\x1e")) {
      const [h, body] = r.replace(/^\n/, "").split("\x1f");
      const ids = boardIdsOf(body);
      if (/^[0-9a-f]{40}$/.test(h ?? "") && ids.includes(card.id)) shas.add(h);
    }
  } catch { return null; }
  // #C1369: an EMPTY commit of the card on main (the empty WIP commit that is pushed before the first edit) changes nothing, so it cannot need an install and
  // does not count against the card; but a card needs at least one commit that really is docs and tests only, so a card whose commits are all empty, or
  // one whose diff could not be read, keeps waiting as before.
  if (shas.size > MAX_CARD_COMMITS) return false;
  const kinds = [...shas].map(byCommit);
  if (kinds.includes("code")) return false;
  if (kinds.includes("failed")) return null;
  return kinds.every((k) => k === "docs" || k === "empty") && kinds.includes("docs");
}
// What one commit changed: "docs" (every path is docs or tests), "empty" (no path), "code" (a deployed or pinned path), "unread" (not a sha, or git could not say).
// #C1395: `note` (optional) gets failed = true when git could not say (a failed diff); "unread" for a value that is not a sha leaves it unset.
export function landingKind(git, sha, note = null) {
  if (!/^[0-9a-f]{40}$/.test(String(sha))) return "unread";
  let paths;
  try { paths = String(git(["diff", "--name-only", `${sha}^`, sha])).split("\n").map((p) => p.trim()).filter(Boolean); } catch { if (note) note.failed = true; return "unread"; }
  if (paths.length === 0) return "empty";
  return paths.every((p) => DOCS_ONLY.test(p)) ? "docs" : "code";
}
export function noInstallLanding(git, sha) { return landingKind(git, sha) === "docs"; }
// #C897: the paths a branch changed since it left main (git diff main...tip), once per repository run and tip; null when there is no
// table to read them for, or git cannot say (the typed rule then decides).
const BRANCH_PATHS = new WeakMap();
export function branchPaths(repo, mainRef, sha) {
  if (!repo?.reviewPaths || typeof repo.git !== "function" || !/^[0-9a-f]{40}$/.test(String(sha))) return null;
  if (!BRANCH_PATHS.has(repo)) BRANCH_PATHS.set(repo, new Map());
  const memo = BRANCH_PATHS.get(repo);
  if (!memo.has(sha)) {
    let paths = null;
    try { paths = String(repo.git(["diff", "--name-only", "--no-renames", `${mainRef}...${sha}`, "--"])).split("\n").map((p) => p.trim()).filter(Boolean); } catch { /* unread: the typed rule */ }
    memo.set(sha, paths);
  }
  return memo.get(sha);
}
// #C1432 (11-24: #C1425 at 07bf808b and #C1431 at 007057e7 changed page/, were signed by Checker 2 and Security, and never went to Designer, so Release's land refused them for the
// missing LOOK-OK and Manager sent them by hand): the board's own repository reads Designer's note whatever its config's notes list (the land gate reads refs/notes/designer, collector/signoff.mjs),
// and a board card needs the design review when its branch changes page/ (the land gate's rule) or the card is marked look_change. Another repository keeps its config.
export function boardRepoNotes(name, notes) {
  const n = notes && typeof notes === "object" ? notes : {};
  return securityAlways(name) && !Object.hasOwn(n, "design") ? { ...n, design: DESIGNER_REF } : n;
}
// Whether the branch changed anything under page/ since it left main: true, false, or null when git can't say (then only the card's look_change, by the config's skips, asks for Designer). Once per repository run and tip.
const PAGE_CHANGED = new WeakMap();
export function pageChanged(repo, mainRef, sha) {
  if (typeof repo?.git !== "function" || !/^[0-9a-f]{40}$/.test(String(sha))) return null;
  if (!PAGE_CHANGED.has(repo)) PAGE_CHANGED.set(repo, new Map());
  const memo = PAGE_CHANGED.get(repo);
  if (!memo.has(sha)) {
    let hit = null;
    try { hit = String(repo.git(["diff", "--name-only", "--no-renames", `${mainRef}...${sha}`, "--", PAGE_DIR])).split("\n").some((p) => p.trim() !== ""); } catch { /* unread */ }
    memo.set(sha, hit);
  }
  return memo.get(sha);
}
// #C996 part 3: the commits a review ref has a note on, read once per repository run (`git notes --ref=X list`, one process) so a
// card whose tip no review has seen costs no `notes show`. null when the list is empty or unreadable: the caller then asks per commit.
const NOTE_LISTS = new WeakMap();
export function annotatedOn(repo, ref) {
  if (!repo || typeof repo.git !== "function") return null;
  if (!NOTE_LISTS.has(repo)) NOTE_LISTS.set(repo, new Map());
  const memo = NOTE_LISTS.get(repo);
  if (!memo.has(ref)) {
    let set = null;
    try {
      const shas = String(repo.git(["notes", `--ref=${ref}`, "list"])).split("\n").map((l) => l.trim().split(/\s+/)[1]).filter((c) => /^[0-9a-f]{40}$/.test(String(c)));
      if (shas.length) set = new Set(shas);
    } catch { /* ask per commit */ }
    memo.set(ref, set);
  }
  return memo.get(ref);
}
// #C890 (half 2 of #C863, the #C731 case): a part of a card is named by the word "part" and a commit sha in the card's next_note ("part 1a2b3c4"), 7 to 40 hex characters (lower case,
// as git prints it). Every other sha in a note (a superseded tip, a review tip, an old stack) is ignored: only a marked one can hold a landed card. The marked word is a sha only if it
// has a digit and a letter a to f (so "part defaced", a date or a long number is not one), at most 10 of them. Pure: the note in, the list out.
export function citedShas(note) {
  if (typeof note !== "string") return [];
  const out = [];
  for (const m of note.matchAll(/(?<![0-9A-Za-z])part\s+([0-9a-f]{7,40})(?![0-9A-Za-z])/gi)) if (/[0-9]/.test(m[1]) && /[a-f]/.test(m[1]) && !out.includes(m[1])) out.push(m[1]);
  return out.slice(0, 10);
}
function tipState(card, tip, repo, config, now, declared, cover = null, nudgeTop = false) {
  // #C852: a review's note on a commit is a sign-off unless it starts "FINDINGS" (rework.mjs reads the same word): that is the review sending
  // the commit back, so it is no sign-off, and findingsOn names the reviews that did. A new commit has a new sha, so a finding clears itself.
  // #C1395: `git notes show` exits 1 when the commit has no note (the plain "no sign-off"); any other failure is a note that could not be read: unread "notes", never "no sign-off" (see `notesFailed` below).
  let notesFailed = false;
  const notesOn = (sha) => Object.entries(repo.notes).map(([p, ref]) => { const have = annotatedOn(repo, ref); if (have && /^[0-9a-f]{40}$/.test(String(sha)) && !have.has(sha)) return null; let t = null; try { t = repo.git(["notes", `--ref=${ref}`, "show", sha]); } catch (e) { if (e?.status !== 1) notesFailed = true; } return t === null || t === undefined || t === false ? null : [p, String(t)]; }).filter(Boolean);
  // #C1163: a sign-off is a note whose first line starts with the role's word (PASS, SECURE; collector/signoff.mjs), the one reading the landing job, the release tool and the re-cut tool use.
  // A note that is neither (HOLD, STOP, a stray line) is no sign-off and no finding.
  const signedOn = (sha) => notesOn(sha).filter(([p, t]) => isSignoff(t, p)).map(([p]) => p).sort();
  const findingsOn = (sha) => notesOn(sha).filter(([, t]) => isFindings(t)).map(([p]) => p).sort();
  const mainRef = `${repo.remote}/${repo.main}`;
  // #C1387: a source whose read FAILED (git status other than 1) is named in `unread`, never read as "no"; the Worker reads the ones the phase rests on as unknown.
  const unread = new Set();
  const tipOnMain = ancestry(() => repo.git(["merge-base", "--is-ancestor", tip.sha, mainRef]));
  let landed = null;
  if (tipOnMain === null) unread.add("main");
  else if (tipOnMain === false) { const note = {}; landed = landedOn(repo.git, mainRef, tip.sha, repo.ids, note); if (note.failed) unread.add("main"); }
  // A tip with commits after the card's shipped one (#C527, collector/after-ship.mjs) is read as that commit, with its
  // sign-offs.
  const after = landed ? null : shippedBase(repo.git, mainRef, tip.sha, { id: card.id, branch: tip.branch, pattern: repo.shippedPattern ?? "" });
  // A tip read as a main commit (landed, or the shipped one) keeps afterShip set: that head is no bare branch (bareBranch).
  const head = landed ? { ...tip, sha: landed, afterShip: true } : after ? { ...tip, sha: after.sha, afterShip: true } : tip;
  // #C1133: a git call that FAILED (not "no") leaves the head's place unknown: it is not read as on main (no ship reading from a failed call), and the marked parts below are still held.
  const mainAnswer = landed ? true : ancestry(() => repo.git(["merge-base", "--is-ancestor", head.sha, mainRef]));
  const atMain = mainAnswer === true, mainUnknown = mainAnswer === null;
  if (mainUnknown) unread.add("main");
  // #C671: a pushed branch named for the card with no commit of its own sits at a main commit: it is work started (build), and
  // main's sign-off notes and deploy are not the card's.
  const bare = !landed && !after && ((atMain && bareBranch(card, head)) || byNumberOnly(card, head));
  const coverSha = cover && !bare && !landed && !after && /^[0-9a-f]{40}$/.test(String(cover)) ? cover : null;
  // A review that sent the tip back (FINDINGS) is no sign-off for any card under it, whatever its note on the card's own commit says.
  const sentBack = coverSha ? findingsOn(coverSha) : [];
  const signed = bare ? [] : [...new Set([...signedOn(after ? after.sha : tip.sha), ...(coverSha ? signedOn(coverSha) : [])])].filter((p) => !sentBack.includes(p)).sort();
  const onMain = atMain && !bare;
  // #C882: a landing that changed only docs and tests has nothing to deploy or install: it is live the moment it is on main, not "waiting for install".
  // #C1395: noInstallCard answers true, false or null (a git read of the card's landing FAILED: the install state is unread, never "waits for install"); it is unread "install" only while the card is not deployed.
  const noInstallAns = onMain && typeof repo.git === "function" ? noInstallCard(repo, card, mainRef, head.sha) : false;
  const noInstall = noInstallAns === true;
  // #C1278 (11-19: no ships row after 1.218.0, so no Acknowledge button for ten versions): Release merges a card's commit into dev and CI goes green on that merge BEFORE the version commit ("v1.226.3: ...")
  // is made, so the newest green run already contains the card's head while no commit naming a version is in it yet. The card read live, closed, and its reading carried no version: no ship was ever noted.
  // In a repository that names its versions (versionPattern), a card is deployed only when a commit naming one lies between its head and the live commit; until then it reads ship, and the reading that
  // makes it live carries the version.
  // #C1387: a failed ancestry question, a failed version read or a live commit that could not be read at all (repo.liveUnread) is unread "deploy" or "version", not "not deployed".
  let deployedAns = false;
  if (onMain && !noInstall) {
    if (!repo.live) { if (repo.liveUnread === true) unread.add("deploy"); }
    else {
      const inLive = ancestry(() => repo.git(["merge-base", "--is-ancestor", head.sha, repo.live]));
      if (inLive === null) unread.add("deploy");
      else if (inLive) {
        if (!repo.versionPattern) deployedAns = true;
        else { const note = {}, v = versionAfter(repo.git, head.sha, repo.live, repo.versionPattern, note); if (note.failed) unread.add("version"); else deployedAns = v !== null; }
      }
    }
  }
  const deployed = onMain && (noInstall || deployedAns);
  if (noInstallAns === null && !deployed) unread.add("install");
  const cfg = { ...config, collector: { ...config.collector, notes: repo.notes, mainBranch: repo.main } };
  // #C897: the reviews from the paths the branch changed since it left main, when the repository has a reviewPaths table.
  const changed = !onMain && !bare ? branchPaths(repo, mainRef, tip.sha) : null;
  const pathNeeds = changed ? reviewsFromPaths(card, cfg, reviewsFor(card, cfg), repo.reviewPaths, changed) : null;
  // #C1163: a card of the board's own repository always wants Security (the landing job wants SECURE on every commit): a Quick card that touches only collector/, tests/ or docs/ used to have
  // it skipped, read "every review signed" at ship and was never picked by the landing job. It is added to the card's reviews here, so the phase, waitingFor and the dispatch agree.
  // #C1432: and Designer's when the branch changes page/ (boardRepoNotes gives the board's repository the design note to read, so a card marked look_change already asks for it by the config's
  // skips). A diff git can't read adds nothing: no review is made up from a failed read.
  const boardCard = securityAlways(card.repo) && !onMain && !bare, hasNote = (p) => Object.hasOwn(cfg.collector.notes ?? {}, p);
  const boardAdds = boardCard ? [...(hasNote("security") ? ["security"] : []), ...(hasNote("design") && pageChanged(repo, mainRef, tip.sha) === true ? ["design"] : [])] : [];
  const needs = boardAdds.length ? [...new Set([...(pathNeeds ?? reviewsFor(card, cfg)), ...boardAdds])] : pathNeeds;
  // #C1110: a branch that touches the repository's customer-text paths (the reviewPaths table's language list) sets the card's customer-text flag: the
  // Worker raises it and never clears it, so the language review no longer rests on a box someone ticked at card time.
  const customerText = Array.isArray(changed) && repo.reviewPaths && typeof repo.reviewPaths === "object" && pathPhases(repo.reviewPaths, changed).has("language");
  const readPhase = phaseOf(card, { head, signed: new Set(signed), onMain, deployed, ...(needs ? { needs } : {}) }, cfg);
  // #C890: a card that would read live while a commit cited in its next_note is not an ancestor of main (or is no commit the repository knows) is held at ship, naming the missing shas.
  // Checker 2's M1 on #C1104 (e944b23e): the marked parts are read whenever the head is on main, not only at a would-be-live reading (then the board closed a card of a
  // named repository at landing; since #C1378 no card closes at landing, and the marks still say what is missing); the phase change (held at ship) stays for a would-be-live reading.
  // #C1133: a cited part counts as present only when git ANSWERED yes; a failed call (unknown) is missing, so a load flake holds the card at ship and never lets it read as landed.
  const partsMissing = (onMain || (mainUnknown && !bare)) && typeof repo.git === "function" ? citedShas(card.nextNote).filter((s) => ancestry(() => repo.git(["merge-base", "--is-ancestor", s, mainRef])) !== true) : [];
  // #C1160 (11-17: the board lit "checker" on #C1128's empty start commit and the owner took it for a stuck review): a tip whose newest commit says WIP (#C1139's wipHead, read here so
  // the phase can use it) is work in progress, so the card reads at build: the phase and the lit tile stay at build, firm is false and no readyAt is set. The next real commit reads as before.
  const headLine = String((head.message ?? tip.message) ?? "").split("\n")[0];
  // The first-push guard (gate/first-push.mjs) tells builders to commit "<card> WIP", so the word also counts right after one card token (a number, #C123, or a hyphenated slug), and an
  // EMPTY commit (no change against its first parent, no sign-off on it) is a start push whatever it says. A real commit that only mentions WIP ("Fix WIP: wording") is none.
  const wipWord = WIP_START.test(headLine);
  // #C1387: `diff --quiet` exits 0 (no change: an empty start) or 1 (a change); any other failure is unread "start" (a minor source: no state, never the answer "empty").
  const asksEmpty = !onMain && !bare && !wipWord && !signed.length && /^[0-9a-f]{40}$/.test(String(head.sha)) && typeof repo.git === "function";
  const emptyAns = asksEmpty ? ancestry(() => repo.git(["diff", "--quiet", `${head.sha}^1`, head.sha])) : false;
  if (emptyAns === null) unread.add("start");
  const emptyStart = emptyAns === true;
  // #C1275 (11-19: Designer got a review turn for #C1272 at e1a12981, which was #C1269's tip: the branch had no commit of its own yet): a tip whose newest commit names Board-Ids and not this card's is another
  // card's commit, the base of a stacked branch, not this card's work: it reads as a start push, no review turn, until a commit of the card's own is on it.
  const headIds = !landed && !after ? boardIdsOf(String((head.message ?? tip.message) ?? "")) : [];
  const foreignHead = !onMain && !bare && headIds.length > 0 && !headIds.includes(card.id);
  const wipHead = !onMain && !bare && (wipWord || emptyStart || foreignHead);
  const phase = wipHead ? config.collector.buildPhase : partsMissing.length && readPhase === config.collector.livePhase ? config.collector.shipPhase : readPhase;
  const ci = repo.ci ? repo.ci(head.sha) : repo.gh ? ciOf(repo.gh, head.sha, now) : null;
  // #C1426: a landed card whose commit is inside a deploy run on now is shipping too (Release's deploy, no session on the card); a run list that could not be read says nothing.
  const deploying = onMain && !deployed && Array.isArray(repo.deploying) && typeof repo.git === "function" && /^[0-9a-f]{40}$/.test(String(head.sha)) && repo.deploying.some((s) => ancestry(() => repo.git(["merge-base", "--is-ancestor", head.sha, s])) === true);
  const shipping = deploying ? true : Array.isArray(repo.ships) ? !onMain && shipsCard(repo.ships, tip, head) : null;
  const seen = seenPhases(config, { head: true, ci: ci?.ci, signed, onMain, shipping: shipping === true, deployed: deployed && !partsMissing.length });
  // #C731 B4b: the readyAt, firm and waitingFor the old page had. A phase read as build is not firm (a head with no trailer or sign-off,
  // or a bare branch); otherwise readyAt is the head's time, and a tip still in review lists the reviews unsigned on it.
  const build = phase === config.collector.buildPhase;
  const order = config.phases.map((p) => p[0]);
  const unsigned = onMain ? [] : (needs ?? reviewsFor(card, cfg)).filter((p) => !signed.includes(p)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  // reviews: when each review the repository shows signed on the tip was signed (#C671); none for a bare
  // branch, a tip read as a main commit, or one with no sign-offs.
  const reviews = !bare && !onMain && signed.length && typeof repo.git === "function" && repo.notes
    ? { ...(coverSha ? signedTimesOf(repo.git, coverSha, repo.notes, signed, head.at) : {}), ...signedTimesOf(repo.git, after ? after.sha : tip.sha, repo.notes, signed, head.at) } : {};
  // #C854: a tip that has its sign-offs (the phase is ship) but does not continue main (main has a commit the tip lacks) cannot be landed as it
  // is: it goes back to its builder to re-cut. Read only for a tip waiting at ship, so a card in review costs no extra git call.
  // #C1207 (11-18: the watch sent Builder "signed but behind main, re-cut" for two lower cards of a stack whose tip, fully signed, already had main merged in; a re-cut would have cost every signature): a card
  // read under a stack tip (coverSha) that is a lower card of it is never behind main by its own commit: the stack's tip carries the question, once, and is behind main only when the tip itself lacks it.
  // #C1209 (Checker 2's LOW on #C1207): when no card's commit IS the stack's tip (a fix-up or merge commit with no card's Board-Id), nobody owned the question and the stack was never named; the stack's
  // topmost card (nudgeTop, set by the stack read) then carries it, once, and it is asked of the stack's tip, not of the card's own older commit.
  const lowerOfStack = !!coverSha && String(tip.sha) !== coverSha && !(nudgeTop && coverSha);
  const behindRef = nudgeTop && coverSha ? coverSha : tip.sha;
  // #C1387: only exit 1 says "main has a commit the tip lacks" (re-cut); a failed call answers neither (unread "behind": no re-cut, no state).
  const asksBehind = !onMain && !bare && !lowerOfStack && phase === config.collector.shipPhase && typeof repo.git === "function";
  const behindAns = asksBehind ? ancestry(() => repo.git(["merge-base", "--is-ancestor", mainRef, behindRef])) : true;
  if (behindAns === null) unread.add("behind");
  const behindMain = asksBehind && behindAns === false;
  const findings = bare || onMain ? [] : [...new Set([...findingsOn(after ? after.sha : tip.sha), ...(coverSha ? findingsOn(coverSha) : [])])].sort();
  // #C1114: the findings every review has put on the branch's commits (not only the tip's), counted by kind; the Worker raises the card's counters to these.
  // #C1397: issueBase is the merge-base of main and the tip (the start of the range counted), sent only when both reads worked; the Worker sets the counters to this range's counts when it differs from the last one.
  let issueBase = null;
  const issueCounts = (() => {
    if (bare || onMain || !repo.notes || typeof repo.git !== "function" || !/^[0-9a-f]{40}$/.test(String(tip.sha))) return {};
    let shas = [], listed = false; try { shas = String(repo.git(["rev-list", "--max-count=60", `${mainRef}..${tip.sha}`])).split("\n").map((l) => l.trim()).filter((s) => /^[0-9a-f]{40}$/.test(s)); listed = true; } catch { /* none */ }
    if (listed) { try { const b = String(repo.git(["merge-base", mainRef, tip.sha])).trim(); if (/^[0-9a-f]{40}$/.test(b)) issueBase = b; } catch { /* unread: no base sent */ } }
    return countFindings(shas.flatMap((s) => notesOn(s)));
  })();
  // #C1139 (Checker 2, 11-16 late: the dispatch woke it for #C1124 at 8224f95d and #C1065 at d664bc97, each a single empty "WIP: branch pushed before the first edit" commit with no READY):
  // a tip whose newest commit says WIP (the word at the start of its first line) is a start push or work in progress, never a READY, whatever the stack switch or a signal says. The
  // dispatch gives it no review turn. The next real commit is a new tip with no such word. A branch on main, or a bare one, is not read.
  // (#C1160 reads it above, before the phase.)
  // #C1395: a sign-off that could not be read leaves the card's reviews unknown (only while the card is open: a card on main rests on the deploy, not on its sign-offs); the CI word is the card's own `ci`.
  if (notesFailed && !onMain) unread.add("notes");
  if (ci?.ci === "unread") unread.add("ci");
  // #C1406: the open findings on the CURRENT tip alone (the head's notes and the covering tip's), by kind, {} when none: the card's counters follow the tip, never an older tip's findings.
  const tipIssues = bare || onMain || notesFailed ? null : countFindings([...new Set([after ? after.sha : tip.sha, coverSha].filter(Boolean))].flatMap((s) => notesOn(s)));
  const extra = {
    ...(tipIssues ? { tipIssues } : {}),
    ...(wipHead ? { wipHead: true } : {}),
    // #C1239: the tip's message names the card in a Board-Id line that is not git's trailer (the line sits in a paragraph of its own): the board cannot match it, and the builder is told so.
    ...(!onMain && !wipHead && !wipWord && misplacedBoardId(head.message ?? tip.message, card.id) ? { trailerMisplaced: true } : {}),
    ...(Object.keys(reviews).length ? { reviews } : {}),
    ...(findings.length ? { findings } : {}),
    ...(Object.keys(issueCounts).length ? { issueCounts } : {}),
    ...(issueBase ? { issueBase } : {}),
    ...(customerText ? { customerText: true } : {}),
    ...(behindMain ? { behindMain: true } : {}),
    ...(unread.size && typeof repo.git === "function" ? { unread: [...unread].sort() } : {}),
    ...(partsMissing.length ? { partsMissing } : {}),
    ...(noInstall ? { noInstall: true } : {}),
    ...(phase && build ? { firm: false } : {}),
    ...(phase && !build && Number.isInteger(head.at) && head.at >= 1577836800000 && head.at <= 4102444800000 ? { readyAt: head.at } : {}),
    // #C1396: the head's time at any phase (build included), for the Worker's stuck rule: a push resets the clock.
    ...(Number.isInteger(head.at) && head.at >= 1577836800000 && head.at <= 4102444800000 ? { headAt: head.at } : {}),
    ...(phase && !build && unsigned.length ? { waitingFor: unsigned.slice(0, 10) } : {}),
  };
  // #C895: the full sha, the branch (main for a card on main) and the repository, for the DISPATCH line.
  const where = {
    ...(/^[0-9a-f]{40}$/.test(String(head.sha)) ? { headSha: head.sha } : {}),
    ...(() => { const b = onMain ? repo.main : head.branch; return typeof b === "string" && BRANCH_NAME.test(b) && !b.startsWith("-") ? { headBranch: b } : {}; })(),
    ...(repoFullOf(repo) ? { repoFull: repoFullOf(repo) } : {}),
  };
  return { phase: phase ?? declared, ...extra, ...where, headSha12: sha12(head.sha), signed, onMain, ...(ci ? { ci: ci.ci, ciMin: ci.ciMin } : {}), liveVersion: deployed && repo.versionPattern ? versionAfter(repo.git, head.sha, repo.live, repo.versionPattern) : null, ...(shipping === null ? {} : { shipping }),
    // #C1377 (Director's audit #C1375, finding 3): a run that could not read the repository as GitHub has it now (the fetch or the tips failed: repo.fresh === false) read an old clone, so
    // every card of it is marked stale, with the time that repository was last read fresh (repo.freshAt, kept from run to run); a good read has no mark, so it clears the next run.
    ...(repo.fresh === false ? { stale: true, ...(isTimeMs(repo.freshAt) ? { staleSince: repo.freshAt } : {}) } : {}), seen };
}
// The newest commit on the repository's main line (its last 400) whose Board-Id trailer is exactly the card's id, as a head
// { branch: main, sha, at, message }, or null. The id goes to git as a fixed string, never a pattern or an option.
// #C996 part 3: the trailer index. One `git log` of main's commits that carry any Board-Id line (the newest TRAILER_INDEX_MAX), read once per run
// per repository (a repo marked `indexed`, as the probe's own are), gives every card its newest commit by exact trailer: what trailerHead asks git
// once per card (two or three times for a card on main), 165 open cards a run. A card the index does not hold is no commit on main when the list is
// complete; when it was cut at the cap, the card is asked alone as before. A git failure gives no index (null): every card is asked alone.
export const TRAILER_INDEX_MAX = 5000;
const TRAILER_INDEXES = new WeakMap();
export function trailerIndex(repo) {
  if (!TRAILER_INDEXES.has(repo)) {
    let index = null;
    try {
      const out = String(repo.git(["log", `-${TRAILER_INDEX_MAX}`, "--fixed-strings", "--grep=Board-Id: ", "--format=%H%x1f%ct%x1f%B%x1e", `${repo.remote}/${repo.main}`]));
      const heads = new Map();
      let n = 0;
      for (const r of out.split("\x1e")) {
        const [sha, at, message] = r.replace(/^\n/, "").split("\x1f");
        if (!/^[0-9a-f]{40}$/.test(sha ?? "")) continue;
        n++;
        for (const id of boardIdsOf(message)) if (!heads.has(id)) heads.set(id, { branch: repo.main, sha, at: Number(at) * 1000, message });
      }
      index = { heads, complete: n < TRAILER_INDEX_MAX };
    } catch { index = null; }
    TRAILER_INDEXES.set(repo, index);
  }
  return TRAILER_INDEXES.get(repo);
}
// #C996 part 3: the run's read memo. A read git answers the same way for the whole run (the fetch is done before it is made), so each distinct
// read command runs once: merge-base, rev-list, log, diff, show, cat-file, rev-parse and notes list or show. A failure is kept too (merge-base
// --is-ancestor answers "no" by failing). Anything else (fetch, a notes write) runs every time, and a result over MEMO_MAX_CHARS is not kept.
// memo.stats counts { hits, runs } for the run's timing and for tests.
export const MEMO_MAX_CHARS = 1_000_000;
const MEMO_READS = new Set(["merge-base", "rev-list", "log", "diff", "show", "cat-file", "rev-parse"]);
const isRead = (args) => Array.isArray(args) && args.every((a) => typeof a === "string") && (MEMO_READS.has(args[0]) || (args[0] === "notes" && (args.includes("show") || args[args.length - 1] === "list")));
export function memoGit(git) {
  const kept = new Map(), stats = { hits: 0, runs: 0 };
  const read = (args) => {
    if (!isRead(args)) { stats.runs++; return git(args); }
    const key = args.join("\u0000");
    const had = kept.get(key);
    if (had) { stats.hits++; if (had.error) throw had.error; return had.value; }
    stats.runs++;
    try {
      const value = git(args);
      if (typeof value !== "string" || value.length <= MEMO_MAX_CHARS) kept.set(key, { value });
      return value;
    } catch (error) { kept.set(key, { error }); throw error; }
  };
  read.stats = stats;
  return read;
}
// #C1387: `note` (optional) gets failed = true when git's log FAILED (null with failed false is "no commit carries the id").
export function trailerHead(repo, id, branch = repo.main, depth = 400, note = null) {
  if (repo.indexed === true && branch === repo.main && depth === 400) {
    const index = trailerIndex(repo);
    const found = index?.heads.get(id);
    if (found) return { ...found };
    if (index?.complete) return null;
  }
  let out = "";
  try { out = repo.git(["log", `-${depth}`, "--fixed-strings", `--grep=Board-Id: ${id}`, "--format=%H%x1f%ct%x1f%B%x1e", `${repo.remote}/${branch}`]); } catch { if (note) note.failed = true; return null; }
  for (const r of out.split("\x1e")) {
    const [sha, at, message] = r.replace(/^\n/, "").split("\x1f");
    const ids = boardIdsOf(message);
    if (/^[0-9a-f]{40}$/.test(sha ?? "") && ids.includes(id)) return { branch, sha, at: Number(at) * 1000, message };
  }
  return null;
}
// #C735: a branch named for a card whose tip is another card's commit (a later card stacked on it: #C730's commit on the #C728
// branch) is read at the card's OWN newest commit on that branch, the one its reviews were signed on, not at the stacked tip.
// The tip is kept when the card has no commit of its own on the branch within its last 100.
export function ownHead(repo, card, tip) {
  const other = boardIdOf(tip?.message);
  if (!other || other === card.id || typeof repo?.git !== "function" || !/^[A-Za-z0-9._\/-]+$/.test(String(tip.branch)) || String(tip.branch).startsWith("-")) return tip;
  return trailerHead(repo, card.id, tip.branch, 100) ?? tip;
}
// #C731 B4b slice 3: collect.mjs's workSeen and shippedAt for a card with no head. A commit on the repository's main line (its last
// 400) whose subject starts "#C<num>:" or cites "#C<num>" is work seen even with no branch left (a squash or a direct commit);
// a ship commit (the repository's versionPattern) that cites the card also says when it shipped. Read once per repository run.
// Not read here: a ship commit that names the card only by its branch@sha (collect.mjs's shippedHeads path).
const MAIN_LINES = new WeakMap();
export function mainEvidence(repo, card) {
  if (!repo || typeof repo.git !== "function" || !Number.isInteger(card.num) || card.num < 1 || card.num > 1e6) return null;
  if (!MAIN_LINES.has(repo)) {
    let line = [];
    try {
      line = repo.git(["log", "--first-parent", "-400", "--format=%H%x1f%ct%x1f%s", `${repo.remote}/${repo.main}`]).split("\n").filter(Boolean)
        .map((l) => { const [, at, subject] = l.split("\x1f"); return { at: Number(at) * 1000, subject: String(subject ?? "") }; });
    } catch { line = []; }
    MAIN_LINES.set(repo, line);
  }
  const cite = new RegExp(`(?:^|[^A-Za-z0-9])#C${card.num}(?![0-9])`);
  const mine = MAIN_LINES.get(repo).filter((l) => new RegExp(`^#C${card.num}:`).test(l.subject) || cite.test(l.subject));
  if (!mine.length) return null;
  const ship = repo.versionPattern ? mine.filter((l) => new RegExp(repo.versionPattern).test(l.subject) && Number.isInteger(l.at) && l.at >= 1577836800000 && l.at <= 4102444800000).map((l) => l.at) : [];
  return { workSeen: true, ...(ship.length ? { shippedAt: Math.max(...ship) } : {}) };
}
// #C1239 (11-18, #C1236: re-cut and shipped as "v1.217.1: admin/c1236-demo-map@7f395db4", its commits without a git trailer, so no trailer search on main could find them and the old branch on origin held the
// card at build "nothing pushed" for good): a ship commit on main (the repository's shippedPattern, "<branch>@<sha>") that cites a branch of THIS card, by its id as the branch's last part or by its number (the
// c<num> the branch is named for), names the commit that shipped. That commit, when it is on main, is the card's head { branch: main, sha, at, message }. Read only for a card whose branch tips all lack its trailer
// (found by number, or none at all), never to override a tip that carries the card's own Board-Id. The branch name and the sha come from a ship line on main and go to git as plain arguments after the checks.
// #C1387: `note` (optional) gets failed = true when a git call on main FAILED (the log, or a cited commit's ancestry); null with failed false is "no ship line cites it".
export function shipCitedHead(repo, card, note = null) {
  if (!repo || typeof repo.git !== "function" || !repo.shippedPattern || !Number.isInteger(card.num) || card.num < 1 || card.num > 1e6) return null;
  let re;
  try { re = new RegExp(repo.shippedPattern, "g"); } catch { return null; }
  const mainRef = `${repo.remote}/${repo.main}`;
  let subjects = [];
  try { subjects = String(repo.git(["log", "--first-parent", "-400", "--format=%s", mainRef])).split("\n"); } catch { if (note) note.failed = true; return null; }
  for (const subject of subjects) {
    if (subject.length > 400) continue;
    for (const m of subject.matchAll(re)) {
      const branch = m[1], sha = m[2];
      if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(String(branch)) || String(branch).startsWith("-") || !/^[0-9a-f]{7,40}$/.test(String(sha))) continue;
      if (String(branch).split("/").pop() !== card.id && branchNum(branch) !== card.num) continue;
      let full = "";
      try { full = String(repo.git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`])).trim(); } catch { continue; }
      if (!/^[0-9a-f]{40}$/.test(full)) continue;
      const onMainAns = ancestry(() => repo.git(["merge-base", "--is-ancestor", full, mainRef]));
      if (onMainAns === null && note) note.failed = true;
      if (onMainAns !== true) continue;
      try {
        const [at, ...rest] = String(repo.git(["log", "-1", "--format=%ct%x1f%B", full])).split("\x1f");
        return { branch: repo.main, sha: full, at: Number(at) * 1000, message: rest.join("\x1f") };
      } catch { continue; }
    }
  }
  return null;
}
// opts (#C859 slice 3, stack mode): head { branch, sha, at, message } is the card's commit found by its trailer on a stack branch, used when
// neither its branch name nor a branch tip names it; cover is the full sha of the stack tip, whose notes count for the card (design 4).
export function cardState(card, repo, config, now, opts = {}) {
  const declared = config.phases.some((p) => p[0] === card.phase) ? card.phase : null;
  const base = { num: Number.isInteger(card.num) && card.num >= 1 && card.num <= 1e6 ? card.num : null, phase: declared, headSha12: null, signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: now };
  if (!repo) return base;
  let tips = headsFor(card.id, repo.tips.filter((h) => h.branch !== repo.main), card.num);
  // #C725: a card whose branch is gone (merged, then deleted) is read from the commit on main that carries its Board-Id trailer,
  // as the Collector did (collect.mjs trailerOnMain, #C281/#C716). Without it the probe has no head for a shipped card and the board
  // shows it queued or stalled, because the store carries none of the Collector's readings.
  if (!tips.length && opts.head) tips = [opts.head];
  // #C1387: a read of main that FAILED (the trailer search, the ship line, an ancestry question) is not "no commit on main": the card says unread "main", whichever row it ends up with.
  const miss = new Set();
  const withMiss = (o) => (miss.size ? { ...o, unread: [...new Set([...(o.unread ?? []), ...miss])].sort() } : o);
  if (!tips.length && typeof repo.git === "function") { const n = {}, t = trailerHead(repo, card.id, undefined, undefined, n); if (n.failed) miss.add("main"); if (t) tips = [t]; }
  // #C1239: no branch tip carries the card's own trailer (found by number only, or nothing found): a ship commit on main that cites a branch of the card names the commit that shipped.
  // Checker 2's F1 on bed0c76c: only when no tip is NEWER than the cited commit and still unmerged: a card that shipped once and then got new work (carrying the same slip) keeps that tip as its row, so the new work
  // is seen and its builder is told about the trailer. A newer tip that is an ancestor of main is no new work.
  if (typeof repo.git === "function" && tips.every((t) => boardIdOf(t.message) !== card.id)) {
    const cn = {}, cited = shipCitedHead(repo, card, cn);
    if (cn.failed) miss.add("main");
    const mainRef = `${repo.remote}/${repo.main}`;
    // A tip whose place on main could not be read stays a row of its own (counts as newer, as it did), and the card says unread "main".
    const tipOnMain = (t) => { if (!/^[0-9a-f]{40}$/.test(String(t.sha))) return false; const a = ancestry(() => repo.git(["merge-base", "--is-ancestor", t.sha, mainRef])); if (a === null) miss.add("main"); return a === true; };
    const newer = cited ? tips.some((t) => Number.isFinite(t.at) && t.at > cited.at && !tipOnMain(t)) : false;
    if (cited && !newer) tips = [cited];
  }
  if (tips[0]) tips = [ownHead(repo, card, tips[0]), ...tips.slice(1)];
  let tip = tips[0];
  if (!tip) return withMiss({ ...base, ...(mainEvidence(repo, card) ?? {}) });
  let one = tipState(card, tip, repo, config, now, declared, opts.cover ?? null, opts.nudgeTop === true);
  // #C915 (incident 11-11: a card's v2 shipped in v1.209.9 and its v1 branch stayed, read "signed but behind main, re-cut" and dispatched to the
  // builder; a landed card's stale tip went to Checker five times): when none of the card's branch tips is on main but a commit on main carries
  // its Board-Id trailer, that main commit is the card (landed, or live once deployed) and the older tips are no longer worked. The branch of the
  // newer version is often deleted at merge, so the tips alone cannot show it. A tip that is built ON the main commit (the commit is its ancestor)
  // is rework after the landing, not an older version: it stays the card's tip (tests/probe-trailer-fallback.test.mjs).
  if (!one.onMain && typeof repo.git === "function") {
    const hn = {}, landedHead = trailerHead(repo, card.id, undefined, undefined, hn);
    if (hn.failed) miss.add("main");
    // A failed ancestry question here answers neither: the card keeps its own tip (no swap) and says unread "main".
    const underTip = landedHead ? ancestry(() => repo.git(["merge-base", "--is-ancestor", landedHead.sha, tip.sha])) : true;
    if (underTip === null) miss.add("main");
    if (landedHead && underTip === false) {
      const m = tipState(card, landedHead, repo, config, now, declared, null);
      if (m.onMain === true) { tips = [landedHead]; tip = landedHead; one = m; }
    }
  }
  // #C886 (the owner, 2026-11-10 10:02 pm: 15 blue tiles while every agent was idle): a card draws ONE row. Once one branch of the card is on main,
  // the card is that branch alone; before that, of the versions of a branch (build/x, build/x-v2, build/x-v3: the same family) only the newest
  // pushed one is a row. Branches of different names stay rows of their own (#C621). The card's own fields, its phase included, are those of
  // the row that is kept, so a v1 unsigned and a v3 on main read at v3's phase and the old version's frozen tile is gone.
  if (tips.length > 1) {
    tips = tips.slice(0, MAX_BRANCH_ROWS);
    const read = new Map([[tip, one]]);
    const stateOf = (t) => { if (!read.has(t)) read.set(t, tipState(card, t, repo, config, now, declared, t === tips[0] ? opts.cover ?? null : null, t === tips[0] && opts.nudgeTop === true)); return read.get(t); };
    const landed = tips.find((t) => stateOf(t).onMain === true);
    if (landed) tips = [landed];
    else { const seen = new Set(); tips = tips.filter((t) => { const f = branchFamily(t.branch); if (seen.has(f)) return false; seen.add(f); return true; }); }
    if (tips[0] !== tip) { tip = tips[0]; one = stateOf(tip); }
    const out = { ...base, ...one };
    if (tips.length > 1) {
      const taken = new Set();
      out.branches = tips.map((t, n) => ({ name: branchName(t.branch, taken, n), ci: "none", ciMin: null, ...stateOf(t) }));
    }
    return withMiss(out);
  }
  return withMiss({ ...base, ...one });
}
// A branch's family: the whole branch name without a version suffix, so build/x, build/x-v2 and build/x-v3 are versions of one thing (the
// re-cut naming is <id>-v<N>). The path stays in it: build/x and admin/x are twins (#C621), two rows, not versions.
export const branchFamily = (branch) => String(branch).toLowerCase().replace(/-v\d{1,3}$/, "");

// #C859 slice 3: the repositories whose stack switch is on, as the evidence job left them beside the mirror it built from the same read of the
// store (collector/store-cards.mjs stacksOn). A file older than STACKS_FRESH_MS, or none, reads as off: the switch off is today's reading.
export const STACKS_FRESH_MS = 30 * 60e3;
export function readStacks(dir, now, read = readTail) {
  try {
    const r = read(join(dir, "stacks.json"), 4096);
    if (!r?.whole) return [];
    const f = JSON.parse(r.text);
    if (!Number.isFinite(f?.at) || f.at > now + 60e3 || now - f.at > STACKS_FRESH_MS || !Array.isArray(f.stacks)) return [];
    return f.stacks.filter((s) => typeof s === "string" && s.length <= 40);
  } catch { return []; }
}

// { cardId: { branch, sha, at, message } }: for each open card, the newest commit with its Board-Id trailer on any branch tip's commits beyond main
// (last 100 per branch), taken from the newest branch first. A branch name that git could take for a flag is never passed to it.
// #C1311 (Manager, 11-19: the stack read ran one `git log` per remote branch, 626 of them, 15 s quiet and 38 s with a suite running): (a) a branch already
// merged into main has an empty log beyond it, so it is never asked; (b) the commits of a branch that carry a Board-Id trailer are kept from run to run
// by the branch's tip AND main's tip (the log is taken beyond main, so a main that moved asks again), and a branch that has not moved is not asked.
// `cache` is { old: { branch: { key, recs } }, next: {} }: old is read, next gets every branch read this run (so a branch that is gone drops out of the file).
// The answer is the same with or without it.
export const STACK_CACHE_MAX_RECS_BYTES = 64 * 1024;
// #C1387: `note` (optional) gets failed = true when a git call FAILED (a failed list is an empty set with failed true, never "no branch is merged").
export function mergedBranches(repo, note = null) {
  try {
    return new Set(String(repo.git(["for-each-ref", "--merged", `${repo.remote}/${repo.main}`, `refs/remotes/${repo.remote}`, "--format=%(refname:lstrip=3)"])).split("\n").map((s) => s.trim()).filter(Boolean));
  } catch { if (note) note.failed = true; return new Set(); }
}
export function stackHeads(repo, tips, open, cache = null, note = null) {
  const heads = {};
  if (!open.size || typeof repo.git !== "function") return heads;
  const mainSha = (repo.tips ?? []).find((t) => t.branch === repo.main)?.sha;
  const merged = mergedBranches(repo, note);
  for (const t of [...tips].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
    if (!/^[A-Za-z0-9._\/-]+$/.test(String(t.branch)) || String(t.branch).startsWith("-")) continue;
    if (merged.has(t.branch)) continue;
    const key =cache && /^[0-9a-f]{40}$/.test(String(t.sha)) && /^[0-9a-f]{40}$/.test(String(mainSha)) ? `${t.sha}:${mainSha}` : null;
    let recs = key && cache.old?.[t.branch]?.key === key && Array.isArray(cache.old[t.branch].recs) ? cache.old[t.branch].recs : null;
    if (!recs) {
      let log = "";
      try { log = String(repo.git(["log", "-100", "--format=%H%x1f%ct%x1f%B%x1e", `${repo.remote}/${t.branch}`, "--not", `${repo.remote}/${repo.main}`])); } catch { if (note) note.failed = true; continue; }
      recs = [];
      for (const rec of log.split("\x1e")) {
        const [sha, at, message] = rec.replace(/^\n/, "").split("\x1f");
        if (!/^[0-9a-f]{40}$/.test(String(sha)) || !boardIdsOf(message).length) continue;
        recs.push({ sha, at: Number(at) * 1000, message });
      }
    }
    if (key && cache.next && JSON.stringify(recs).length <= STACK_CACHE_MAX_RECS_BYTES) cache.next[t.branch] = { key, recs };
    for (const { sha, at, message } of recs) for (const id of boardIdsOf(message)) if (open.has(id) && !heads[id]) heads[id] = { branch: t.branch, sha, at, message };
  }
  return heads;
}
// The cache's file (collector/state.mjs writes it beside the probe's other files): { v: 1, repos: { <repository name>: { <branch>: { key, recs } } } }.
// Anything that is not that shape is dropped on the way in: a bad file is an empty cache, never a failed run.
export const STACK_CACHE_FILE = "stack-heads-cache.json";
export function readStackCache(dir, read = readTail) {
  const out = {};
  try {
    const r = read(join(dir, STACK_CACHE_FILE), 4 * 1024 * 1024);
    if (!r?.whole) return out;
    const f = JSON.parse(r.text);
    if (!plain(f) || f.v !== 1 || !plain(f.repos)) return out;
    for (const [name, branches] of Object.entries(f.repos)) {
      if (!plain(branches)) continue;
      out[name] = {};
      for (const [branch, e] of Object.entries(branches)) {
        if (!plain(e) || !/^[0-9a-f]{40}:[0-9a-f]{40}$/.test(String(e.key)) || !Array.isArray(e.recs)) continue;
        const recs = e.recs.filter((x) => plain(x) && /^[0-9a-f]{40}$/.test(String(x.sha)) && Number.isFinite(x.at) && typeof x.message === "string");
        if (recs.length === e.recs.length) out[name][branch] = { key: e.key, recs };
      }
    }
  } catch { /* none, or not ours: an empty cache */ }
  return out;
}

// #C914: the commits carrying a stack-ready note (the builder's signal, scripts/stack-ready.mjs): `git notes list` prints "<note> <commit>" pairs.
// The collector fetches every notes ref into refs/notes/flight-board/<name>. Any failure (no such ref yet) is no notes.
export const STACK_READY_REF = "refs/notes/flight-board/stack-ready";
export function stackReadyCommits(repo) {
  try {
    return String(repo.git(["notes", `--ref=${STACK_READY_REF}`, "list"])).split("\n").map((l) => l.trim().split(/\s+/)[1]).filter((c) => /^[0-9a-f]{40}$/.test(String(c)));
  } catch { return []; }
}
// #C1102 (d): the commits carrying a stack-ready WAITING note (scripts/stack-ready.mjs, #C1066): the builder declared READY and was told to wait for its group. Not a signal.
export const STACK_WAITING_REF = "refs/notes/flight-board/stack-ready-waiting";
export function stackWaitingCommits(repo) {
  try {
    return String(repo.git(["notes", `--ref=${STACK_WAITING_REF}`, "list"])).split("\n").map((l) => l.trim().split(/\s+/)[1]).filter((c) => /^[0-9a-f]{40}$/.test(String(c)));
  } catch { return []; }
}

// #C1379: a card of a product repository closed before it read live (71 closed at "ship" under #C1104 part 2, which #C1378 removed) is read again, with the open cards, until a
// run reads it live; `closedLive` (closed-live.json, kept from run to run) names the ones that have. Only a done, undropped card with a named non-board repository, closed
// within REREAD_DONE_MS (14 days from done_at, Manager's bound): a card that never reads live (reverted, its version lost) is read until that day and then no more, and one that
// reads live stops at once (closed-live.json). done_at is the store's and never changes here: the reading is all that is added.
export const REREAD_DONE_MS = 14 * 86_400_000;
export const rereadClosed = (k, closedLive, now) => k?.status === "done" && typeof k.repo === "string" && k.repo.trim() !== "" && !isBoardRepo(k.repo)
  && !(closedLive instanceof Set ? closedLive : new Set(closedLive ?? [])).has(k.id) && Number.isFinite(k.doneAt) && now - k.doneAt <= REREAD_DONE_MS;
// The closed-live memory, as pure functions the run loop calls (Checker 2's F2 on 653321f5: the file's read and write had no test of their own).
// closedLiveFrom: the ids a closed-live.json text names (anything unreadable or of another shape: none). closedLiveNext: the ids to write after a run, or null when nothing
// changed: the old ones plus the closed product cards (rereadClosed) whose reading this run is the live phase. openStates: the states of the open cards only.
export const closedLiveFrom = (text) => { try { const o = JSON.parse(text); return new Set(Array.isArray(o?.ids) ? o.ids.filter((x) => typeof x === "string") : []); } catch { return new Set(); } };
export function closedLiveNext({ cards, closedLive, states, livePhase, now }) {
  const before = closedLive instanceof Set ? closedLive : new Set(closedLive ?? []);
  const nowLive = (cards ?? []).filter((k) => closed(k) && rereadClosed(k, before, now) && states?.[k.id]?.phase === livePhase).map((k) => k.id);
  return nowLive.length ? [...new Set([...before, ...nowLive])].slice(-5000) : null;
}
// A re-read closed card's reading is posted with the open cards' (the store keeps it), but the watch's truth lines, the evidence clock and the phase clashes are about open cards: a done card
// that reads live is not "CLOSE <card>" news (Checker 2's F1: 25 of them filled the line limit and pushed the real SHIP and GAP lines out).
export const openStates = (cards, states) => { const open = new Set((cards ?? []).filter((k) => !closed(k)).map((k) => k.id)); return Object.fromEntries(Object.entries(states ?? {}).filter(([id]) => open.has(id))); };
export function cardStates({ cards, config, repos, now, stacks = [], pairs = [], pairsUnread = false, stackCache = null, closedLive = new Set() }) {
  const out = {}, repoOfCard = {}, cardOf = {}, todo = [];
  const readable = (k) => CARD_ID.test(String(k.id)) && k.id.length <= CARD_ID_MAX;
  for (const card of [...cards.filter((k) => !closed(k) && readable(k)).slice(0, MAX_CARDS), ...cards.filter((k) => closed(k) && readable(k) && rereadClosed(k, closedLive, now))]) {
    const r = repoOf(card, config);
    let repo = repos[r ? r.name : ""] ?? null;
    // #C632: a card with no repo field and no id prefix of a listed repository belongs to the one whose branches name it
    // (a Board-Id trailer or a branch named for it): the team's own if it has one, else the repository with the newest tip;
    // none has one: the team's own, as before. #C985: a word that names no listed repository counts as none.
    if (!r && !namedRepo(card, config)) {
      const tipOf = (x) => headsFor(card.id, (x.tips ?? []).filter((h) => h.branch !== x.main), card.num)[0];
      const found = Object.values(repos).map((x) => [x, tipOf(x)]).filter(([, t]) => t).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))[0];
      if (found && !(repo && tipOf(repo))) repo = found[0];
    }
    todo.push([card, repo]);
    repoOfCard[card.id] = repo;
    cardOf[card.id] = card;
  }
  // #C1044: a group branch holds one commit per member card, but the tip names only the last one: the other members never found a head and read as
  // not built, so stack-ready and the dispatch's batch hold waited forever. For a branch whose tip's card has a batch, the Board-Id trailer of every
  // commit in main..tip gives each open batched card with no head of its own that commit as its head (stackHeads). A single-card branch is unchanged.
  const batchOf = (c) => (typeof c?.batch === "string" && c.batch.trim() !== "" ? c.batch.trim() : "");
  const batchedIds = new Set(todo.map(([c]) => c).filter((c) => batchOf(c)).map((c) => c.id));
  const wantsHead = new Map();
  for (const [card, repo] of todo) {
    if (!repo || typeof repo.git !== "function" || !batchedIds.has(card.id)) continue;
    if (headsFor(card.id, (repo.tips ?? []).filter((h) => h.branch !== repo.main), card.num).length) continue;
    if (!wantsHead.has(repo)) wantsHead.set(repo, new Set());
    wantsHead.get(repo).add(card.id);
  }
  const groupHead = {}, groupUnread = new Set();
  for (const [repo, ids] of wantsHead) {
    const groupTips = (repo.tips ?? []).filter((h) => h.branch !== repo.main && batchedIds.has(boardIdOf(h.message)));
    // #C1387: a read of the group's branches that failed leaves its members with no head: they say unread "stack", not "not built".
    const gn = {};
    Object.assign(groupHead, stackHeads(repo, groupTips, ids, null, gn));
    if (gn.failed) for (const id of ids) groupUnread.add(id);
  }
  const markUnread = (o, src) => ({ ...o, unread: [...new Set([...(o.unread ?? []), src])].sort() });
  // The group tip's notes cover every member under it (design 4, as the stack path does: one review per group, #C1032), so the cover is the full sha of the
  // tip of the branch the head was found on; a FINDINGS on the tip reaches the members the same way (tipState).
  const coverOf = (repo, head) => (repo.tips ?? []).find((t) => t.branch === head.branch)?.sha ?? null;
  for (const [card, repo] of todo) { out[card.id] = cardState(card, repo, config, now, groupHead[card.id] ? { head: groupHead[card.id], cover: coverOf(repo, groupHead[card.id]) } : {}); if (groupUnread.has(card.id) && !groupHead[card.id]) out[card.id] = markUnread(out[card.id], "stack"); }
  // #C859 slice 2: for a repository whose stack switch is on (`stacks`: the repository names, "" for the team's own), the stack read from git.
  // Nothing is added for a switch that is off, which is the default: the switch off is today's reading.
  for (const name of stacks) {
    const repo = repos[name];
    if (!repo || typeof repo.git !== "function") continue;
    const tips = (repo.tips ?? []).filter((t) => t.branch !== repo.main);
    // A card in the middle of a chain has its commit on the branch but not at its tip, and the branch is not named for it: headsFor does not
    // find it. The stack reads every commit the branch holds beyond main (its last 100) for the Board-Id trailers of the repository's open cards.
    const open = new Set(Object.keys(out).filter((id) => repoOfCard[id] === repo && !out[id].onMain));
    const sn = {}; // #C1387: sn.failed is set when a stack read FAILED (the branches' commits, the merged list, an ancestry question): every open card of the repository then says unread "stack"
    const found = stackHeads(repo, tips, open, stackCache ? { old: stackCache.old?.[name] ?? {}, next: (stackCache.next[name] = {}) } : null, sn);
    const heads = Object.fromEntries(Object.entries(found).map(([id, h]) => [id, h.sha]));
    for (const id of open) if (!heads[id] && out[id].headSha12) heads[id] = out[id].headSha12;
    // #C1311 (measured 11-19: readStack asked `merge-base --is-ancestor` once per branch tip per head, 627 x 6, about 3800 calls and 27 s): a head is asked of
    // the branch TIPS in one `for-each-ref --contains <head>` (every tip that holds it), once per head. For any other second argument (a commit that is no
    // tip), or when git refuses the head, the old single question is asked, so the answer is the same in every case.
    const tipShas = new Set((repo.tips ?? []).map((t) => t.sha));
    const holders = new Map();
    const holdersOf = (a) => {
      if (!holders.has(a)) {
        let set = null;
        if (/^[0-9a-f]{12,40}$/.test(String(a))) { try { set = new Set(String(repo.git(["for-each-ref", "--contains", a, `refs/remotes/${repo.remote}`, "--format=%(objectname)"])).split("\n").map((s) => s.trim()).filter(Boolean)); } catch { set = null; } }
        holders.set(a, set);
      }
      return holders.get(a);
    };
    // #C1387: git's exit 1 is "no"; any other failure answers false here (the shape of the stack) AND marks the stack unread; `quiet` is for the stackHold question, whose noted commits may be pruned (not a read failure).
    const ancestorOf = (a, b, quiet) => {
      if (a === b || String(b).startsWith(a)) return true;
      if (tipShas.has(b)) { const held = holdersOf(a); if (held) return held.has(b); }
      const r = ancestry(() => repo.git(["merge-base", "--is-ancestor", a, b]));
      if (r === null && !quiet) sn.failed = true;
      return r === true;
    };
    const isAncestor = (a, b) => ancestorOf(a, b, false);
    const stack = readStack({ heads, tips, isAncestor });
    const fields = stackFields(stack);
    // #C1209: with no member's commit at the stack tip, the topmost member (every other member's head is under it) is asked the behind-main question for the tip.
    const members = stack?.members ?? [];
    const tipless = members.length > 1 && !members.some((id) => isAncestor(stack.tip, heads[id]) );
    const topId = tipless ? members.find((id) => members.every((o) => isAncestor(heads[o], heads[id]))) : null;
    for (const [id, field] of Object.entries(fields)) {
      // A member is read again at its own commit with the stack tip as cover (design 4: a note on the tip counts for every card under it),
      // and a middle-of-chain card, which the first pass could not find, is read at the commit its trailer names. An outsider keeps its reading.
      const again = field.outside ? out[id] : cardState(cardOf[id], repo, config, now, { head: found[id], cover: stack.tip, ...(id === topId ? { nudgeTop: true } : {}) });
      out[id] = { ...again, stack: field };
    }
    // #C914: stackHold marks a pushed card of this stack-mode repository that no stack-ready signal (scripts/stack-ready.mjs) covers: its head is not
    // the noted commit or under it (stack-ready notes the head of every started member of the group or stack it signals, so a member built before the last card is covered at that head, and a later push of it is not). It is a fact for the dispatch, which holds the card's review and build turns (#C1066: every pushed card of a stack-mode repository, not only one with a partner). Not for a card whose
    // head was committed before STACK_HOLD_FROM, one that already carries a review note or findings, or an outsider. The card's `stack` field is left as
    // it is (the page draws it). Same input, same answer: no clock.
    const noted = stackReadyCommits(repo), waiting = stackWaitingCommits(repo);
    // #C1311: "is this head at or under a noted commit" was one `git merge-base --is-ancestor` per open card per noted commit (about 400 calls and 2 s a run in the
    // measurement of 11-19, growing with every note). The commits reachable from the noted ones are listed in ONE rev-list, and a head is under a noted commit
    // when it is in that list (a head may be a 12-character prefix, as isAncestor reads it). Checker 2's F1: a note stays on a commit after its branch is re-cut, deleted
    // and pruned, so a noted commit git no longer has is the common case, not the rare one: --ignore-missing leaves it out of the list (it holds nothing a head could be
    // under), and a rev-list git still refuses falls back to the pairs, so the answer is the same in every case.
    let notedReach = null;
    if (noted.length) { try { notedReach = String(repo.git(["rev-list", "--ignore-missing", ...noted])).split("\n").filter((s) => /^[0-9a-f]{40}$/.test(s)); } catch { notedReach = null; } }
    const underNoted = (h) => (notedReach ? notedReach.some((s) => s.startsWith(String(h))) : noted.some((c) => ancestorOf(h, c, true)));
    const headAt = (id) => {
      if (Number.isFinite(found[id]?.at)) return found[id].at;
      try { return Number(String(repo.git(["log", "-1", "--format=%ct", heads[id]])).trim()) * 1000; } catch { return NaN; }
    };
    for (const id of open) {
      if (!heads[id] || fields[id]?.outside || out[id].signed?.length || out[id].findings?.length) continue;
      if (!(headAt(id) >= STACK_HOLD_FROM)) continue; // before the cutoff, or a time git would not give: today's reading
      if (underNoted(heads[id])) continue;
      // #C1102 (d): a held card whose EXACT head carries a waiting note is built: its builder ran stack-ready and was told to wait for the group (or a card queued behind it).
      // The page reads it as "built, waiting" rather than building; a later push has no note and reads as building again.
      // The head is the same commit as a noted one (#C1126, Security I1): the noted sha is always 40 characters, the head 12 to 40, so only the noted sha may extend the head, never the other way.
      const sameCommit = (c, h) => /^[0-9a-f]{12,40}$/.test(String(h)) && c.startsWith(String(h));
      // #C1160: one reading of "ready" for everyone: a held card has no READY yet, so it reads at build (phase and lit) with no readyAt and no waitingFor, as a WIP head does; the tile, the stall
      // checks, the slow-wake rule, the open-group rule and the dependency checks all read these fields, so they agree with the dispatch, which holds its review turn.
      const { readyAt: _r, waitingFor: _w, ...held } = out[id];
      out[id] = { ...held, ...(held.phase && held.onMain !== true ? { phase: config.collector.buildPhase, firm: false } : {}), stackHold: true, ...(waiting.some((c) => sameCommit(c, heads[id])) ? { builtWaiting: true } : {}) };
    }
    if (sn.failed) for (const id of open) out[id] = markUnread(out[id], "stack");
  }
  // #C1020: a board-repository card on main shows packed and installed from the deploy pairs (pairsIn, the owner's pair folder) and git alone:
  // packed when a pair's pin holds its landing, installed when such a pair's deploy ran. Never for a card of another repository, nor one not on main.
  const board = Object.entries(repos).find(([name]) => isBoardRepo(name))?.[1];
  // #C1395: the pair folder or a git question about it that could not be answered is unread "pair" (never "not packed"): git's exit 1 is the plain no (status 1), any other failure status null; the folder
  // itself unread (pairsUnread) marks every such card. A live card, and one that needs no install, rests on neither: only the card waiting at pack or install is marked.
  if (board && typeof board.git === "function" && (pairs.length || pairsUnread)) {
    const git = (args) => { const r = ancestry(() => board.git(args)); return { status: r === true ? 0 : r === false ? 1 : null }; };
    for (const id of Object.keys(out)) {
      // The card's own repo word names the board (as the dispatch's pair turn reads it), and it was read from the board's checkout.
      if (!isBoardRepo(cardOf[id].repo) || repoOfCard[id] !== board || out[id].onMain !== true || !out[id].headSha) continue;
      const waits = out[id].phase !== config.collector.livePhase && out[id].noInstall !== true;
      if (pairsUnread) { if (waits) out[id] = markUnread(out[id], "pair"); continue; }
      const pn = {}, p = packOf(pairs, out[id].headSha, git, pn);
      if (pn.failed) { if (waits) out[id] = markUnread(out[id], "pair"); continue; }
      if (p.packed) out[id] = { ...out[id], packed: true, ...(p.pack ? { pack: p.pack } : {}), ...(p.installed ? { installed: true } : {}) };
    }
  }
  return out;
}

// The lead's wake watch as two times (#C590): its heartbeat (wake-watch.alive.json) and the last wake it handled
// (wake-seen.json, the wake's own time). Times only; a missing, odd or future time is none.
export function wakeTimes(dir, now) {
  const time = (name) => {
    const r = readTail(join(dir, name), 4096);
    if (!r?.whole) return null;
    try { const t = JSON.parse(r.text)?.at; return Number.isInteger(t) && t >= 1577836800000 && t <= now + 60e3 ? t : null; } catch { return null; }
  };
  return { wakeAlive: time(ALIVE_FILE), wakeSeen: time(SEEN_FILE) };
}

// When the cards were last checked (#C591): this run's time when every repository was read fresh (repo.fresh, not false),
// else the last time that was so (a repository GitHub could not be reached for leaves the time behind, and the page's chip
// goes red at 5 minutes). none when there never was one.
export function cardsCheckedAt(repoList, now, before) {
  if (repoList.every((r) => r.fresh !== false)) return now;
  return Number.isInteger(before) && before >= 1577836800000 && before <= now ? before : null;
}

// The cards whose phase the repository shows differently from the typed one (#C594): the board's export has one, the probe
// reads another from the card's tip and sign-offs (the card has a head, so it is evidence, not the declared phase echoed).
// The collector run is for these; the clock is not. Ids only, sorted, at most 10.
export function phaseClashIds(cards, states) {
  const out = [];
  for (const card of cards) {
    const s = Object.hasOwn(states, card.id) ? states[card.id] : null;
    if (s && s.headSha12 && typeof card.phase === "string" && card.phase && card.phase !== s.phase) out.push(card.id);
  }
  return out.sort().slice(0, 10);
}

// The pinned script: the file's sha256 is the config's (Security, as for the keeper's prompt), read as a regular file of this
// user's and never followed through a link. False without either, or on any difference.
// The bytes read are the bytes run (python3 -I - on stdin), so the file can't be swapped between the check and the run
// (Security). The script's text when it is the pinned one, else null.
export function pinnedScript(path, sha256, uid = process.getuid()) {
  if (!path || !/^[0-9a-f]{64}$/.test(String(sha256 ?? ""))) return null;
  const r = readTail(path, 1024 * 1024, uid);
  return r?.whole && createHash("sha256").update(r.text, "utf8").digest("hex") === sha256 ? r.text : null;
}
export const scriptMatches = (path, sha256, uid) => pinnedScript(path, sha256, uid) !== null;
// How old the board export may be for the asks (#C584): the answer gate's own 2 h.
export const MIRROR_STALE_MS = 2 * 3600e3;
export const mirrorFresh = (exportedAt, now, maxMs = MIRROR_STALE_MS) => Number.isFinite(exportedAt) && exportedAt > 0 && exportedAt <= now + 60e3 && now - exportedAt <= maxMs;
// The usage tile (#C595): the spend script run every USAGE_EVERY_MS (python3 -I -, its text on stdin, its --json rows only; it
// reads the transcripts in about 2 s), kept in <dir>/usage.json between runs. It ran once a day until #C623 (the tile read 24%
// at 31% used, with no age shown). The week is the config's: usageResetAt is any one weekly reset, so the week now runs from
// the last one to the next, and the script is asked for that span (--since); week % is its weighted total over usageQuota,
// and pace follows from how much of the week is gone. Nothing needs the app or a model. A script that fails leaves the last
// tile, which then ages (asOf is the last good run; the page greys the tile past 15 minutes); a week that rolled over runs it
// again at once. A run that fails is not tried again for 10 minutes, then 20, and so on to a day (failUntil, wait: Checker found
// it retrying every minute), and a script that isn't the pinned one (scriptText is null: its sha256 against
// collector.usageScriptSha256, Security) is never run. { tile, save, rows, total, resetsAt, asOf }: save is the usage.json to
// write (null: nothing changed).
export const USAGE_EVERY_MS = 5 * 60e3, WEEK_SPAN_MS = 7 * 24 * 3600e3, USAGE_RETRY_MIN_MS = 10 * 60e3, USAGE_RETRY_MAX_MS = 24 * 3600e3;
export function nextReset(anchorIso, now) {
  const a = Date.parse(anchorIso ?? "");
  if (!Number.isFinite(a)) return null;
  // The next reset after now, whichever side of it the anchor is on: an anchor weeks ahead folds back by whole weeks.
  return a + Math.ceil((now - a + 1) / WEEK_SPAN_MS) * WEEK_SPAN_MS;
}
export function usageTile({ scriptText = null, dir, roster, now, run, quota = 0, resetAt = "" }) {
  const read = (name) => { const r = readTail(join(dir, name), 64 * 1024); try { return r?.whole ? JSON.parse(r.text) : null; } catch { return null; } };
  const kept = read("usage.json");
  const resetsAt = nextReset(resetAt, now);
  const fresh = plain(kept) && Number.isInteger(kept.ranAt) && kept.ranAt <= now && now - kept.ranAt < USAGE_EVERY_MS && Array.isArray(kept.rows) && (kept.resetsAt ?? null) === resetsAt;
  const failUntil = plain(kept) && Number.isInteger(kept.failUntil) && kept.failUntil > 0 ? kept.failUntil : 0;
  const wait = plain(kept) && Number.isInteger(kept.wait) ? Math.min(USAGE_RETRY_MAX_MS, Math.max(USAGE_RETRY_MIN_MS, kept.wait)) : USAGE_RETRY_MIN_MS;
  let rows = fresh ? kept.rows : null, total = fresh ? kept.total : null, save = null;
  if (!rows && typeof scriptText === "string" && now >= failUntil) {
    try {
      const since = new Date(resetsAt ? resetsAt - WEEK_SPAN_MS : now - WEEK_SPAN_MS).toISOString().slice(0, 16);
      const out = JSON.parse(run(["-I", "-", "--json", "--since", since], scriptText));
      rows = Array.isArray(out?.rows) ? out.rows.map((r) => ({ source: String(r?.source ?? "").slice(0, 80), share: r?.share })) : null;
      total = Number.isFinite(out?.total_weighted) && out.total_weighted >= 0 ? out.total_weighted : null;
    } catch { rows = null; }
    if (rows) save = { ranAt: now, rows, total, resetsAt };
    else save = { ranAt: plain(kept) && Number.isInteger(kept.ranAt) ? kept.ranAt : null, rows: plain(kept) && Array.isArray(kept.rows) ? kept.rows : null, total: plain(kept) ? kept.total ?? null : null, resetsAt: plain(kept) ? kept.resetsAt ?? null : null, failUntil: now + wait, wait: Math.min(USAGE_RETRY_MAX_MS, wait * 2) };
  }
  if (!rows && plain(kept) && Array.isArray(kept.rows)) { rows = kept.rows; total = kept.total ?? null; }
  if (!rows) return { tile: null, save, rows: null, total: null, resetsAt, asOf: null };
  // The time the numbers are of: this run's, or the last good one kept (a failed run, or one still to come, leaves it).
  const ranAt = Number.isInteger(save?.ranAt) ? save.ranAt : plain(kept) && Number.isInteger(kept.ranAt) ? kept.ranAt : null;
  const asOf = ranAt !== null && ranAt <= now ? ranAt : null;
  const plan = quota > 0 && resetsAt && Number.isFinite(total) ? { weekPct: (total / quota) * 100, resetsAt } : null;
  return { tile: usageReading({ rows, roster, plan, now, asOf, total }), save, rows, total, resetsAt, asOf };
}

// The state that leaves, checked against the allowlist before it does.
// #C731 B4b: the release log's CI times by version (a copy of collector/facts.mjs's releaseTimes, which this pinned file cannot import):
// each row of the log (collector.releaseTimes, read on main) that names a version and both run times, the newest MAX_RELEASES kept.
export function releaseTimesOf(git, ref, path) {
  if (typeof path !== "string" || !path || path.startsWith("-") || path.split("/").includes("..")) return null;
  let text = "";
  try { text = git(["show", `${ref}:${path}`]); } catch { return null; }
  const rows = [];
  for (const line of String(text).split("\n").slice(-5000)) {
    const cells = line.split("|").map((s) => s.trim());
    const v = /^v?(\d{1,4}\.\d{1,4}\.\d{1,4})$/.exec(cells[2] ?? "");
    const m = /(?:candidate|dev) run (\d{1,6}(?:\.\d{1,3})?) min, main run (\d{1,6}(?:\.\d{1,3})?) min/.exec(line);
    if (v && m) rows.push([v[1], { testsMin: Number(m[1]), deployMin: Number(m[2]) }]);
  }
  const out = Object.fromEntries(rows.slice(-MAX_RELEASES));
  return Object.keys(out).length ? out : null;
}
export function buildState({ id, now, probe, pageVersion, cards, agents, lastWrite = null, wakeAlive = null, wakeSeen = null, cardsChecked = null, evidence = null, ctx = null, stuck = null, watch = null, usage = null, ship = null, releases = null, published = null }) {
  const s = { v: STATE_VERSION, board: { boardId: id, at: now, probe: sha12(probe), pageVersion: sha12(pageVersion), lastWriteAt: lastWrite, wakeAliveAt: wakeAlive, wakeSeenAt: wakeSeen, cardsCheckedAt: cardsChecked, ...(evidence === null ? {} : { evidenceAt: evidence }), ...(published ? { derivedAt: published.at, quietMin: published.quietMin } : {}) }, cards, agents, ...(ctx ? { ctx } : {}), ...(stuck ? { stuck } : {}), ...(usage ? { usage } : {}), ...(ship ? { ship } : {}), ...(releases ? { releases } : {}) };
  const errs = stateErrors(s);
  if (errs.length) throw new Error(`the state doesn't fit the plan (${errs.length} problem(s), first: ${errs[0]})`);
  // #C1005 part c: the watch reading rides along only when it fits; one that doesn't is dropped, never the whole state (a bad ledger line must not stop the board).
  if (watch && !stateErrors({ ...s, watch }).length) return pickState({ ...s, watch });
  return pickState(s);
}

// The board's token and the Worker's address, from the owner's install: the folder 0700 and the file 0600, both this
// user's and neither a link. { url, token } or null.
export const secretsDir = (stateDir, id) => join(stateDir, id, "state-secrets");
export function readSecrets(dir, uid = process.getuid()) {
  try {
    const d = lstatSync(dir);
    if (!d.isDirectory() || d.uid !== uid || (d.mode & 0o777) !== 0o700) return null;
    const p = join(dir, "secrets.json"), f = lstatSync(p);
    if (!f.isFile() || f.uid !== uid || (f.mode & 0o777) !== 0o600 || f.size > 4096) return null;
    const s = JSON.parse(readFileSync(p, "utf8"));
    if (!plain(s) || !/^[0-9a-f]{64}$/.test(String(s.token ?? "")) || !/^https:\/\/[A-Za-z0-9.-]{1,200}$/.test(String(s.url ?? ""))) return null;
    return { url: s.url, token: s.token };
  } catch { return null; }
}

// The POST: https only, no redirect, 15 s at most. Its one line says the Worker's status, never the token. One that
// can't reach the Worker tries once more RETRY_MS later (#C428: a passing network blip left the panel a minute stale);
// an answer, any status, is final. Both tries end well inside launchd's minute.
export const RETRY_MS = 5_000;
export async function postState(fetchImpl, secrets, id, state, wait = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const body = JSON.stringify(state);
  if (Buffer.byteLength(body) > MAX_BYTES) return "state: not posted (over 64 KB)";
  for (let k = 0; k < 2; k++) {
    if (k) await wait(RETRY_MS);
    try {
      const r = await fetchImpl(`${secrets.url}/b/${id}/state`, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${secrets.token}`, "content-type": "application/json" }, body, signal: AbortSignal.timeout(15_000) });
      return `${r.status === 204 ? "state: posted" : `state: the Worker answered ${Number(r.status)}`}${k ? " (on the second try)" : ""}`;
    } catch { /* tried below, once */ }
  }
  return "state: the Worker could not be reached (tried twice)";
}

// The owner's latest wake (#C580, gate/wake.mjs): GET /b/<board id>/wake with the board's token, https only, no redirect,
// 10 s at most. { seq, at } or null; one line for the log, never the token. Kept apart from the state POST, so a state
// that didn't post (the Worker's rate limit, a heartbeat's 204) never hides a wake.
export async function getWake(fetchImpl, secrets, id) {
  try {
    const r = await fetchImpl(`${secrets.url}/b/${id}/wake`, { method: "GET", redirect: "error", headers: { authorization: `Bearer ${secrets.token}` }, signal: AbortSignal.timeout(10_000) });
    if (r.status !== 200) return { wake: null, line: `wake: the Worker answered ${Number(r.status)}` };
    const j = await r.json();
    const wake = { seq: j?.seq, at: j?.at };
    return nextWakeFile(wake, null) ? { wake, line: null } : { wake: null, line: "wake: the Worker's answer isn't a counter" };
  } catch { return { wake: null, line: "wake: the Worker could not be reached" }; }
}

const writeAtomic = (path, text) => { const tmp = `${path}.${process.pid}.part`; writeFileSync(tmp, text, { mode: 0o600, flag: "wx" }); renameSync(tmp, path); };

// #C974 (Manager's A on the card, 11-11 ~11 pm MT; #C897: reviewPaths went into the live config before review and skipped the Language review on
// Spanish files): the team's config is a file in the team's repository (collector.configInRepo, e.g. "board/board.config.json"), changed by a branch,
// signed and landed like code. Each minute the probe copies the copy on main over the live file every reader is given (--config), so only what
// landed goes live. Never blanks it: a copy missing on main, unreadable or refused by checkConfig leaves the live file as it is, and the line says why.
// Security's F1 on 795328c: main may change only the rule fields in RULE_FIELDS. Every other field keeps the live copy's value, new fields
// included: the session ids, the board's addresses (storeUrl, artifactUrl), the paths the probe runs git in, writes to or runs a script from
// (repoPath, outDir, repos, refresh, keeper, gate.stateDir, usageScript and its sha256), the notes refs, remote, mainBranch and configInRepo itself.
// Security's F2: reviewPaths and skips sit in the same file, so a change could drop its own review. A change is taken only when the commit that
// last changed the file on main (lastChange()) carries a note starting "SECURE" in the live config's security notes ref (securityNote(sha)).
// show() -> the file's text on main (throws when git has none); liveText: the live file's text. Pure: { text: new live text or null, line }.
export const RULE_FIELDS = Object.freeze({
  top: ["title", "owner", "resetAt", "contextWindows", "phases", "roster", "order", "skips", "boardStart", "prAgent", "usageNote", "runnerLabel", "automationLabel", "nudges", "traffic", "repos", "cardFields", "decisions"],
  gate: ["managerRole", "cardOwners", "keeperRole", "reviewerRole", "releaseRole", "transientPrefixes", "verdictWords", "mirrorMaxAgeMin", "requireUpdatedAt"],
  collector: ["contextRoles", "reviewPaths", "buildPhase", "shipPhase", "livePhase", "deployWorkflow", "lanePhases", "versionPattern", "shippedPattern", "candidatePattern", "releaseTimes", "usageQuota", "usageResetAt", "quotaCeilingPct", "liveTag"],
});
const takeRules = (into, from, keys) => { for (const k of keys) { if (from[k] !== undefined) into[k] = from[k]; else delete into[k]; } };
export function teamConfigSync({ show, liveText, file, lastChange, securityNote }) {
  let live;
  try { live = JSON.parse(liveText); } catch { return { text: null, line: "config: the live copy does not parse; not replaced" }; }
  if (!plain(live)) return { text: null, line: "config: the live copy is not an object; not replaced" };
  let main;
  try { main = JSON.parse(show()); } catch { return { text: null, line: `config: no readable ${file} on main; the live copy is kept` }; }
  if (!plain(main)) return { text: null, line: `config: ${file} on main is not an object; the live copy is kept` };
  const mainProblems = checkConfig(main);
  if (mainProblems.length) return { text: null, line: `config: ${file} on main is refused (${String(mainProblems[0]).slice(0, 120)}); the live copy is kept` };
  const merged = structuredClone(live);
  takeRules(merged, main, RULE_FIELDS.top);
  for (const sec of ["gate", "collector"]) {
    if (!plain(merged[sec]) && !plain(main[sec])) continue;
    const into = plain(merged[sec]) ? merged[sec] : {};
    takeRules(into, plain(main[sec]) ? main[sec] : {}, RULE_FIELDS[sec]);
    if (Object.keys(into).length) merged[sec] = into; else delete merged[sec];
  }
  const problems = checkConfig(merged);
  if (problems.length) return { text: null, line: `config: ${file} on main is refused (${String(problems[0]).slice(0, 120)}); the live copy is kept` };
  if (JSON.stringify(merged) === JSON.stringify(live)) return { text: null, line: null };
  let sha = null, note = null;
  try { sha = String(lastChange() ?? "").trim(); } catch { sha = null; }
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) return { text: null, line: `config: no commit on main found for ${file}; the live copy is kept` };
  try { note = securityNote(sha); } catch { note = null; }
  if (typeof note !== "string" || !isSignoff(note, "security")) return { text: null, line: `config: ${file} last changed on main in ${sha.slice(0, 7)}, which carries no SECURE note; the live copy is kept` };
  return { text: `${JSON.stringify(merged, null, 2)}\n`, line: `config: the live copy now takes the rules in ${file} on main (${sha.slice(0, 7)}, SECURE)` };
}

// Checker's F1 on 804d6ff: the git half of the sync, with git as a parameter so a test runs it on a real repository. tip: "<remote>/<main>";
// notesRef: the local ref the security notes were fetched into. Writes the live file only when teamConfigSync gives new text; returns the
// line to print (or null). A failure never stops the probe's run: it is the line.
export function syncLiveConfig({ git, tip, file, notesRef, livePath }) {
  try {
    const s = teamConfigSync({
      show: () => git(["show", `${tip}:${file}`]), liveText: readFileSync(livePath, "utf8"), file,
      lastChange: () => git(["log", "-1", "--format=%H", tip, "--", file]),
      securityNote: (sha) => { if (!notesRef) return null; try { return String(git(["notes", `--ref=${notesRef}`, "show", sha])); } catch { return null; } },
    });
    if (s.text) writeAtomic(livePath, s.text);
    return s.line;
  } catch (e) { return `config: not synced (${String(e?.code ?? e?.message ?? e).slice(0, 80)})`; }
}

// #C996: the run's timing as one line: "timing: caches=12 repos=830 ... fetch=420 tips=35 cards#61 tips#188 ...". Phase and count names are fixed words
// (a letter then letters or digits, up to 12), every value a whole number: nothing a card, a session or a path could put in it. The evidence job
// logs exactly this shape (collector/probe-evidence.mjs timingOf) and drops any line that is not.
export function timingText(laps, sums, counts) {
  const word = (k) => /^[a-z][A-Za-z0-9+]{0,11}$/.test(k);
  const whole = (n) => (Number.isFinite(n) && n >= 0 ? Math.round(n) : 0);
  return `timing: ${[...laps.filter((l) => word(l.split("=")[0])), ...Object.entries(sums).filter(([k]) => word(k)).map(([k, v]) => `${k}=${whole(v)}`), ...Object.entries(counts).filter(([k]) => word(k)).map(([k, v]) => `${k}#${whole(v)}`)].join(" ")}`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const at = process.argv.indexOf("--config");
  let config;
  try {
    const raw = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
    const problems = checkConfig(raw);
    if (at < 0 || problems.length) throw new Error(problems.join("; ") || "no --config");
    config = fullConfig(raw);
  } catch (e) { console.error(`state: ${String(e.message).split("\n")[0]}`); process.exit(1); }
  const id = boardId(config), now = Date.now(), c = config.collector, stateDir = home(config.gate.stateDir);
  if (!id) { console.error("state: the config has no board link"); process.exit(1); }
  const fetchIt = !process.argv.includes("--no-fetch");
  // #C996: where the run's time goes. One "timing:" line at the end (to the evidence job's log): phase names and whole milliseconds, then counts,
  // and nothing of a card, a session or a path. Each lap is the time since the one before it; fetch and tips add up over every repository.
  let lapAt = performance.now();
  const laps = [], lap = (name) => { const t = performance.now(); laps.push(`${name}=${Math.round(t - lapAt)}`); lapAt = t; };
  let fetchMs = 0, tipsMs = 0;
  const timingLine = (counts = {}) => timingText(laps, { fetch: fetchMs, tips: tipsMs }, counts);
  const run = (cwd) => (bin, timeout) => (args) => execFileSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout, maxBuffer: 64 * 1024 * 1024 });
  const repoAt = (path, remote, main, notes) => {
    const git = run(path)("git", 30_000);
    // fresh: this run read the repository as GitHub has it now (#C591): the fetch and the tips both worked.
    let fresh = true;
    const f0 = performance.now();
    if (fetchIt) { try { git(fetchBranches(remote)); git(["fetch", "-q", remote, "+refs/notes/*:refs/notes/flight-board/*"]); } catch { fresh = false; /* read what is here */ } }
    fetchMs += performance.now() - f0;
    const local = Object.fromEntries(Object.entries(notes).map(([p, ref]) => [p, `refs/notes/flight-board/${ref.slice("refs/notes/".length)}`]));
    let tips = [];
    const t0 = performance.now();
    try { tips = remoteTips(git, remote); } catch { fresh = false; /* an empty clone */ }
    tipsMs += performance.now() - t0;
    // #C996 part 3: every read after the fetch goes through the run's memo, and the repository's trailers are indexed once (trailerIndex).
    return { git: memoGit(git), indexed: true, gh: run(path)("gh", 15_000), remote, main, notes: local, tips, ids: changeIds, fresh };
  };
  // Finished CI runs, kept by commit from run to run (the newest 500).
  const ciPath = join(stateDir, id, "ci-cache.json");
  // Each commit's change id (landedOn), kept from run to run (the newest 5000): a commit is read once, not every minute.
  const idsPath = join(stateDir, id, "change-ids.json");
  let changeIds = {};
  try { const r = readTail(idsPath, 2 * 1024 * 1024); const o = r?.whole ? JSON.parse(r.text) : null; if (plain(o)) changeIds = Object.fromEntries(Object.entries(o).filter(([k, v]) => /^[0-9a-f]{40}$/.test(k) && (v === null || /^[0-9a-f]{64}$/.test(String(v))))); } catch { /* start afresh */ }
  // gh's back-off after a failed call (#C591), kept from run to run.
  const backoffPath = join(stateDir, id, "gh-backoff.json");
  let backoff = backoffOf(null);
  try { const r = readTail(backoffPath, 4096); if (r?.whole) backoff = backoffOf(JSON.parse(r.text)); } catch { /* none */ }
  // The ship-run read's own back-off (a good run-list read must not clear the CI reads' one: Security's note on 47cdc89), kept
  // for this run only: a failure waits a minute, and the next minute asks again.
  const shipBackoff = { until: 0, wait: BACKOFF_MIN_MS };
  let ciCache = {};
  try { const r = readTail(ciPath, 1024 * 1024); const o = r?.whole ? JSON.parse(r.text) : null; if (plain(o)) ciCache = Object.fromEntries(Object.entries(o).filter(([k]) => /^[0-9a-f]{40}$/.test(k)).map(([k, v]) => [k, ciEntry(v)]).filter(([, v]) => v)); } catch { /* start afresh */ }
  lap("caches");
  // A repository git can't read gives no tips: its cards stay as declared.
  const repos = {};
  if (c.repoPath) {
    const r = repoAt(home(c.repoPath), c.remote, c.mainBranch, c.notes);
    let live = null, liveUnread = false;
    // #C1387: a deploy run list that FAILED (gh down, a bad answer) is liveUnread, not "nothing deployed"; an empty list is none.
    if (c.deployWorkflow) { try { live = JSON.parse(r.gh(["run", "list", "--branch", c.mainBranch, "--workflow", c.deployWorkflow, "--status", "success", "--limit", "1", "--json", "headSha"]))[0]?.headSha ?? null; } catch { liveUnread = true; } }
    repos[""] = { ...r, ...(liveUnread ? { liveUnread: true } : {}), ci: ciReader(r.gh, now, ciCache, backoff, { batch: true }), ships: now < backoff.until ? null : shipRuns(r.gh, now, shipBackoff, { git: r.git, shippedPattern: c.shippedPattern }), live: /^[0-9a-f]{40}$/.test(live ?? "") ? live : null, versionPattern: c.versionPattern, shippedPattern: c.shippedPattern, reviewPaths: c.reviewPaths ?? null };
    // #C1426 (11-24: #C1421's Ship tile blinked blue, then read "queued" while Release's candidate build/ship-v1.226.27 waited on its CI): a ship candidate in flight carries its cards, and a deploy
    // run on main carries the cards it holds, so each reads shipping with no session on it. A candidate that can't be read leaves the list as the run titles made it.
    addShipReads(repos[""], c, now, r.gh, shipBackoff);
    // #C974: the live config follows the copy landed on main (the next run reads it). A failure here never stops the run.
    if (c.configInRepo) { const l = syncLiveConfig({ git: r.git, tip: `${c.remote}/${c.mainBranch}`, file: c.configInRepo, notesRef: r.notes.security, livePath: process.argv[at + 1] }); if (l) console.log(l); }
  }
  for (const x of c.repos) {
    const installed = installedSha(home(x.installedLink ?? ""));
    const at = repoAt(home(x.path), x.remote ?? "origin", x.mainBranch ?? "main", boardRepoNotes(x.name, x.notes));
    // #C737: the evidence job of the store sets FB_DEPLOY_RULE; the old state job does not, and keeps reading the installed link.
    const dn = {}; // #C1387: dn.failed is set when the ancestry between the two deployed commits could not be read
    const live = process.env.FB_DEPLOY_RULE === "1" ? deployedSha(at.git, process.env.FB_DEPLOY_WORKER, process.env.FB_DEPLOY_TREE, dn) : installed;
    repos[x.name] = { ...at, gh: null, live, ...(dn.failed ? { liveUnread: true } : {}), versionPattern: null, reviewPaths: x.reviewPaths ?? null };
  }
  lap("repos");
  // The store's cards as the evidence job left them (store-cards.json); the agents from the app's files.
  const cards = liveCards(stateDir, id);
  const ids = new Set(cards.filter((k) => !closed(k)).map((k) => k.id));
  const nums = new Map(cards.filter((k) => Number.isInteger(k.num) && ids.has(k.id)).map((k) => [k.num, k.id]));
  lap("cards");
  const sessions = appSessions(join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"));
  lap("sessions");
  const prompts = {}, tools = {}, tokens = {};
  const agents = agentStates({ roles: config.roster, sessionIds: { ...config.rosterSessions, ...(config.gate.managerSession ? { [config.gate.managerRole]: config.gate.managerSession } : {}) }, sessions, homeDir: homedir(), now, ids, nums, prompts, tools, tokens, spawnedBy: config.gate.managerSession || null });
  lap("agents");
  // The roles' context, who is stuck, and the usage tile (#C592, #C593, #C595); a role past resetAt is asked to reset once
  // (context-reset.json, which the lead's wake watch prints), and asked again only after it came back under.
  const ctx = ctxReadings({ tokens, resetAt: config.resetAt, now, windows: config.contextWindows });
  const stuck = stuckReadings({ agents, prompts, now, lead: config.gate.managerRole });
  const resetPath = join(stateDir, id, "context-reset.json");
  let resetBefore = null;
  try { const r = readTail(resetPath, 16 * 1024); if (r?.whole) resetBefore = JSON.parse(r.text); } catch { /* none */ }
  // The lead is never cued to reset by the probe (TEAM.md: the lead hands off on its own, when idle over its limit).
  const resets = resetAsks(Object.fromEntries(Object.entries(ctx).filter(([role]) => role !== config.gate.managerRole)), resetBefore, now);
  const dir = join(stateDir, id);
  const spend = usageTile({ scriptText: pinnedScript(c.usageScript, c.usageScriptSha256), dir, roster: config.roster, now, quota: c.usageQuota, resetAt: c.usageResetAt, run: (args, input) => execFileSync("python3", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }) });
  lap("usage");
  // Roles to wake (#C583): no open session and work waiting (wake-by-need), asked once per spell; the rest reported missing.
  const wakePath = join(dir, "wake-roles.json");
  let wakeBefore = null;
  try { const r = readTail(wakePath, 16 * 1024); if (r?.whole) wakeBefore = JSON.parse(r.text); } catch { /* none */ }
  const needs = wakeNeeds({ roster: config.roster, agents, cards: cards.filter((k) => !closed(k)), lead: config.gate.managerRole });
  const wakeAsk = askOnce(needs.wake, wakeBefore, now), missingAsk = askOnce(needs.missing, { roles: wakeBefore?.missing }, now);
  // Questions for the owner that never became a Needs-you item (#C584), for the lead to write from the wake watch's line.
  // #C999: the store keeps no waiting-item files (the old board's mirror/waiting is gone), so the waiting items are never known and no
  // ask is listed on a guess: the same reading the probe always had in its private folder.
  const waitingDocs = [], waitingKnown = false;
  const asksPath = join(dir, "owner-asks.json");
  let asksBefore = null;
  try { const r = readTail(asksPath, 64 * 1024); if (r?.whole) asksBefore = JSON.parse(r.text); } catch { /* none */ }
  const ownerAsked = askSince(waitingKnown ? ownerAsks({ cards: cards.filter((k) => !closed(k)), waiting: waitingDocs, owner: config.owner }) : [], asksBefore, now);
  lap("asks");
  // #C1005 part c (the watchdog task's restart and prompt-ledger steps, no script of another repository): a restart is every known roster session gone; the
  // ledger (collector.promptLedger, read only, at most 8 MB) gives the new permission prompts and a silence of a day while agents worked. The marker and the
  // line count it reported are the probe's own, in watch-state.json.
  const watchPath = join(dir, "watch-state.json");
  let watchBefore = {};
  try { const r = readTail(watchPath, 64 * 1024); if (r?.whole) watchBefore = JSON.parse(r.text) ?? {}; } catch { /* first run */ }
  const restartNow = restartReading({ ids: sessions.filter((s) => config.roster.includes(s.title)).map((s) => s.id), before: watchBefore });
  let ledgerNow = null;
  if (c.promptLedger) {
    let lines = [];
    try { const p = home(c.promptLedger), st = lstatSync(p); if (st.isFile() && st.size <= 8 * 1024 * 1024) lines = readFileSync(p, "utf8").split("\n").filter(Boolean); } catch { /* no ledger yet: nothing asked */ }
    ledgerNow = ledgerReading({ lines, before: watchBefore.ledger, now, running: Object.values(agents).filter((a) => a.state === "working").length });
  }
  const watch = watchReading({ now, restart: restartNow.restart, ledger: ledgerNow });
  let pageVersion = null;
  try { pageVersion = basename(readlinkSync(join(stateDir, "current"))); } catch { /* no link */ }
  let state;
  const checkedPath = join(stateDir, id, "cards-checked.json");
  let checkedBefore = null;
  try { const r = readTail(checkedPath, 4096); if (r?.whole) checkedBefore = JSON.parse(r.text)?.at; } catch { /* none */ }
  const cardsChecked = cardsCheckedAt(Object.values(repos), now, checkedBefore);
  // #C1377: each repository's last fresh read, kept from run to run: a repository read fresh now is stamped now; one that was not keeps its old stamp (none when there never was one),
  // and its cards carry stale with that time (cardState).
  const repoFreshPath = join(stateDir, id, "repo-fresh.json");
  let repoFreshBefore = {};
  try { const r = readTail(repoFreshPath, 4096); if (r?.whole) { const o = JSON.parse(r.text); if (plain(o)) repoFreshBefore = o; } } catch { /* none */ }
  const repoFresh = repoFreshAt(repos, repoFreshBefore, now);
  try { writeAtomic(repoFreshPath, JSON.stringify(repoFresh)); } catch { /* the mark just has no time next run */ }
  // #C1379: the closed product cards that have read live (closed-live.json); cardStates reads the other closed ones again, and a run that reads one live adds it here.
  const closedLivePath = join(stateDir, id, "closed-live.json");
  let closedLive = new Set();
  try { const r = readTail(closedLivePath, 256 * 1024); if (r?.whole) closedLive = closedLiveFrom(r.text); } catch { /* none: every closed product card in its window is read once */ }
  let cardsNow;
  try {
    const pairNote = {}; // #C1395: pairNote.failed is set when the pair folder exists and could not be read: the board cards at pack or install then say unread "pair"
    const pairs = c.pairFolder ? pairsIn(home(c.pairFolder), pairNote) : [];
    // #C1311: each branch's Board-Id commits, kept from run to run by the branch's tip and main's tip (stackHeads); written only when it changed.
    const stackCache = { old: readStackCache(dir), next: {} };
    cardsNow = cardStates({ cards, config, repos, now, stacks: readStacks(dir, now), pairs, pairsUnread: pairNote.failed === true, stackCache, closedLive });
    lap("cardStates");
    try {
      const next = closedLiveNext({ cards, closedLive, states: cardsNow, livePhase: c.livePhase, now });
      if (next) writeAtomic(closedLivePath, JSON.stringify({ ids: next }));
    } catch { /* the next run reads them again: cost only */ }
    try {
      const before = JSON.stringify({ v: 1, repos: stackCache.old }), after = JSON.stringify({ v: 1, repos: stackCache.next });
      if (after !== before && (Object.keys(stackCache.next).length || Object.keys(stackCache.old).length)) writeAtomic(join(dir, STACK_CACHE_FILE), after);
    } catch { /* the cache is an aid: a write that fails costs only the next run's time */ }
    lap("stackCache");
    // #C632: the last time any open card past plan showed a branch commit; kept from run to run, and the lead's watch told once
    // per outage (gate/reset.mjs evidenceAt).
    const evidencePath = join(stateDir, id, "evidence.json");
    let evidenceBefore = null;
    try { const r = readTail(evidencePath, 4096); if (r?.whole) evidenceBefore = JSON.parse(r.text)?.at; } catch { /* none */ }
    const evidence = evidenceAt(openStates(cards, cardsNow), now, evidenceBefore, [c.shipPhase, c.livePhase]);
    writeAtomic(evidencePath, JSON.stringify({ at: evidence }));
    writeAtomic(join(stateDir, id, NOEVIDENCE_FILE), JSON.stringify({ since: noEvidenceSince(evidence, now), at: now }));
    // #C631: dispatch is mechanical. Only with the waiting items known and fresh (an ask nobody can see is no reason to wake an owner).
    const dispatchStatePath = join(stateDir, id, DISPATCH_STATE_FILE);
    let dispatchBefore = null;
    try { const r = readTail(dispatchStatePath, 64 * 1024); if (r?.whole) dispatchBefore = JSON.parse(r.text); } catch { /* none */ }
    const askedCards = new Set(waitingDocs.filter((d) => d && !d.done && !d.outdated && !d.response && typeof d.initiative === "string").map((d) => d.initiative));
    const dispatch = waitingKnown ? dispatchItems({ cards: cards.filter((k) => !closed(k)), agents, asked: askedCards, roster: config.roster, lead: config.gate.managerRole, now, before: dispatchBefore }) : { items: [], state: dispatchBefore ?? { items: {} } };
    writeAtomic(join(stateDir, id, DISPATCH_FILE), JSON.stringify({ at: now, items: dispatch.items }));
    writeAtomic(dispatchStatePath, JSON.stringify(dispatch.state));
    // #C679: a ship candidate pushed and not on main (the team's repository only: the one the ship runs in).
    let ship = null;
    const team = repos[""];
    if (team && c.candidatePattern) { try { ship = teamShip(team, c, now); } catch { /* no reading: the badge stays as the cards say */ } }
    // #C731 B4b: the release log's CI times (the team's repository only, as the ship runs are).
    let releases = null;
    if (team && c.releaseTimes) { try { releases = releaseTimesOf(team.git, `${team.remote}/${team.main}`, c.releaseTimes); } catch { /* no reading */ } }
    lap("ship");
    state = buildState({ id, now, probe: basename(CODE), pageVersion, cards: cardsNow, agents, lastWrite: null, cardsChecked, evidence, ctx, stuck, watch, usage: spend.tile, ship, releases, published: publishedReading(join(stateDir, id, PUBLISHED_FILE), now), ...wakeTimes(join(stateDir, id), now) });
    writeAtomic(checkedPath, JSON.stringify({ at: cardsChecked }));
    writeAtomic(resetPath, JSON.stringify({ at: now, roles: resets.roles }));
    writeAtomic(watchPath, JSON.stringify({ at: now, ids: restartNow.ids, ...(ledgerNow ? { ledger: { seen: ledgerNow.seen, quiet: ledgerNow.quiet } } : {}) }));
    writeAtomic(wakePath, JSON.stringify({ at: now, roles: wakeAsk.roles, missing: missingAsk.roles }));
    writeAtomic(asksPath, JSON.stringify({ at: now, asks: ownerAsked.asks }));
    // For the lead's Stop hook (collector/refresh.mjs, #C594): the cards whose typed phase the repository contradicts. Only
    // when every repository was read fresh; a half-read minute asks for nothing.
    writeAtomic(join(dir, "phase-clashes.json"), JSON.stringify({ at: now, ids: cardsChecked === now ? phaseClashIds(cards.filter((k) => !closed(k)), cardsNow) : [] }));
    // The cards' own evidence for the lead's watch (#C617: SHIP and CLOSE lines); only from a minute with every repository read
    // fresh, and the file keeps its last list through a half-read one.
    if (cardsChecked === now) writeAtomic(join(dir, "board-truth.json"), JSON.stringify({ at: now, items: boardTruth({ states: openStates(cards, cardsNow), shipPhase: c.shipPhase, livePhase: c.livePhase, hold: new Set(cards.filter((k) => Number.isFinite(k.checkAt)).map((k) => k.id)), cards: cards.filter((k) => !closed(k)), parked: config.nudges.parked, owner: config.owner }) }));
    if (spend.save) writeAtomic(join(dir, "usage.json"), JSON.stringify(spend.save));
    writeAtomic(backoffPath, JSON.stringify(backoff));
    writeAtomic(join(stateDir, id, "state.json"), JSON.stringify(state));
    // The roles stopped on a prompt (#C526), for the Collector's alarm and the watchdog (#C529): roles, times and tool
    // classes only, on this machine only.
    writeAtomic(join(stateDir, id, "waiting-prompt.json"), JSON.stringify({ at: now, roles: prompts, tools }));
    writeAtomic(ciPath, JSON.stringify(Object.fromEntries(Object.entries(ciCache).slice(-500))));
    writeAtomic(idsPath, JSON.stringify(Object.fromEntries(Object.entries(changeIds).slice(-5000))));
  } catch (e) { lap("failed"); console.log(timingLine()); console.error(`state: ${String(e.message).split("\n")[0]}`); process.exit(1); }
  lap("write");
  // What each phase read, as numbers: the open cards, the repositories' tips, the sessions' files, the kept change ids and CI runs.
  const counts = { cards: cards.filter((k) => !closed(k)).length, all: cards.length, tips: Object.values(repos).reduce((n, r) => n + (r.tips?.length ?? 0), 0), sessions: sessions.length, ids: Object.keys(changeIds).length, ci: Object.keys(ciCache).length, waiting: waitingDocs.length };
  if (process.argv.includes("--no-post")) { console.log(`state: written, ${Object.keys(state.cards).length} card(s), ${Object.keys(state.agents).length} agent(s), not posted`); console.log(timingLine(counts)); process.exit(0); }
  const secrets = readSecrets(secretsDir(stateDir, id));
  console.log(secrets ? await postState(fetch, secrets, id, state) : "state: written, not posted (no secrets from the owner's install, or they are open to others)");
  lap("post");
  // The owner's wake counter (#C580) into wake.json, for the lead's wake watch: only when it changed. A Worker that has no
  // wake route yet (an older deploy: 404) leaves no file, so the lead's Stop hook never asks for a watch it can't use.
  if (secrets) {
    const got = await getWake(fetch, secrets, id), p = wakePaths(join(stateDir, id));
    const next = got.wake ? nextWakeFile(got.wake, readWakeFile(p.wake)) : null;
    if (next) { try { writeAtomic(p.wake, next); console.log(`wake: #${got.wake.seq}`); } catch { console.log("wake: wake.json could not be written"); } }
    else if (got.line) console.log(got.line);
    lap("wake");
  }
  console.log(timingLine(counts));
}
