// The board's state without a model (#C420): node collector/state.mjs --config <board.config.json> [--no-fetch] [--no-post]
// launchd runs it every minute from the owner's pinned copy (scripts/state-install.mjs writes the plist; condition A:
// a board release never changes it). It reads, on this machine only:
//   - each open card on the last board export (<stateDir>/<board>/mirror/initiatives): its branch tip from git, the
//     sign-off notes on it, whether it is on main and deployed (collector/derive.mjs's phase), and the CI run on it (gh);
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
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { STATE_VERSION, stateErrors, pickState, toolClass, CARD_ID, CARD_ID_MAX, ROLE, MAX_BYTES, MAX_CARDS, MAX_RELEASES } from "./state-schema.mjs";
import { shippedBase, fetchBranches } from "./after-ship.mjs";
import { PUBLISHED_FILE } from "./export.mjs";
import { readStack, stackFields, STACK_HOLD_FROM } from "./stack.mjs";
import { reviewsFromPaths } from "./review-paths.mjs";
import { pairsIn, packOf, BOARD_REPO_WORDS } from "./pairs.mjs";
import { journalCards, readJournal } from "../gate/gate.mjs";
import { wakePaths, readWakeFile, nextWakeFile, ALIVE_FILE, SEEN_FILE } from "../gate/wake.mjs";
import { NOEVIDENCE_FILE, evidenceAt, noEvidenceSince, DISPATCH_FILE, DISPATCH_STATE_FILE, dispatchItems } from "../gate/reset.mjs";
import { contextTokens, ctxReadings, resetAsks, stuckReadings, usageReading, wakeNeeds, askOnce, ownerAsks, askSince, boardTruth } from "./readings.mjs";

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
export function appSessions(root, uid = process.getuid()) {
  const out = [], dirs = (p) => { try { return readdirSync(p).filter((d) => UUID.test(d) && lstatSync(join(p, d)).isDirectory()); } catch { return []; } };
  for (const a of dirs(root)) for (const o of dirs(join(root, a))) {
    let files = [];
    try { files = readdirSync(join(root, a, o)).filter((f) => /^local_[0-9a-f-]{36}\.json$/.test(f)); } catch { continue; }
    for (const f of files) {
      const r = readTail(join(root, a, o, f), SESSION_BYTES, uid);
      if (!r?.whole) continue;
      let s;
      try { s = JSON.parse(r.text); } catch { continue; }
      if (!plain(s) || s.isArchived === true || typeof s.title !== "string" || !UUID.test(String(s.cliSessionId ?? "")) || typeof s.cwd !== "string" || !s.cwd.startsWith("/")) continue;
      out.push({ id: f.slice(0, -5), title: s.title, transcript: s.cliSessionId, cwd: s.cwd, at: Number.isFinite(s.lastActivityAt) ? Math.round(s.lastActivityAt) : null });
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
export function cardIn(entries, ids, nums) {
  const known = [...ids].filter((id) => CARD_ID.test(id) && id.length <= CARD_ID_MAX).sort((a, b) => b.length - a.length);
  const re = new RegExp(`${known.length ? `(?<![A-Za-z0-9-])(${known.join("|")})(?![A-Za-z0-9-])|` : ""}#C(\\d{1,6})(?!\\d)`, "g");
  for (let k = entries.length - 1; k >= 0; k--) {
    let text = "";
    try { text = JSON.stringify(entries[k].message.content ?? ""); } catch { continue; }
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

// One role's activity from its transcript's last entries: { state, tool, card, since, prompt, promptTool } (prompt:
// promptSince's time, promptTool its class; they stay on this machine, never in the state that leaves).
export function activity(entries, { mtimeMs, now, ids, nums }) {
  const last = entries.at(-1);
  if (!last) return { state: "unknown", tool: null, card: null, since: null, prompt: null, promptTool: null, tokens: null };
  const midTurn = last.type === "user" || (last.type === "assistant" && last.message.stop_reason === "tool_use");
  const state = midTurn && now - mtimeMs <= WORKING_QUIET_MS ? "working" : "idle";
  let tool = null;
  for (let k = entries.length - 1; k >= 0 && !tool; k--) if (entries[k].type === "assistant") tool = toolClass(blocks(entries[k]).filter((b) => b.type === "tool_use").at(-1)?.name);
  const since = state === "working" ? timeOf(entries.findLast(isPrompt)) : timeOf(entries.findLast((e) => e.type === "assistant"));
  return { state, tool, card: cardIn(entries, ids, nums), since, prompt: promptSince(entries, { mtimeMs, now }), promptTool: promptTool(entries, { mtimeMs, now }), tokens: contextTokens(entries) };
}

// Every roster role's agent, from the session whose id the config holds for it (sessionIds, #C633), never from a recency
// list; a role with no id there is found by its newest open session titled exactly as the role and marked by: "title". A
// role whose id is set but is not among the open sessions has no agent. prompts, when given, gets each
// role stopped on a prompt and since when (promptSince), and tools, when given, that prompt's tool class (promptTool):
// the local waiting-prompt.json, not the state.
export function agentStates({ roles, sessions, homeDir, now, ids, nums, uid = process.getuid(), prompts = null, tools = null, tokens = null, sessionIds = {} }) {
  const out = {};
  for (const role of roles.filter((r) => ROLE.test(r))) {
    const byId = Object.hasOwn(sessionIds, role) && sessionIds[role];
    const s = byId ? sessions.find((x) => x.id === byId) : sessions.filter((x) => x.title === role).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
    if (!s) continue;
    const p = transcriptPath(homeDir, s.cwd, s.transcript);
    const tail = p ? readTail(p, TAIL_BYTES, uid) : null;
    const a = tail ? activity(lastEntries(tail), { mtimeMs: tail.mtimeMs, now, ids, nums }) : { state: "unknown", tool: null, card: null, since: null };
    out[role] = { state: a.state, lastActivityAt: s.at, tool: a.tool, card: a.card, since: a.since, ...(byId ? {} : { by: "title" }) };
    if (prompts && a.prompt != null) prompts[role] = a.prompt;
    if (tools && a.promptTool != null) tools[role] = a.promptTool;
    if (tokens && a.tokens != null) tokens[role] = a.tokens;
  }
  return out;
}

// The phase rule, a copy of collector/derive.mjs's (headsFor, reviewsFor, derivePhase, repoOf, closed): this file is
// pinned (condition A) and derive.mjs moves with the link (#C278), so the probe can't import it. tests/board-state.test.mjs
// runs both on the same cases, so the two never drift apart unseen.
export const closed = (card) => card.status === "done" || card.status === "dropped";
// #C697, #C701: the cards as the board has them now, not as the hourly export had them. The mirror's cards (<stateDir>/<id>/mirror/
// initiatives) with the gate's journal (<stateDir>/<id>/gate.json) laid over them by the gate's own rule (gate/gate.mjs journalCards:
// a card the lead closed since the export is closed here too, so no DISPATCH or nudge is made for it).
export function liveCards(stateDir, id) {
  const cards = [], cardAt = {}, mdir = join(stateDir, id, "mirror", "initiatives");
  try { for (const f of readdirSync(mdir)) { if (!f.endsWith(".json")) continue; const r = readTail(join(mdir, f), 256 * 1024); if (!r?.whole) continue; try { const d = JSON.parse(r.text); if (plain(d)) { cards.push({ ...d, id: f.slice(0, -5) }); cardAt[f.slice(0, -5)] = r.mtimeMs; } } catch { /* skip it */ } } } catch { /* no export yet */ }
  let stamp = 0;
  try { const s = JSON.parse(readFileSync(join(stateDir, id, "mirror", "_at.json"), "utf8")); if (Number.isFinite(s?.at) && s.at > 0) stamp = s.at; } catch { /* a mirror from a whole export: its files' times */ }
  return journalCards({ docs: { initiatives: cards }, at: 0, atBy: {}, atDoc: { initiatives: cardAt }, stamp }, readJournal(join(stateDir, id, "gate.json"))).docs.initiatives;
}
const boardIdOf = (message) => { const m = /^Board-Id:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/im.exec(String(message ?? "")); return m ? m[1].toLowerCase() : null; };
// #C985: a repo word that names no listed repository is read as no word (a copy of derive.mjs's namedRepo and repoOf).
export const namedRepo = (card, config) => (card.repo ? (config.collector.repos ?? []).find((r) => r.name === card.repo) ?? null : null);
export function repoOf(card, config) {
  const repos = config.collector.repos ?? [];
  return namedRepo(card, config) ?? repos.find((r) => (r.idPrefixes ?? []).some((p) => String(card.id).startsWith(p))) ?? null;
}
// #C649: a commit whose message starts "#C<num>:" belongs to the card with that number too (num, when the card has one), so a card
// worked on without its Board-Id trailer or a branch named for it still has a head: the board then shows it as build.
export const subjectNum = (message) => { const m = /^#C(\d{1,6}):/.exec(String(message ?? "")); return m ? Number(m[1]) : null; };
// #C671 (done-when 2): a branch named for the card (its last path segment is the card's id) whose tip carries neither the card's
// Board-Id trailer nor its "#C<num>:" subject: the name alone found it. When that tip is also on main it is a branch pushed
// before any commit, and it shows the card as being worked (build), never as shipped or live. A copy of derive.mjs's bareBranch.
export function bareBranch(card, head) {
  if (!head || head.afterShip || head.shipped || String(head.branch).split("/").pop() !== card.id) return false;
  return boardIdOf(head.message) !== card.id && !(Number.isInteger(card.num) && subjectNum(head.message) === card.num);
}
export function headsFor(id, heads, num = null) {
  const tips = new Map();
  for (const h of heads) {
    if (boardIdOf(h.message) !== id && String(h.branch).split("/").pop() !== id && !(Number.isInteger(num) && subjectNum(h.message) === num)) continue;
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
// The phase only (derive.mjs's derivePhase(...).phase): null when the card has no head.
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
const ok = (fn) => { try { fn(); return true; } catch { return false; } };
export function remoteTips(git, remote) {
  const out = git(["for-each-ref", `refs/remotes/${remote}`, "--format=%(refname:lstrip=3)%1f%(objectname)%1f%(committerdate:unix)%1f%(contents)%1e"]);
  return out.split("\x1e").map((r) => r.replace(/^\n/, "")).filter((r) => r.includes("\x1f")).map((r) => {
    const [branch, sha, at, message] = r.split("\x1f");
    return { branch, sha, at: Number(at) * 1000, message };
  }).filter((h) => h.branch && h.branch !== "HEAD");
}

// The CI run on a commit: { ci, ciMin }, from gh's newest run on it.
export function ciOf(gh, sha, now) {
  let runs = [];
  try { runs = JSON.parse(gh(["run", "list", "--commit", sha, "--limit", "1", "--json", "status,conclusion,createdAt,updatedAt"])); } catch { return { ci: "none", ciMin: null, failed: true }; }
  const r = Array.isArray(runs) ? runs[0] : null;
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
export function ciReader(gh, now, cache, backoff = { until: 0, wait: BACKOFF_MIN_MS }) {
  let calls = 0;
  return (sha) => {
    const kept = ciEntry(cache[sha]);
    if (kept) return kept;
    if (calls >= MAX_CI_CALLS || now < backoff.until) return { ci: "none", ciMin: null };
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
    if (git && shippedPattern && /^[0-9a-f]{40}$/.test(String(r.headSha ?? ""))) {
      try {
        const re = new RegExp(shippedPattern, "g");
        for (const s of git(["log", "-5", "--format=%s", r.headSha]).split("\n")) for (const m of s.matchAll(re)) if (m[1] && /^[0-9a-f]{7,40}$/.test(m[2] ?? "")) out.push({ branch: m[1], sha: m[2] });
      } catch { /* the title's pairs stand */ }
    }
  }
  return out;
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
export function shipCandidate({ tips, pattern, now, onMain, ci }) {
  if (!pattern) return null;
  let re;
  try { re = new RegExp(pattern); } catch { return null; }
  const found = (tips ?? []).filter((t) => t && typeof t.branch === "string" && re.test(t.branch) && /^[0-9a-f]{40}$/.test(String(t.sha)) && Number.isFinite(t.at) && now - t.at <= SHIP_CANDIDATE_MAX_MS && t.at - now <= 60e3)
    .sort((a, b) => b.at - a.at).slice(0, 3);
  for (const t of found) {
    if (onMain(t.sha)) continue;
    const r = ci(t.sha), state = r && typeof r.ci === "string" ? r.ci : "none";
    if (state === "failed" || state === "cancelled") continue;
    const m = /v(\d{1,4}\.\d{1,4}\.\d{1,4})/.exec(t.branch);
    return { version: m ? m[1] : null, ci: state, at: t.at };
  }
  return null;
}

// The version a commit went live in: the first subject naming one (versionPattern), from the commit itself on along
// the main line's first parents that descend from it.
function versionAfter(git, sha, ref, pattern) {
  try {
    const re = new RegExp(pattern);
    const subjects = [git(["log", "-1", "--format=%s", sha]).trim(), ...git(["log", "--first-parent", "--ancestry-path", "--reverse", "--format=%s", `${sha}..${ref}`]).split("\n")];
    for (const s of subjects) {
      const m = re.exec(s);
      const v = m ? m[1] ?? m[0] : null;
      if (v && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v)) return v;
    }
  } catch { /* no version */ }
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
export function landedOn(git, ref, sha, ids = {}) {
  try {
    const lines = (args) => git(args).split("\n").filter((s) => /^[0-9a-f]{40}$/.test(s));
    const beyond = lines(["rev-list", sha, `^${ref}`]);
    if (!beyond.length) return null;
    const onMain = lines(["rev-list", `--max-count=${MAIN_LOOKBACK}`, ref, `^${sha}`]), byId = new Map();
    for (const s of onMain) { const id = changeId(git, s, ids); if (id && !byId.has(id)) byId.set(id, s); }
    const found = beyond.map((s) => byId.get(changeId(git, s, ids)));
    return found.every(Boolean) ? onMain.find((s) => found.includes(s)) : null;
  } catch { return null; }
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
export function deployedSha(git, worker, tree) {
  const hex = (v) => /^[0-9a-f]{40}$/.test(String(v ?? ""));
  if (!hex(worker) || !hex(tree)) return null;
  try {
    for (const s of [worker, tree]) git(["cat-file", "-e", `${s}^{commit}`]);
    if (worker === tree) return worker;
    const behind = (a, b) => { try { git(["merge-base", "--is-ancestor", a, b]); return true; } catch { return false; } };
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
// The collector's code the probe's merge and derive run (#C642): always this install's own copy, never the current link's
// (Security, BLOCKING: the child runs unsandboxed with the probe's environment, secrets and network, so it must be code the
// owner's install pinned and Security compared with its commit, #C420 condition A; collector/collect.mjs and what it imports
// are in OWNER_ENTRIES now). A child process, never an import.
export function collectorEntry(code = CODE) {
  return join(code, "collector", "collect.mjs");
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
function noInstallCard(repo, card, mainRef, headSha) {
  if (!NO_INSTALL.has(repo)) NO_INSTALL.set(repo, new Map());
  const memo = NO_INSTALL.get(repo), byCommit = (sha) => { if (!memo.has(sha)) memo.set(sha, noInstallLanding(repo.git, sha)); return memo.get(sha); };
  const shas = new Set([headSha]);
  try {
    const out = String(repo.git(["log", "-400", "--fixed-strings", `--grep=Board-Id: ${card.id}`, "--format=%H%x1f%B%x1e", mainRef]));
    for (const r of out.split("\x1e")) {
      const [h, body] = r.replace(/^\n/, "").split("\x1f");
      const ids = [...String(body ?? "").matchAll(/^Board-Id:[ \t]*(\S+)[ \t]*$/gm)].map((m) => m[1]);
      if (/^[0-9a-f]{40}$/.test(h ?? "") && ids.includes(card.id)) shas.add(h);
    }
  } catch { return false; }
  return shas.size <= MAX_CARD_COMMITS && [...shas].every(byCommit);
}
export function noInstallLanding(git, sha) {
  if (!/^[0-9a-f]{40}$/.test(String(sha))) return false;
  let paths;
  try { paths = String(git(["diff", "--name-only", `${sha}^`, sha])).split("\n").map((p) => p.trim()).filter(Boolean); } catch { return false; }
  return paths.length > 0 && paths.every((p) => DOCS_ONLY.test(p));
}
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
function tipState(card, tip, repo, config, now, declared, cover = null) {
  // #C852: a review's note on a commit is a sign-off unless it starts "FINDINGS" (rework.mjs reads the same word): that is the review sending
  // the commit back, so it is no sign-off, and findingsOn names the reviews that did. A new commit has a new sha, so a finding clears itself.
  const notesOn = (sha) => Object.entries(repo.notes).map(([p, ref]) => { const have = annotatedOn(repo, ref); if (have && /^[0-9a-f]{40}$/.test(String(sha)) && !have.has(sha)) return null; let t = null; try { t = repo.git(["notes", `--ref=${ref}`, "show", sha]); } catch { /* none */ } return t === null || t === undefined || t === false ? null : [p, String(t)]; }).filter(Boolean);
  const signedOn = (sha) => notesOn(sha).filter(([, t]) => !/^\s*FINDINGS\b/.test(t)).map(([p]) => p).sort();
  const findingsOn = (sha) => notesOn(sha).filter(([, t]) => /^\s*FINDINGS\b/.test(t)).map(([p]) => p).sort();
  const mainRef = `${repo.remote}/${repo.main}`;
  const landed = ok(() => repo.git(["merge-base", "--is-ancestor", tip.sha, mainRef])) ? null : landedOn(repo.git, mainRef, tip.sha, repo.ids);
  // A tip with commits after the card's shipped one (#C527, collector/after-ship.mjs) is read as that commit, with its
  // sign-offs.
  const after = landed ? null : shippedBase(repo.git, mainRef, tip.sha, { id: card.id, branch: tip.branch, pattern: repo.shippedPattern ?? "" });
  // A tip read as a main commit (landed, or the shipped one) keeps afterShip set: that head is no bare branch (bareBranch).
  const head = landed ? { ...tip, sha: landed, afterShip: true } : after ? { ...tip, sha: after.sha, afterShip: true } : tip;
  const atMain = !!landed || ok(() => repo.git(["merge-base", "--is-ancestor", head.sha, mainRef]));
  // #C671: a pushed branch named for the card with no commit of its own sits at a main commit: it is work started (build), and
  // main's sign-off notes and deploy are not the card's.
  const bare = !landed && !after && atMain && bareBranch(card, head);
  const coverSha = cover && !bare && !landed && !after && /^[0-9a-f]{40}$/.test(String(cover)) ? cover : null;
  // A review that sent the tip back (FINDINGS) is no sign-off for any card under it, whatever its note on the card's own commit says.
  const sentBack = coverSha ? findingsOn(coverSha) : [];
  const signed = bare ? [] : [...new Set([...signedOn(after ? after.sha : tip.sha), ...(coverSha ? signedOn(coverSha) : [])])].filter((p) => !sentBack.includes(p)).sort();
  const onMain = atMain && !bare;
  // #C882: a landing that changed only docs and tests has nothing to deploy or install: it is live the moment it is on main, not "waiting for install".
  const noInstall = onMain && typeof repo.git === "function" && noInstallCard(repo, card, mainRef, head.sha);
  const deployed = onMain && (noInstall || (!!repo.live && ok(() => repo.git(["merge-base", "--is-ancestor", head.sha, repo.live]))));
  const cfg = { ...config, collector: { ...config.collector, notes: repo.notes, mainBranch: repo.main } };
  // #C897: the reviews from the paths the branch changed since it left main, when the repository has a reviewPaths table.
  const needs = !onMain && !bare ? reviewsFromPaths(card, cfg, reviewsFor(card, cfg), repo.reviewPaths, branchPaths(repo, mainRef, tip.sha)) : null;
  const phase = phaseOf(card, { head, signed: new Set(signed), onMain, deployed, ...(needs ? { needs } : {}) }, cfg);
  const ci = repo.ci ? repo.ci(head.sha) : repo.gh ? ciOf(repo.gh, head.sha, now) : null;
  const shipping = Array.isArray(repo.ships) ? !onMain && shipsCard(repo.ships, tip, head) : null;
  const seen = seenPhases(config, { head: true, ci: ci?.ci, signed, onMain, shipping: shipping === true, deployed });
  // #C731 B4b: derive.mjs's readyAt, firm and waitingFor. A phase read as build is not firm (a head with no trailer or sign-off,
  // or a bare branch); otherwise readyAt is the head's time, and a tip still in review lists the reviews unsigned on it.
  const build = phase === config.collector.buildPhase;
  const order = config.phases.map((p) => p[0]);
  const unsigned = onMain ? [] : (needs ?? reviewsFor(card, cfg)).filter((p) => !signed.includes(p)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  // reviews: when each review the repository shows signed on the tip was signed (derive.mjs derivePhase, #C671); none for a bare
  // branch, a tip read as a main commit, or one with no sign-offs.
  const reviews = !bare && !onMain && signed.length && typeof repo.git === "function" && repo.notes
    ? { ...(coverSha ? signedTimesOf(repo.git, coverSha, repo.notes, signed, head.at) : {}), ...signedTimesOf(repo.git, after ? after.sha : tip.sha, repo.notes, signed, head.at) } : {};
  // #C854: a tip that has its sign-offs (the phase is ship) but does not continue main (main has a commit the tip lacks) cannot be landed as it
  // is: it goes back to its builder to re-cut. Read only for a tip waiting at ship, so a card in review costs no extra git call.
  const behindMain = !onMain && !bare && phase === config.collector.shipPhase && typeof repo.git === "function" && !ok(() => repo.git(["merge-base", "--is-ancestor", mainRef, tip.sha]));
  const findings = bare || onMain ? [] : [...new Set([...findingsOn(after ? after.sha : tip.sha), ...(coverSha ? findingsOn(coverSha) : [])])].sort();
  const extra = {
    ...(Object.keys(reviews).length ? { reviews } : {}),
    ...(findings.length ? { findings } : {}),
    ...(behindMain ? { behindMain: true } : {}),
    ...(noInstall ? { noInstall: true } : {}),
    ...(phase && build ? { firm: false } : {}),
    ...(phase && !build && Number.isInteger(head.at) && head.at >= 1577836800000 && head.at <= 4102444800000 ? { readyAt: head.at } : {}),
    ...(phase && !build && unsigned.length ? { waitingFor: unsigned.slice(0, 10) } : {}),
  };
  // #C895: the full sha, the branch (main for a card on main) and the repository, for the DISPATCH line.
  const where = {
    ...(/^[0-9a-f]{40}$/.test(String(head.sha)) ? { headSha: head.sha } : {}),
    ...(() => { const b = onMain ? repo.main : head.branch; return typeof b === "string" && BRANCH_NAME.test(b) && !b.startsWith("-") ? { headBranch: b } : {}; })(),
    ...(repoFullOf(repo) ? { repoFull: repoFullOf(repo) } : {}),
  };
  return { phase: phase ?? declared, ...extra, ...where, headSha12: sha12(head.sha), signed, onMain, ...(ci ? { ci: ci.ci, ciMin: ci.ciMin } : {}), liveVersion: deployed && repo.versionPattern ? versionAfter(repo.git, head.sha, repo.live, repo.versionPattern) : null, ...(shipping === null ? {} : { shipping }), seen };
}
// The newest commit on the repository's main line (its last 400) whose Board-Id trailer is exactly the card's id, as a head
// { branch: main, sha, at, message }, or null. The id goes to git as a fixed string, never a pattern or an option.
export function trailerHead(repo, id, branch = repo.main, depth = 400) {
  let out = "";
  try { out = repo.git(["log", `-${depth}`, "--fixed-strings", `--grep=Board-Id: ${id}`, "--format=%H%x1f%ct%x1f%B%x1e", `${repo.remote}/${branch}`]); } catch { return null; }
  for (const r of out.split("\x1e")) {
    const [sha, at, message] = r.replace(/^\n/, "").split("\x1f");
    const ids = [...String(message ?? "").matchAll(/^Board-Id:[ \t]*(\S+)[ \t]*$/gm)].map((m) => m[1]);
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
  if (!tips.length && typeof repo.git === "function") { const t = trailerHead(repo, card.id); if (t) tips = [t]; }
  if (tips[0]) tips = [ownHead(repo, card, tips[0]), ...tips.slice(1)];
  let tip = tips[0];
  if (!tip) return { ...base, ...(mainEvidence(repo, card) ?? {}) };
  let one = tipState(card, tip, repo, config, now, declared, opts.cover ?? null);
  // #C915 (incident 11-11: a card's v2 shipped in v1.209.9 and its v1 branch stayed, read "signed but behind main, re-cut" and dispatched to the
  // builder; a landed card's stale tip went to Checker five times): when none of the card's branch tips is on main but a commit on main carries
  // its Board-Id trailer, that main commit is the card (landed, or live once deployed) and the older tips are no longer worked. The branch of the
  // newer version is often deleted at merge, so the tips alone cannot show it. A tip that is built ON the main commit (the commit is its ancestor)
  // is rework after the landing, not an older version: it stays the card's tip (tests/probe-trailer-fallback.test.mjs).
  if (!one.onMain && typeof repo.git === "function") {
    const landedHead = trailerHead(repo, card.id);
    if (landedHead && !ok(() => repo.git(["merge-base", "--is-ancestor", landedHead.sha, tip.sha]))) {
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
    const stateOf = (t) => { if (!read.has(t)) read.set(t, tipState(card, t, repo, config, now, declared, t === tips[0] ? opts.cover ?? null : null)); return read.get(t); };
    const landed = tips.find((t) => stateOf(t).onMain === true);
    if (landed) tips = [landed];
    else { const seen = new Set(); tips = tips.filter((t) => { const f = branchFamily(t.branch); if (seen.has(f)) return false; seen.add(f); return true; }); }
    if (tips[0] !== tip) { tip = tips[0]; one = stateOf(tip); }
    const out = { ...base, ...one };
    if (tips.length > 1) {
      const taken = new Set();
      out.branches = tips.map((t, n) => ({ name: branchName(t.branch, taken, n), ci: "none", ciMin: null, ...stateOf(t) }));
    }
    return out;
  }
  return { ...base, ...one };
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
export function stackHeads(repo, tips, open) {
  const heads = {};
  if (!open.size || typeof repo.git !== "function") return heads;
  for (const t of [...tips].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
    if (!/^[A-Za-z0-9._\/-]+$/.test(String(t.branch)) || String(t.branch).startsWith("-")) continue;
    let log = "";
    try { log = String(repo.git(["log", "-100", "--format=%H%x1f%ct%x1f%B%x1e", `${repo.remote}/${t.branch}`, "--not", `${repo.remote}/${repo.main}`])); } catch { continue; }
    for (const rec of log.split("\x1e")) {
      const [sha, at, message] = rec.replace(/^\n/, "").split("\x1f");
      if (!/^[0-9a-f]{40}$/.test(String(sha))) continue;
      for (const m of String(message ?? "").matchAll(/^Board-Id:[ \t]*(\S+)[ \t]*$/gm)) if (open.has(m[1]) && !heads[m[1]]) heads[m[1]] = { branch: t.branch, sha, at: Number(at) * 1000, message };
    }
  }
  return heads;
}

// #C914: the commits carrying a stack-ready note (the builder's signal, scripts/stack-ready.mjs): `git notes list` prints "<note> <commit>" pairs.
// The collector fetches every notes ref into refs/notes/flight-board/<name>. Any failure (no such ref yet) is no notes.
export const STACK_READY_REF = "refs/notes/flight-board/stack-ready";
export function stackReadyCommits(repo) {
  try {
    return String(repo.git(["notes", `--ref=${STACK_READY_REF}`, "list"])).split("\n").map((l) => l.trim().split(/\s+/)[1]).filter((c) => /^[0-9a-f]{40}$/.test(String(c)));
  } catch { return []; }
}

export function cardStates({ cards, config, repos, now, stacks = [], pairs = [] }) {
  const out = {}, repoOfCard = {}, cardOf = {};
  for (const card of cards.filter((k) => !closed(k) && CARD_ID.test(String(k.id)) && k.id.length <= CARD_ID_MAX).slice(0, MAX_CARDS)) {
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
    out[card.id] = cardState(card, repo, config, now);
    repoOfCard[card.id] = repo;
    cardOf[card.id] = card;
  }
  // #C859 slice 2: for a repository whose stack switch is on (`stacks`: the repository names, "" for the team's own), the stack read from git.
  // Nothing is added for a switch that is off, which is the default: the switch off is today's reading.
  for (const name of stacks) {
    const repo = repos[name];
    if (!repo || typeof repo.git !== "function") continue;
    const tips = (repo.tips ?? []).filter((t) => t.branch !== repo.main);
    // A card in the middle of a chain has its commit on the branch but not at its tip, and the branch is not named for it: headsFor does not
    // find it. The stack reads every commit the branch holds beyond main (its last 100) for the Board-Id trailers of the repository's open cards.
    const open = new Set(Object.keys(out).filter((id) => repoOfCard[id] === repo && !out[id].onMain));
    const found = stackHeads(repo, tips, open);
    const heads = Object.fromEntries(Object.entries(found).map(([id, h]) => [id, h.sha]));
    for (const id of open) if (!heads[id] && out[id].headSha12) heads[id] = out[id].headSha12;
    const isAncestor = (a, b) => a === b || String(b).startsWith(a) || ok(() => repo.git(["merge-base", "--is-ancestor", a, b]));
    const stack = readStack({ heads, tips, isAncestor });
    const fields = stackFields(stack);
    for (const [id, field] of Object.entries(fields)) {
      // A member is read again at its own commit with the stack tip as cover (design 4: a note on the tip counts for every card under it),
      // and a middle-of-chain card, which the first pass could not find, is read at the commit its trailer names. An outsider keeps its reading.
      const again = field.outside ? out[id] : cardState(cardOf[id], repo, config, now, { head: found[id], cover: stack.tip });
      out[id] = { ...again, stack: field };
    }
    // #C914: stackHold marks a pushed card of this stack-mode repository that no stack-ready signal (scripts/stack-ready.mjs) covers: its head is not
    // the noted commit or under it. It is a fact for the dispatch, which applies it only to a card with a declared stack partner. Not for a card whose
    // head was committed before STACK_HOLD_FROM, one that already carries a review note or findings, or an outsider. The card's `stack` field is left as
    // it is (the page draws it). Same input, same answer: no clock.
    const noted = stackReadyCommits(repo);
    const headAt = (id) => {
      if (Number.isFinite(found[id]?.at)) return found[id].at;
      try { return Number(String(repo.git(["log", "-1", "--format=%ct", heads[id]])).trim()) * 1000; } catch { return NaN; }
    };
    for (const id of open) {
      if (!heads[id] || fields[id]?.outside || out[id].signed?.length || out[id].findings?.length) continue;
      if (!(headAt(id) >= STACK_HOLD_FROM)) continue; // before the cutoff, or a time git would not give: today's reading
      if (noted.some((c) => isAncestor(heads[id], c))) continue;
      out[id] = { ...out[id], stackHold: true };
    }
  }
  // #C1020: a board-repository card on main shows packed and installed from the deploy pairs (pairsIn, the owner's pair folder) and git alone:
  // packed when a pair's pin holds its landing, installed when such a pair's deploy ran. Never for a card of another repository, nor one not on main.
  const board = Object.entries(repos).find(([name]) => BOARD_REPO_WORDS.has(name))?.[1];
  if (board && typeof board.git === "function" && pairs.length) {
    const git = (args) => ({ status: ok(() => board.git(args)) ? 0 : 1 });
    for (const id of Object.keys(out)) {
      // The card's own repo word names the board (as the dispatch's pair turn reads it), and it was read from the board's checkout.
      if (!BOARD_REPO_WORDS.has(String(cardOf[id].repo ?? "")) || repoOfCard[id] !== board || out[id].onMain !== true || !out[id].headSha) continue;
      const p = packOf(pairs, out[id].headSha, git);
      if (p.packed) out[id] = { ...out[id], packed: true, ...(p.installed ? { installed: true } : {}) };
    }
  }
  return out;
}

// #C1034 (Checker 2's LOW on #C1020, Manager's pick A): the probe reads no closed card, so a finished board card drew Pack and Install unlit
// beside its done Live tile. closedPacks reads them from evidence too, as cardStates does for open cards: a board card done in the last
// CLOSED_PACK_DAYS days, whose landing (the newest of the board main's last CLOSED_PACK_COMMITS commits carrying its Board-Id trailer) a deploy
// pair holds, is packed; installed when that pair ran. { id: { packed: true, installed?: true } }, only the cards that read packed. Its status,
// phase or note never light it (#C1020's rule): no landing on main, or no pair holding it, and the card is not listed. One git log per run, then
// packOf (which stops at the first pin that does not hold the landing). A separate map, not `cards`: nothing else on the page reads a done card.
export const CLOSED_PACK_DAYS = 14, CLOSED_PACK_COMMITS = 500;
export function closedPacks({ cards, repos, now, pairs = [] }) {
  const out = {};
  const board = Object.entries(repos ?? {}).find(([name]) => BOARD_REPO_WORDS.has(name))?.[1];
  if (!board || typeof board.git !== "function" || !Array.isArray(pairs) || !pairs.length) return out;
  const since = now - CLOSED_PACK_DAYS * 864e5;
  const recent = (cards ?? []).filter((k) => k?.status === "done" && BOARD_REPO_WORDS.has(String(k.repo ?? "")) && CARD_ID.test(String(k.id)) && k.id.length <= CARD_ID_MAX
    && Number.isFinite(k.doneAt) && k.doneAt > since && k.doneAt <= now + 60e3).slice(0, MAX_CARDS);
  if (!recent.length) return out;
  const want = new Set(recent.map((k) => k.id)), landing = {};
  const main = `${board.remote}/${board.main}`;
  if (!/^[A-Za-z0-9._\/-]+$/.test(main) || main.startsWith("-")) return out;
  let log = "";
  try { log = String(board.git(["log", `--max-count=${CLOSED_PACK_COMMITS}`, "--format=%H%x1f%B%x1e", main])); } catch { return out; }
  for (const rec of log.split("\x1e")) {
    const [sha, message] = rec.replace(/^\n/, "").split("\x1f");
    if (!/^[0-9a-f]{40}$/.test(String(sha))) continue;
    const id = boardIdOf(message);
    if (id && want.has(id) && !landing[id]) landing[id] = sha; // newest first: the first one is the landing
  }
  const git = (args) => ({ status: ok(() => board.git(args)) ? 0 : 1 });
  for (const id of Object.keys(landing)) {
    const p = packOf(pairs, landing[id], git);
    if (p.packed) out[id] = { packed: true, ...(p.installed ? { installed: true } : {}) };
  }
  return out;
}

// The board db's last write (#C452, the owner at 23:44Z: "Needs you 0" and no cards in flight while the db held both,
// the page's stream quiet with no error): the newest `at` in the gate's journal (gate/after.mjs, every write the board
// applied), as a time only; nothing else of gate.json leaves. null when there is none, or the file isn't this user's.
export function lastWriteAt(path, now) {
  const r = readTail(path, 8 * 1024 * 1024);
  if (!r?.whole) return null;
  let j;
  try { j = JSON.parse(r.text)?.journal; } catch { return null; }
  if (!Array.isArray(j)) return null;
  const t = j.reduce((m, w) => (plain(w) && Number.isInteger(w.at) && w.at > m && w.at <= now + 60e3 ? w.at : m), 0);
  return t >= 1577836800000 && t <= 4102444800000 ? t : null;
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
export function buildState({ id, now, probe, pageVersion, cards, agents, lastWrite = null, wakeAlive = null, wakeSeen = null, cardsChecked = null, evidence = null, ctx = null, stuck = null, usage = null, ship = null, releases = null, published = null, packs = null }) {
  const s = { v: STATE_VERSION, board: { boardId: id, at: now, probe: sha12(probe), pageVersion: sha12(pageVersion), lastWriteAt: lastWrite, wakeAliveAt: wakeAlive, wakeSeenAt: wakeSeen, cardsCheckedAt: cardsChecked, ...(evidence === null ? {} : { evidenceAt: evidence }), ...(published ? { derivedAt: published.at, quietMin: published.quietMin } : {}) }, cards, agents, ...(ctx ? { ctx } : {}), ...(stuck ? { stuck } : {}), ...(usage ? { usage } : {}), ...(ship ? { ship } : {}), ...(releases ? { releases } : {}), ...(packs && Object.keys(packs).length ? { closedPacks: packs } : {}) };
  const errs = stateErrors(s);
  if (errs.length) throw new Error(`the state doesn't fit the plan (${errs.length} problem(s), first: ${errs[0]})`);
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
  if (typeof note !== "string" || !/^\s*SECURE\b/.test(note)) return { text: null, line: `config: ${file} last changed on main in ${sha.slice(0, 7)}, which carries no SECURE note; the live copy is kept` };
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
    return { git, gh: run(path)("gh", 15_000), remote, main, notes: local, tips, ids: changeIds, fresh };
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
    let live = null;
    if (c.deployWorkflow) { try { live = JSON.parse(r.gh(["run", "list", "--branch", c.mainBranch, "--workflow", c.deployWorkflow, "--status", "success", "--limit", "1", "--json", "headSha"]))[0]?.headSha ?? null; } catch { /* none */ } }
    repos[""] = { ...r, ci: ciReader(r.gh, now, ciCache, backoff), ships: now < backoff.until ? null : shipRuns(r.gh, now, shipBackoff, { git: r.git, shippedPattern: c.shippedPattern }), live: /^[0-9a-f]{40}$/.test(live ?? "") ? live : null, versionPattern: c.versionPattern, shippedPattern: c.shippedPattern, reviewPaths: c.reviewPaths ?? null };
    // #C974: the live config follows the copy landed on main (the next run reads it). A failure here never stops the run.
    if (c.configInRepo) { const l = syncLiveConfig({ git: r.git, tip: `${c.remote}/${c.mainBranch}`, file: c.configInRepo, notesRef: r.notes.security, livePath: process.argv[at + 1] }); if (l) console.log(l); }
  }
  for (const x of c.repos) {
    const installed = installedSha(home(x.installedLink ?? ""));
    const at = repoAt(home(x.path), x.remote ?? "origin", x.mainBranch ?? "main", x.notes);
    // #C737: the evidence job of the store sets FB_DEPLOY_RULE; the old state job does not, and keeps reading the installed link.
    const live = process.env.FB_DEPLOY_RULE === "1" ? deployedSha(at.git, process.env.FB_DEPLOY_WORKER, process.env.FB_DEPLOY_TREE) : installed;
    repos[x.name] = { ...at, gh: null, live, versionPattern: null, reviewPaths: x.reviewPaths ?? null };
  }
  // #C642: what the Collector's last run saved is merged into the mirror first, so this minute reads the board as of that run. The merge
  // and the derive after it are collect.mjs --probe-step, a child process (the collector's code is the release's, not this pinned file's).
  const probeStep = (extra) => {
    try { return execFileSync(process.execPath, [collectorEntry(), "--config", process.argv[at + 1], "--probe-step", ...extra, ...(fetchIt ? ["--no-fetch"] : [])], { cwd: join(stateDir, id), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 150_000, maxBuffer: 16 * 1024 * 1024 }).trim(); }
    catch (e) { return `probe step failed: ${String(e.message).split("\n")[0].slice(0, 160)}`; }
  };
  lap("repos");
  const merged = probeStep(["--merge-only"]);
  if (merged) console.log(`state: ${merged.split("\n").join(" / ")}`);
  lap("merge");
  // The mirror's own stamp (collector/delta.mjs _at.json): when the last merged run began.
  const stampAt = () => { try { const s = JSON.parse(readFileSync(join(stateDir, id, "mirror", "_at.json"), "utf8")); return Number.isFinite(s?.at) ? s.at : 0; } catch { return 0; } };
  // The derive step, after the state is posted (it asks GitHub, which can take a while): when a merge changed the mirror or the last one is 10 minutes old.
  const deriveStep = () => { const out = probeStep([]); if (out) console.log(`state: ${out.split("\n").join(" / ")}`); };
  // The cards on the last export; the agents from the app's files.
  const cards = liveCards(stateDir, id);
  const ids = new Set(cards.filter((k) => !closed(k)).map((k) => k.id));
  const nums = new Map(cards.filter((k) => Number.isInteger(k.num) && ids.has(k.id)).map((k) => [k.num, k.id]));
  lap("cards");
  const sessions = appSessions(join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"));
  lap("sessions");
  const prompts = {}, tools = {}, tokens = {};
  const agents = agentStates({ roles: config.roster, sessionIds: { ...config.rosterSessions, ...(config.gate.managerSession ? { [config.gate.managerRole]: config.gate.managerSession } : {}) }, sessions, homeDir: homedir(), now, ids, nums, prompts, tools, tokens });
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
  const waitingDocs = [], wdir = join(stateDir, id, "mirror", "waiting");
  let waitingKnown = false, exportedAt = 0;
  try { waitingKnown = true; exportedAt = Math.max(lstatSync(wdir).mtimeMs, stampAt()); for (const f of readdirSync(wdir)) { if (!f.endsWith(".json")) continue; const r = readTail(join(wdir, f), 64 * 1024); if (!r?.whole) continue; exportedAt = Math.max(exportedAt, r.mtimeMs); try { const d = JSON.parse(r.text); if (plain(d)) waitingDocs.push(d); } catch { /* skip it */ } } } catch { waitingKnown = false; /* no export of the waiting items yet: no ask is listed on a guess */ }
  // The export is the Collector's, on demand (#C594): an item the lead wrote after it isn't in it. No ask is listed from an
  // export older than MIRROR_STALE_MS, or the lead would be told to write an item that already exists (Checker on 46d97a0).
  if (waitingKnown && !mirrorFresh(exportedAt, now, config.gate.mirrorMaxAgeMin * 60e3)) waitingKnown = false;
  const asksPath = join(dir, "owner-asks.json");
  let asksBefore = null;
  try { const r = readTail(asksPath, 64 * 1024); if (r?.whole) asksBefore = JSON.parse(r.text); } catch { /* none */ }
  const ownerAsked = askSince(waitingKnown ? ownerAsks({ cards: cards.filter((k) => !closed(k)), waiting: waitingDocs, owner: config.owner }) : [], asksBefore, now);
  lap("asks");
  let pageVersion = null;
  try { pageVersion = basename(readlinkSync(join(stateDir, "current"))); } catch { /* no link */ }
  let state;
  const checkedPath = join(stateDir, id, "cards-checked.json");
  let checkedBefore = null;
  try { const r = readTail(checkedPath, 4096); if (r?.whole) checkedBefore = JSON.parse(r.text)?.at; } catch { /* none */ }
  const cardsChecked = cardsCheckedAt(Object.values(repos), now, checkedBefore);
  let cardsNow, packs = null;
  try {
    const pairs = c.pairFolder ? pairsIn(home(c.pairFolder)) : [];
    cardsNow = cardStates({ cards, config, repos, now, stacks: readStacks(dir, now), pairs });
    lap("cardStates");
    try { packs = closedPacks({ cards, repos, now, pairs }); } catch { packs = null; } // #C1034: a failure here leaves done cards unlit, never the state
    lap("closedPacks");
    // #C632: the last time any open card past plan showed a branch commit; kept from run to run, and the lead's watch told once
    // per outage (gate/reset.mjs evidenceAt).
    const evidencePath = join(stateDir, id, "evidence.json");
    let evidenceBefore = null;
    try { const r = readTail(evidencePath, 4096); if (r?.whole) evidenceBefore = JSON.parse(r.text)?.at; } catch { /* none */ }
    const evidence = evidenceAt(cardsNow, now, evidenceBefore, [c.shipPhase, c.livePhase]);
    writeAtomic(evidencePath, JSON.stringify({ at: evidence }));
    writeAtomic(join(stateDir, id, NOEVIDENCE_FILE), JSON.stringify({ since: noEvidenceSince(evidence, now), at: now }));
    // #C631: dispatch is mechanical. Only with the waiting items known and fresh (an ask nobody can see is no reason to wake an owner).
    const dispatchStatePath = join(stateDir, id, DISPATCH_STATE_FILE);
    let dispatchBefore = null;
    try { const r = readTail(dispatchStatePath, 64 * 1024); if (r?.whole) dispatchBefore = JSON.parse(r.text); } catch { /* none */ }
    const askedCards = new Set(waitingDocs.filter((d) => d && !d.done && !d.response && typeof d.initiative === "string").map((d) => d.initiative));
    const dispatch = waitingKnown ? dispatchItems({ cards: cards.filter((k) => !closed(k)), agents, asked: askedCards, roster: config.roster, lead: config.gate.managerRole, now, before: dispatchBefore }) : { items: [], state: dispatchBefore ?? { items: {} } };
    writeAtomic(join(stateDir, id, DISPATCH_FILE), JSON.stringify({ at: now, items: dispatch.items }));
    writeAtomic(dispatchStatePath, JSON.stringify(dispatch.state));
    // #C679: a ship candidate pushed and not on main (the team's repository only: the one the ship runs in).
    let ship = null;
    const team = repos[""];
    if (team && c.candidatePattern) { try { ship = shipCandidate({ tips: team.tips, pattern: c.candidatePattern, now, onMain: (sha) => ok(() => team.git(["merge-base", "--is-ancestor", sha, `${team.remote}/${team.main}`])), ci: team.ci }); } catch { /* no reading: the badge stays as the cards say */ } }
    // #C731 B4b: the release log's CI times (the team's repository only, as the ship runs are).
    let releases = null;
    if (team && c.releaseTimes) { try { releases = releaseTimesOf(team.git, `${team.remote}/${team.main}`, c.releaseTimes); } catch { /* no reading */ } }
    lap("ship");
    state = buildState({ id, now, probe: basename(CODE), pageVersion, cards: cardsNow, agents, lastWrite: lastWriteAt(join(stateDir, id, "gate.json"), now), cardsChecked, evidence, ctx, stuck, usage: spend.tile, ship, releases, packs, published: publishedReading(join(stateDir, id, PUBLISHED_FILE), now), ...wakeTimes(join(stateDir, id), now) });
    writeAtomic(checkedPath, JSON.stringify({ at: cardsChecked }));
    writeAtomic(resetPath, JSON.stringify({ at: now, roles: resets.roles }));
    writeAtomic(wakePath, JSON.stringify({ at: now, roles: wakeAsk.roles, missing: missingAsk.roles }));
    writeAtomic(asksPath, JSON.stringify({ at: now, asks: ownerAsked.asks }));
    // For the lead's Stop hook (collector/refresh.mjs, #C594): the cards whose typed phase the repository contradicts. Only
    // when every repository was read fresh; a half-read minute asks for nothing.
    writeAtomic(join(dir, "phase-clashes.json"), JSON.stringify({ at: now, ids: cardsChecked === now ? phaseClashIds(cards.filter((k) => !closed(k)), cardsNow) : [] }));
    // The cards' own evidence for the lead's watch (#C617: SHIP and CLOSE lines); only from a minute with every repository read
    // fresh, and the file keeps its last list through a half-read one.
    if (cardsChecked === now) writeAtomic(join(dir, "board-truth.json"), JSON.stringify({ at: now, items: boardTruth({ states: cardsNow, shipPhase: c.shipPhase, livePhase: c.livePhase, hold: new Set(cards.filter((k) => Number.isFinite(k.checkAt)).map((k) => k.id)), cards: cards.filter((k) => !closed(k)), parked: config.nudges.parked, owner: config.owner }) }));
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
  if (process.argv.includes("--no-post")) { console.log(`state: written, ${Object.keys(state.cards).length} card(s), ${Object.keys(state.agents).length} agent(s), not posted`); console.log(timingLine(counts)); if (!process.argv.includes("--no-derive")) deriveStep(); process.exit(0); }
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
  deriveStep();
}
