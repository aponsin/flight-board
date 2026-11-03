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
import { STATE_VERSION, stateErrors, pickState, toolClass, CARD_ID, CARD_ID_MAX, ROLE, MAX_BYTES, MAX_CARDS } from "./state-schema.mjs";
import { shippedBase, fetchBranches } from "./after-ship.mjs";
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
      if (id) last = id;
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
const boardIdOf = (message) => { const m = /^Board-Id:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/im.exec(String(message ?? "")); return m ? m[1].toLowerCase() : null; };
export function repoOf(card, config) {
  const repos = config.collector.repos ?? [];
  if (card.repo) return repos.find((r) => r.name === card.repo) ?? null;
  return repos.find((r) => (r.idPrefixes ?? []).some((p) => String(card.id).startsWith(p))) ?? null;
}
export function headsFor(id, heads) {
  const tips = new Map();
  for (const h of heads) {
    if (boardIdOf(h.message) !== id && String(h.branch).split("/").pop() !== id) continue;
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
  if (facts.onMain) return facts.deployed ? c.livePhase : c.shipPhase;
  if (boardIdOf(facts.head.message) !== card.id && facts.signed.size === 0) return c.buildPhase;
  const order = config.phases.map((p) => p[0]);
  const waiting = reviewsFor(card, config).filter((p) => !facts.signed.has(p)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
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
function tipState(card, tip, repo, config, now, declared) {
  const signedOn = (sha) => Object.entries(repo.notes).filter(([, ref]) => ok(() => repo.git(["notes", `--ref=${ref}`, "show", sha]))).map(([p]) => p).sort();
  const mainRef = `${repo.remote}/${repo.main}`;
  const landed = ok(() => repo.git(["merge-base", "--is-ancestor", tip.sha, mainRef])) ? null : landedOn(repo.git, mainRef, tip.sha, repo.ids);
  // A tip with commits after the card's shipped one (#C527, collector/after-ship.mjs) is read as that commit, with its
  // sign-offs.
  const after = landed ? null : shippedBase(repo.git, mainRef, tip.sha, { id: card.id, branch: tip.branch, pattern: repo.shippedPattern ?? "" });
  const signed = signedOn(after ? after.sha : tip.sha);
  const head = landed ? { ...tip, sha: landed } : after ? { ...tip, sha: after.sha } : tip;
  const onMain = !!landed || ok(() => repo.git(["merge-base", "--is-ancestor", head.sha, mainRef]));
  const deployed = onMain && !!repo.live && ok(() => repo.git(["merge-base", "--is-ancestor", head.sha, repo.live]));
  const cfg = { ...config, collector: { ...config.collector, notes: repo.notes, mainBranch: repo.main } };
  const phase = phaseOf(card, { head, signed: new Set(signed), onMain, deployed }, cfg);
  const ci = repo.ci ? repo.ci(head.sha) : repo.gh ? ciOf(repo.gh, head.sha, now) : null;
  const shipping = Array.isArray(repo.ships) ? !onMain && shipsCard(repo.ships, tip, head) : null;
  const seen = seenPhases(config, { head: true, ci: ci?.ci, signed, onMain, shipping: shipping === true, deployed });
  return { phase: phase ?? declared, headSha12: sha12(head.sha), signed, onMain, ...(ci ? { ci: ci.ci, ciMin: ci.ciMin } : {}), liveVersion: deployed && repo.versionPattern ? versionAfter(repo.git, head.sha, repo.live, repo.versionPattern) : null, ...(shipping === null ? {} : { shipping }), seen };
}
export function cardState(card, repo, config, now) {
  const declared = config.phases.some((p) => p[0] === card.phase) ? card.phase : null;
  const base = { num: Number.isInteger(card.num) && card.num >= 1 && card.num <= 1e6 ? card.num : null, phase: declared, headSha12: null, signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: now };
  if (!repo) return base;
  const tips = headsFor(card.id, repo.tips.filter((h) => h.branch !== repo.main));
  const tip = tips[0];
  if (!tip) return base;
  const one = tipState(card, tip, repo, config, now, declared);
  const out = { ...base, ...one };
  if (tips.length > 1) {
    const taken = new Set();
    out.branches = tips.slice(0, MAX_BRANCH_ROWS).map((t, n) => ({ name: branchName(t.branch, taken, n), ci: "none", ciMin: null, ...(t === tip ? one : tipState(card, t, repo, config, now, declared)) }));
  }
  return out;
}

export function cardStates({ cards, config, repos, now }) {
  const out = {};
  for (const card of cards.filter((k) => !closed(k) && CARD_ID.test(String(k.id)) && k.id.length <= CARD_ID_MAX).slice(0, MAX_CARDS)) {
    const r = repoOf(card, config);
    let repo = repos[r ? r.name : ""] ?? null;
    // #C632: a card with no repo field and no id prefix of a listed repository belongs to the one whose branches name it
    // (a Board-Id trailer or a branch named for it): the team's own if it has one, else the repository with the newest tip;
    // none has one: the team's own, as before.
    if (!r && !card.repo) {
      const tipOf = (x) => headsFor(card.id, (x.tips ?? []).filter((h) => h.branch !== x.main))[0];
      const found = Object.values(repos).map((x) => [x, tipOf(x)]).filter(([, t]) => t).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))[0];
      if (found && !(repo && tipOf(repo))) repo = found[0];
    }
    out[card.id] = cardState(card, repo, config, now);
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
  return { tile: usageReading({ rows, roster, plan, now, asOf }), save, rows, total, resetsAt, asOf };
}

// The state that leaves, checked against the allowlist before it does.
export function buildState({ id, now, probe, pageVersion, cards, agents, lastWrite = null, wakeAlive = null, wakeSeen = null, cardsChecked = null, evidence = null, ctx = null, stuck = null, usage = null }) {
  const s = { v: STATE_VERSION, board: { boardId: id, at: now, probe: sha12(probe), pageVersion: sha12(pageVersion), lastWriteAt: lastWrite, wakeAliveAt: wakeAlive, wakeSeenAt: wakeSeen, cardsCheckedAt: cardsChecked, ...(evidence === null ? {} : { evidenceAt: evidence }) }, cards, agents, ...(ctx ? { ctx } : {}), ...(stuck ? { stuck } : {}), ...(usage ? { usage } : {}) };
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
  const run = (cwd) => (bin, timeout) => (args) => execFileSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout, maxBuffer: 64 * 1024 * 1024 });
  const repoAt = (path, remote, main, notes) => {
    const git = run(path)("git", 30_000);
    // fresh: this run read the repository as GitHub has it now (#C591): the fetch and the tips both worked.
    let fresh = true;
    if (fetchIt) { try { git(fetchBranches(remote)); git(["fetch", "-q", remote, "+refs/notes/*:refs/notes/flight-board/*"]); } catch { fresh = false; /* read what is here */ } }
    const local = Object.fromEntries(Object.entries(notes).map(([p, ref]) => [p, `refs/notes/flight-board/${ref.slice("refs/notes/".length)}`]));
    let tips = [];
    try { tips = remoteTips(git, remote); } catch { fresh = false; /* an empty clone */ }
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
  // A repository git can't read gives no tips: its cards stay as declared.
  const repos = {};
  if (c.repoPath) {
    const r = repoAt(home(c.repoPath), c.remote, c.mainBranch, c.notes);
    let live = null;
    if (c.deployWorkflow) { try { live = JSON.parse(r.gh(["run", "list", "--branch", c.mainBranch, "--workflow", c.deployWorkflow, "--status", "success", "--limit", "1", "--json", "headSha"]))[0]?.headSha ?? null; } catch { /* none */ } }
    repos[""] = { ...r, ci: ciReader(r.gh, now, ciCache, backoff), ships: now < backoff.until ? null : shipRuns(r.gh, now, shipBackoff, { git: r.git, shippedPattern: c.shippedPattern }), live: /^[0-9a-f]{40}$/.test(live ?? "") ? live : null, versionPattern: c.versionPattern, shippedPattern: c.shippedPattern };
  }
  for (const x of c.repos) {
    const installed = installedSha(home(x.installedLink ?? ""));
    repos[x.name] = { ...repoAt(home(x.path), x.remote ?? "origin", x.mainBranch ?? "main", x.notes), gh: null, live: installed, versionPattern: null };
  }
  // The cards on the last export; the agents from the app's files.
  const cards = [];
  const mdir = join(stateDir, id, "mirror", "initiatives");
  try { for (const f of readdirSync(mdir)) { if (!f.endsWith(".json")) continue; const r = readTail(join(mdir, f), 256 * 1024); if (!r?.whole) continue; try { const d = JSON.parse(r.text); if (plain(d)) cards.push({ ...d, id: f.slice(0, -5) }); } catch { /* skip it */ } } } catch { /* no export yet */ }
  const ids = new Set(cards.filter((k) => !closed(k)).map((k) => k.id));
  const nums = new Map(cards.filter((k) => Number.isInteger(k.num) && ids.has(k.id)).map((k) => [k.num, k.id]));
  const sessions = appSessions(join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"));
  const prompts = {}, tools = {}, tokens = {};
  const agents = agentStates({ roles: config.roster, sessionIds: { ...config.rosterSessions, ...(config.gate.managerSession ? { [config.gate.managerRole]: config.gate.managerSession } : {}) }, sessions, homeDir: homedir(), now, ids, nums, prompts, tools, tokens });
  // The roles' context, who is stuck, and the usage tile (#C592, #C593, #C595); a role past resetAt is asked to reset once
  // (context-reset.json, which the lead's wake watch prints), and asked again only after it came back under.
  const ctx = ctxReadings({ tokens, resetAt: config.resetAt, now });
  const stuck = stuckReadings({ agents, prompts, now, lead: config.gate.managerRole });
  const resetPath = join(stateDir, id, "context-reset.json");
  let resetBefore = null;
  try { const r = readTail(resetPath, 16 * 1024); if (r?.whole) resetBefore = JSON.parse(r.text); } catch { /* none */ }
  // The lead is never cued to reset by the probe (TEAM.md: the lead hands off on its own, when idle over its limit).
  const resets = resetAsks(Object.fromEntries(Object.entries(ctx).filter(([role]) => role !== config.gate.managerRole)), resetBefore, now);
  const dir = join(stateDir, id);
  const spend = usageTile({ scriptText: pinnedScript(c.usageScript, c.usageScriptSha256), dir, roster: config.roster, now, quota: c.usageQuota, resetAt: c.usageResetAt, run: (args, input) => execFileSync("python3", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }) });
  // Roles to wake (#C583): no open session and work waiting (wake-by-need), asked once per spell; the rest reported missing.
  const wakePath = join(dir, "wake-roles.json");
  let wakeBefore = null;
  try { const r = readTail(wakePath, 16 * 1024); if (r?.whole) wakeBefore = JSON.parse(r.text); } catch { /* none */ }
  const needs = wakeNeeds({ roster: config.roster, agents, cards: cards.filter((k) => !closed(k)), lead: config.gate.managerRole });
  const wakeAsk = askOnce(needs.wake, wakeBefore, now), missingAsk = askOnce(needs.missing, { roles: wakeBefore?.missing }, now);
  // Questions for the owner that never became a Needs-you item (#C584), for the lead to write from the wake watch's line.
  const waitingDocs = [], wdir = join(stateDir, id, "mirror", "waiting");
  let waitingKnown = false, exportedAt = 0;
  try { waitingKnown = true; exportedAt = lstatSync(wdir).mtimeMs; for (const f of readdirSync(wdir)) { if (!f.endsWith(".json")) continue; const r = readTail(join(wdir, f), 64 * 1024); if (!r?.whole) continue; exportedAt = Math.max(exportedAt, r.mtimeMs); try { const d = JSON.parse(r.text); if (plain(d)) waitingDocs.push(d); } catch { /* skip it */ } } } catch { waitingKnown = false; /* no export of the waiting items yet: no ask is listed on a guess */ }
  // The export is the Collector's, on demand (#C594): an item the lead wrote after it isn't in it. No ask is listed from an
  // export older than MIRROR_STALE_MS, or the lead would be told to write an item that already exists (Checker on 46d97a0).
  if (waitingKnown && !mirrorFresh(exportedAt, now, config.gate.mirrorMaxAgeMin * 60e3)) waitingKnown = false;
  const asksPath = join(dir, "owner-asks.json");
  let asksBefore = null;
  try { const r = readTail(asksPath, 64 * 1024); if (r?.whole) asksBefore = JSON.parse(r.text); } catch { /* none */ }
  const ownerAsked = askSince(waitingKnown ? ownerAsks({ cards: cards.filter((k) => !closed(k)), waiting: waitingDocs, owner: config.owner }) : [], asksBefore, now);
  let pageVersion = null;
  try { pageVersion = basename(readlinkSync(join(stateDir, "current"))); } catch { /* no link */ }
  let state;
  const checkedPath = join(stateDir, id, "cards-checked.json");
  let checkedBefore = null;
  try { const r = readTail(checkedPath, 4096); if (r?.whole) checkedBefore = JSON.parse(r.text)?.at; } catch { /* none */ }
  const cardsChecked = cardsCheckedAt(Object.values(repos), now, checkedBefore);
  let cardsNow;
  try {
    cardsNow = cardStates({ cards, config, repos, now });
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
    state = buildState({ id, now, probe: basename(CODE), pageVersion, cards: cardsNow, agents, lastWrite: lastWriteAt(join(stateDir, id, "gate.json"), now), cardsChecked, evidence, ctx, stuck, usage: spend.tile, ...wakeTimes(join(stateDir, id), now) });
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
  } catch (e) { console.error(`state: ${String(e.message).split("\n")[0]}`); process.exit(1); }
  if (process.argv.includes("--no-post")) { console.log(`state: written, ${Object.keys(state.cards).length} card(s), ${Object.keys(state.agents).length} agent(s), not posted`); process.exit(0); }
  const secrets = readSecrets(secretsDir(stateDir, id));
  console.log(secrets ? await postState(fetch, secrets, id, state) : "state: written, not posted (no secrets from the owner's install, or they are open to others)");
  // The owner's wake counter (#C580) into wake.json, for the lead's wake watch: only when it changed. A Worker that has no
  // wake route yet (an older deploy: 404) leaves no file, so the lead's Stop hook never asks for a watch it can't use.
  if (secrets) {
    const got = await getWake(fetch, secrets, id), p = wakePaths(join(stateDir, id));
    const next = got.wake ? nextWakeFile(got.wake, readWakeFile(p.wake)) : null;
    if (next) { try { writeAtomic(p.wake, next); console.log(`wake: #${got.wake.seq}`); } catch { console.log("wake: wake.json could not be written"); } }
    else if (got.line) console.log(got.line);
  }
}
