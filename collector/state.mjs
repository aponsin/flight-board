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
import { readFileSync, writeFileSync, renameSync, readdirSync, lstatSync, openSync, fstatSync, readSync, closeSync, realpathSync, readlinkSync, constants } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { STATE_VERSION, stateErrors, pickState, toolClass, CARD_ID, CARD_ID_MAX, ROLE, MAX_BYTES, MAX_CARDS } from "./state-schema.mjs";

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
      out.push({ title: s.title, transcript: s.cliSessionId, cwd: s.cwd, at: Number.isFinite(s.lastActivityAt) ? Math.round(s.lastActivityAt) : null });
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

// One role's activity from its transcript's last entries: { state, tool, card, since }.
export function activity(entries, { mtimeMs, now, ids, nums }) {
  const last = entries.at(-1);
  if (!last) return { state: "unknown", tool: null, card: null, since: null };
  const midTurn = last.type === "user" || (last.type === "assistant" && last.message.stop_reason === "tool_use");
  const state = midTurn && now - mtimeMs <= WORKING_QUIET_MS ? "working" : "idle";
  let tool = null;
  for (let k = entries.length - 1; k >= 0 && !tool; k--) if (entries[k].type === "assistant") tool = toolClass(blocks(entries[k]).filter((b) => b.type === "tool_use").at(-1)?.name);
  const since = state === "working" ? timeOf(entries.findLast(isPrompt)) : timeOf(entries.findLast((e) => e.type === "assistant"));
  return { state, tool, card: cardIn(entries, ids, nums), since };
}

// Every roster role's agent, from its newest open session titled exactly as the role.
export function agentStates({ roles, sessions, homeDir, now, ids, nums, uid = process.getuid() }) {
  const out = {};
  for (const role of roles.filter((r) => ROLE.test(r))) {
    const s = sessions.filter((x) => x.title === role).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
    if (!s) continue;
    const p = transcriptPath(homeDir, s.cwd, s.transcript);
    const tail = p ? readTail(p, TAIL_BYTES, uid) : null;
    const a = tail ? activity(lastEntries(tail), { mtimeMs: tail.mtimeMs, now, ids, nums }) : { state: "unknown", tool: null, card: null, since: null };
    out[role] = { state: a.state, lastActivityAt: s.at, tool: a.tool, card: a.card, since: a.since };
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
  try { runs = JSON.parse(gh(["run", "list", "--commit", sha, "--limit", "1", "--json", "status,conclusion,createdAt,updatedAt"])); } catch { return { ci: "none", ciMin: null }; }
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
export function ciReader(gh, now, cache) {
  let calls = 0;
  return (sha) => {
    const kept = ciEntry(cache[sha]);
    if (kept) return kept;
    if (calls >= MAX_CI_CALLS) return { ci: "none", ciMin: null };
    calls++;
    const r = ciOf(gh, sha, now);
    if (FINISHED.includes(r.ci)) cache[sha] = { ci: r.ci, ciMin: r.ciMin };
    return { ci: r.ci, ciMin: r.ciMin };
  };
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

// One card: its phase by the evidence (the declared one when the repository shows nothing), and the facts beside it.
export function cardState(card, repo, config, now) {
  const declared = config.phases.some((p) => p[0] === card.phase) ? card.phase : null;
  const base = { num: Number.isInteger(card.num) && card.num >= 1 && card.num <= 1e6 ? card.num : null, phase: declared, headSha12: null, signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: now };
  if (!repo) return base;
  const tips = headsFor(card.id, repo.tips.filter((h) => h.branch !== repo.main));
  const head = tips[0];
  if (!head) return base;
  const signed = Object.entries(repo.notes).filter(([, ref]) => ok(() => repo.git(["notes", `--ref=${ref}`, "show", head.sha]))).map(([p]) => p).sort();
  const onMain = ok(() => repo.git(["merge-base", "--is-ancestor", head.sha, `${repo.remote}/${repo.main}`]));
  const deployed = onMain && !!repo.live && ok(() => repo.git(["merge-base", "--is-ancestor", head.sha, repo.live]));
  const cfg = { ...config, collector: { ...config.collector, notes: repo.notes, mainBranch: repo.main } };
  const phase = phaseOf(card, { head, signed: new Set(signed), onMain, deployed }, cfg);
  return { ...base, phase: phase ?? declared, headSha12: sha12(head.sha), signed, onMain, ...(() => { const r = repo.ci ? repo.ci(head.sha) : repo.gh ? ciOf(repo.gh, head.sha, now) : null; return r ? { ci: r.ci, ciMin: r.ciMin } : {}; })(), liveVersion: deployed && repo.versionPattern ? versionAfter(repo.git, head.sha, repo.live, repo.versionPattern) : null };
}

export function cardStates({ cards, config, repos, now }) {
  const out = {};
  for (const card of cards.filter((k) => !closed(k) && CARD_ID.test(String(k.id)) && k.id.length <= CARD_ID_MAX).slice(0, MAX_CARDS)) {
    const r = repoOf(card, config);
    out[card.id] = cardState(card, repos[r ? r.name : ""] ?? null, config, now);
  }
  return out;
}

// The state that leaves, checked against the allowlist before it does.
export function buildState({ id, now, probe, pageVersion, cards, agents }) {
  const s = { v: STATE_VERSION, board: { boardId: id, at: now, probe: sha12(probe), pageVersion: sha12(pageVersion) }, cards, agents };
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

// The POST: https only, no redirect, 15 s at most. Its one line says the Worker's status, never the token.
export async function postState(fetchImpl, secrets, id, state) {
  const body = JSON.stringify(state);
  if (Buffer.byteLength(body) > MAX_BYTES) return "state: not posted (over 64 KB)";
  try {
    const r = await fetchImpl(`${secrets.url}/b/${id}/state`, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${secrets.token}`, "content-type": "application/json" }, body, signal: AbortSignal.timeout(15_000) });
    return r.status === 204 ? "state: posted" : `state: the Worker answered ${Number(r.status)}`;
  } catch { return "state: the Worker could not be reached"; }
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
    if (fetchIt) { try { git(["fetch", "-q", remote]); git(["fetch", "-q", remote, "+refs/notes/*:refs/notes/flight-board/*"]); } catch { /* read what is here */ } }
    const local = Object.fromEntries(Object.entries(notes).map(([p, ref]) => [p, `refs/notes/flight-board/${ref.slice("refs/notes/".length)}`]));
    let tips = [];
    try { tips = remoteTips(git, remote); } catch { /* an empty clone */ }
    return { git, gh: run(path)("gh", 15_000), remote, main, notes: local, tips };
  };
  // Finished CI runs, kept by commit from run to run (the newest 500).
  const ciPath = join(stateDir, id, "ci-cache.json");
  let ciCache = {};
  try { const r = readTail(ciPath, 1024 * 1024); const o = r?.whole ? JSON.parse(r.text) : null; if (plain(o)) ciCache = Object.fromEntries(Object.entries(o).filter(([k]) => /^[0-9a-f]{40}$/.test(k)).map(([k, v]) => [k, ciEntry(v)]).filter(([, v]) => v)); } catch { /* start afresh */ }
  // A repository git can't read gives no tips: its cards stay as declared.
  const repos = {};
  if (c.repoPath) {
    const r = repoAt(home(c.repoPath), c.remote, c.mainBranch, c.notes);
    let live = null;
    if (c.deployWorkflow) { try { live = JSON.parse(r.gh(["run", "list", "--branch", c.mainBranch, "--workflow", c.deployWorkflow, "--status", "success", "--limit", "1", "--json", "headSha"]))[0]?.headSha ?? null; } catch { /* none */ } }
    repos[""] = { ...r, ci: ciReader(r.gh, now, ciCache), live: /^[0-9a-f]{40}$/.test(live ?? "") ? live : null, versionPattern: c.versionPattern };
  }
  for (const x of c.repos) {
    let installed = null;
    try { const s = basename(readlinkSync(home(x.installedLink ?? ""))); installed = /^[0-9a-f]{40}$/.test(s) ? s : null; } catch { /* nothing installed */ }
    repos[x.name] = { ...repoAt(home(x.path), x.remote ?? "origin", x.mainBranch ?? "main", x.notes), gh: null, live: installed, versionPattern: null };
  }
  // The cards on the last export; the agents from the app's files.
  const cards = [];
  const mdir = join(stateDir, id, "mirror", "initiatives");
  try { for (const f of readdirSync(mdir)) { if (!f.endsWith(".json")) continue; const r = readTail(join(mdir, f), 256 * 1024); if (!r?.whole) continue; try { const d = JSON.parse(r.text); if (plain(d)) cards.push({ ...d, id: f.slice(0, -5) }); } catch { /* skip it */ } } } catch { /* no export yet */ }
  const ids = new Set(cards.filter((k) => !closed(k)).map((k) => k.id));
  const nums = new Map(cards.filter((k) => Number.isInteger(k.num) && ids.has(k.id)).map((k) => [k.num, k.id]));
  const sessions = appSessions(join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"));
  const agents = agentStates({ roles: config.roster, sessions, homeDir: homedir(), now, ids, nums });
  let pageVersion = null;
  try { pageVersion = basename(readlinkSync(join(stateDir, "current"))); } catch { /* no link */ }
  let state;
  try {
    state = buildState({ id, now, probe: basename(CODE), pageVersion, cards: cardStates({ cards, config, repos, now }), agents });
    writeAtomic(join(stateDir, id, "state.json"), JSON.stringify(state));
    writeAtomic(ciPath, JSON.stringify(Object.fromEntries(Object.entries(ciCache).slice(-500))));
  } catch (e) { console.error(`state: ${String(e.message).split("\n")[0]}`); process.exit(1); }
  if (process.argv.includes("--no-post")) { console.log(`state: written, ${Object.keys(state.cards).length} card(s), ${Object.keys(state.agents).length} agent(s), not posted`); process.exit(0); }
  const secrets = readSecrets(secretsDir(stateDir, id));
  console.log(secrets ? await postState(fetch, secrets, id, state) : "state: written, not posted (no secrets from the owner's install, or they are open to others)");
}
