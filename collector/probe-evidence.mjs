// The new probe's evidence and usage jobs against the board store (#C719). The readings themselves (git, GitHub, sessions,
// the usage script) are collector/state.mjs's pure functions, run by its own CLI with --no-post --no-derive, which leaves the
// state it built in <stateDir>/<board id>/state.json. This module only maps that state to the store's evidence keys and posts
// them as the probe, so the readings are computed in one place and the store gets nothing typed or copied.
//   evidence job (60 s): cards.<id> {lit:[phase], ...the card's reading}, agents, ctx, board
//   usage job (300 s):   usage
// A key whose reading is missing is not written (the store then shows it as unknown/silent, never as a guess).
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runActionsUsage } from "./actions-usage.mjs";
import { appSessions } from "./state.mjs";
import { scheduleModelsWrite } from "./schedule-models.mjs";
import { fillRepoWords } from "./repo-words.mjs";
import { createHash } from "node:crypto";
import { runChild, startRun, JOBS } from "./probe-run.mjs";
import { loadEnv, accessHeaders, FETCH_TIMEOUT_MS } from "./probe-board.mjs";
import { prepareStoreState } from "./store-cards.mjs";

const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const CARD_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

// The writes of one job, from a built state. `track` is not sent: the store checks a phase against its own track list only
// when the probe names one.
export function evidenceWrites(state, job) {
  if (!plain(state)) return [];
  if (job === "usage") return plain(state.usage) ? [{ key: "usage", value: state.usage }] : [];
  const out = [];
  for (const [id, c] of Object.entries(plain(state.cards) ? state.cards : {})) {
    if (!CARD_KEY.test(id) || !plain(c) || typeof c.phase !== "string") continue; // no phase read: the card stays as the store has it
    out.push({ key: `cards.${id}`, value: { lit: [c.phase], ...c } });
  }
  if (plain(state.agents)) out.push({ key: "agents", value: state.agents });
  if (plain(state.ctx)) out.push({ key: "ctx", value: state.ctx });
  if (plain(state.board)) out.push({ key: "board", value: state.board });
  // #C723 B3a: the old page's "stuck" marks and its restart badge ("Safe to restart" is never green while a ship candidate is
  // pushed) read these two; a state without them (a probe before them, or nothing stuck and no candidate) writes nothing.
  if (plain(state.stuck)) out.push({ key: "stuck", value: state.stuck });
  if (plain(state.ship)) out.push({ key: "ship", value: state.ship });
  // #C1005 part c: what the watchdog task told Manager (an app restart, new permission prompts, a silent ledger), only on the run that has something.
  if (plain(state.watch)) out.push({ key: "watch", value: state.watch });
  // #C731 B4b: the release log's CI times by version, for the page's ETA box (derived/all's releaseTimes).
  if (plain(state.releases)) out.push({ key: "releases", value: state.releases });
  return out;
}

const post = (fetchImpl, base, headers, body) => fetchImpl(`${base}/api/probe/evidence`, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

// Posts every write, POST_CONCURRENCY at a time (#C996: 122 posts one after another took 15 to 20 s of a run); a refusal (422) of one key is
// logged and the rest still go, any other failure stops the run (the posts already under way finish, none new starts, and the error carries
// `posted`, the keys that did go). Past `deadline` no new post starts: the result says `stopped` and which went (`ok`), so the caller records
// those and the rest go first next run, instead of the watchdog killing the run between a post and its record.
export const POST_CONCURRENCY = 6;
// #C996 (Checker 2 F1): the posts' deadline sits at the run's start plus the limit less POST_TAIL_SEC, the room for a post under way (8 s, FETCH_TIMEOUT_MS),
// the live read (8 s) and the late writes (8 s) and a margin, never later than that however late the child ended; the late writes start no later than
// LATE_TAIL_SEC short of the limit (one post, 8 s, still fits).
export const POST_TAIL_SEC = 30;
export const LATE_TAIL_SEC = 10;
export const LIVE_SKIP_SEC = 20;
export const ESSENTIAL_KEYS = ["board", "run.evidence"];
export async function postWrites(writes, { base, headers, fetchImpl = fetch, log = () => {}, concurrency = POST_CONCURRENCY, deadline = Infinity, clock = Date.now }) {
  let written = 0, refused = 0, stopped = false, fatal = null, next = 0;
  const ok = [];
  const worker = async () => {
    while (fatal === null && next < writes.length) {
      if (clock() >= deadline) { stopped = true; return; }
      const w = writes[next++];
      let r;
      try { r = await post(fetchImpl, base, headers, w); } catch (e) { fatal ??= e; return; }
      if (r.ok) { written++; ok.push(w.key); continue; }
      if (r.status === 422) { refused++; let why = ""; try { why = JSON.stringify((await r.json())?.refusal ?? "").slice(0, 120); } catch { /* none */ } log(`${w.key} refused ${why}`); continue; }
      fatal ??= new Error(`evidence write ${w.key} answered ${r.status}`);
      return;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, writes.length)) }, worker));
  if (fatal) throw Object.assign(fatal, { posted: ok });
  return { written, refused, ok, stopped };
}

// #C996: only what changed is posted (a run posted 122 keys, ~110 of them cards that had not changed). A card's reading is posted when it differs from
// the last one posted, ignoring `at` (the time it was read: every reading's own), and again REPOST_MS after the last post whatever it says, because the
// store reads a card whose reading is not rewritten for an hour as a repository copy gone stale (board-rules staleCopies, #C927). Every other key
// (agents, ctx, board, stuck, ship, releases, usage, run.evidence) is posted every run: `board` is the heartbeat, and they are few. kept is
// { key: { h, at } } as the last run saved it; a key not in the writes any more is dropped; a time in the future (a clock set back) counts as due.
// Order: every other key first, then the cards, oldest post first and never-posted before all: when a run is cut at its deadline, the keys left over
// lead the next.
export const REPOST_MS = 10 * 60_000;
const readingHash = (value) => { const { at, ...rest } = plain(value) ? value : { v: value }; return createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 16); };
export function dueWrites(writes, kept, now) {
  const due = [], hashes = new Map(), carried = {};
  const had = plain(kept) ? kept : {};
  for (const w of writes) {
    if (!w.key.startsWith("cards.")) { due.push(w); continue; }
    const h = readingHash(w.value), k = Object.hasOwn(had, w.key) && plain(had[w.key]) ? had[w.key] : null;
    hashes.set(w.key, h);
    if (k && k.h === h && Number.isFinite(k.at) && k.at <= now && now - k.at < REPOST_MS) { carried[w.key] = { h: k.h, at: k.at }; continue; }
    due.push(w);
  }
  const lastAt = (w) => (Object.hasOwn(had, w.key) && Number.isFinite(had[w.key]?.at) ? had[w.key].at : 0);
  const isCard = (w) => (w.key.startsWith("cards.") ? 1 : 0);
  due.sort((a, b) => isCard(a) - isCard(b) || lastAt(a) - lastAt(b)); // the few other keys first: `board` is the heartbeat, never starved by a long run of cards
  return { due, carried, hashes };
}
// What to keep after a run: the carried entries and the cards that were posted this time.
export const keptAfter = ({ carried, hashes }, postedKeys, now) => ({ ...carried, ...Object.fromEntries(postedKeys.filter((k) => hashes.has(k)).map((k) => [k, { h: hashes.get(k), at: now }])) });

// The state child's environment. A launchd job starts with PATH=/usr/bin:/bin:/usr/sbin:/sbin, where git is but gh (Homebrew) is not, so every
// gh call of the state build failed (ENOENT): CI never read, the deploy run never read, the gh back-off at its 30-minute maximum, and the
// board showed every card of the main repository as shipped, not live (#C731, #C722 and #C724). The usual install folders are put on PATH.
export const GH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
export function childEnv(env = process.env) {
  const have = String(env.PATH ?? "").split(":").filter(Boolean);
  return { ...env, PATH: [...GH_DIRS.filter((d) => !have.includes(d)), ...have].join(":") };
}
export const defaultBuild = (args, ms, runner = runChild, env = childEnv(), extra = {}) => runner(process.execPath, args, { timeoutMs: ms, env: { ...env, ...extra } });

// #C737: what the store says is deployed. The commit the Worker was deployed from (its probe-only /api/probe/build) and the commit of the
// tree this code runs from. Each is "" when unknown. The state child gets them (FB_DEPLOY_*) and a board-repository card is live only
// when inside both; the old state job sets none of it and keeps reading the installed link.
export const FULL_SHA = /^[0-9a-f]{40}$/;
export const defaultTreeSha = () => { const s = execFileSync("git", ["-C", join(import.meta.dirname, ".."), "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); return FULL_SHA.test(s) ? s : ""; };
export async function readDeploy({ base, headers, fetchImpl = fetch, treeSha = defaultTreeSha, log = () => {} }) {
  let worker = "";
  try {
    const r = await fetchImpl(`${base}/api/probe/build`, { headers, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) log(`deploy: the Worker's build answered ${r.status}`);
    else { const s = (await r.json())?.sha; if (typeof s === "string" && FULL_SHA.test(s)) worker = s; else log("deploy: the Worker does not say which commit it was deployed from"); }
  } catch (e) { log(`deploy: the Worker's build is unreadable (${String(e.message).slice(0, 60)})`); }
  let tree = "";
  try { tree = treeSha(); } catch { log("deploy: the tree's commit is unreadable"); }
  return { worker, tree: FULL_SHA.test(tree) ? tree : "" };
}
export const deployEnv = (d) => ({ FB_DEPLOY_RULE: "1", FB_DEPLOY_WORKER: d.worker, FB_DEPLOY_TREE: d.tree });

export const stateArgs = (configPath) => [join(import.meta.dirname, "state.mjs"), "--config", configPath, "--no-post", "--no-derive"];

// "Live now": the product's own /version.json, on the host of the board config's liveUrl, read by the probe each evidence run.
// The store stamps the read time itself, so a reading that stops coming turns stale in 3 minutes and is never shown as live.
// Anything unreadable or not shaped like a version writes nothing (the chip then says unknown or stale, never a guess).
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]{1,40})?$/;
export async function liveWrite(configText, { fetchImpl = fetch, log = () => {} } = {}) {
  // The liveUrl sits where state.mjs reads it: collector.liveUrl in the board config.
  let url;
  try { const u = new URL("/version.json", JSON.parse(configText)?.collector?.liveUrl); if (u.protocol !== "https:") throw new Error("not https"); url = u; } catch { log("live: the board config has no usable https collector.liveUrl"); return null; }
  try {
    const r = await fetchImpl(url.href, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) { log(`live ${url.host} answered ${r.status}`); return null; }
    const v = (await r.json())?.version;
    if (typeof v !== "string" || !VERSION.test(v)) { log("live reading has no version"); return null; }
    return { key: "live", value: { version: `v${v}` } };
  } catch (e) { log(`live ${url.host} unreadable: ${String(e.message).slice(0, 80)}`); return null; }
}

// #C873: the product's daily full test run. The product's own scripts/daily-e2e.mjs --status prints one JSON line {state, reason, run, lastGreenAt}
// and exits 1 for red or missed, 2 for unknown: the line is read, never the exit code. The product is the board config's collector.repoPath (the
// probe's clone: nothing for the owner to type). The clone's working tree is not kept up to date (it only fetches), so the script and its one
// library file are taken from the clone's origin/main (git show into a temporary folder, run there, removed): a product whose main does not
// have them yet reads unknown, with that reason. The USAGE job (every 5 min, room for a slow gh) asks it at most every 30
// minutes and keeps the answer beside the state (e2e.json); the evidence job writes the kept answer under the key e2e every run (like live,
// after the evidence, never failing the job), so the page's 3-minute freshness holds. A script that fails to run or answers nothing readable is
// kept as unknown, never as ok, and a kept answer older than 2 h is written as unknown too (the asking stopped).
export const E2E_EVERY_MS = 30 * 60_000, E2E_STALE_MS = 2 * 3_600_000;
const E2E_STATES = ["ok", "red", "missed", "unknown"];
export const E2E_FILES = ["scripts/daily-e2e.mjs", "scripts/lib/workflow-checks.mjs"];
const SAFE_REF = /^[A-Za-z0-9._\/-]{1,100}$/;
// target { cwd, ref }: the product's clone and its remote/main. Returns what spawnSync does (status, stdout, error).
export function defaultE2eRun({ cwd, ref }, env, exec = spawnSync) {
  if (!SAFE_REF.test(ref) || ref.startsWith("-")) return { error: { code: "bad-ref" } };
  const files = {};
  for (const p of E2E_FILES) {
    const r = exec("git", ["-C", cwd, "show", `${ref}:${p}`], { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
    if (!r || r.error || r.status !== 0) return { status: 2, stdout: JSON.stringify({ state: "unknown", reason: `the product's ${ref} has no ${p} yet`, run: null, lastGreenAt: null }) };
    files[p] = r.stdout;
  }
  // The real path: on macOS tmpdir() is /var/folders/..., a symlink to /private/var/...; node gives import.meta.url the real path but process.argv[1]
  // stays as given, so the product script's "am I the entry point" guard is false and it prints nothing (Checker F1 on b9f4946).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fb-e2e-")));
  try {
    for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), text); }
    return exec(process.execPath, [join(dir, E2E_FILES[0]), "--status"], { cwd: dir, env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
export function e2eReading(r) {
  const unknown = (reason) => ({ state: "unknown", reason, run: null, lastGreenAt: null });
  if (!r || r.error) return unknown(`the product's daily-e2e script did not run (${String(r?.error?.code ?? "no answer").slice(0, 30)})`);
  const line = String(r.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean).pop();
  let j; try { j = JSON.parse(line); } catch { return unknown(`the product's daily-e2e script answered nothing readable (exit ${r.status})`); }
  if (!plain(j) || !E2E_STATES.includes(j.state)) return unknown(`the product's daily-e2e script answered an unknown state (exit ${r.status})`);
  const run = typeof j.run === "string" && j.run.length <= 300 && /^https:\/\/[^\s"'<>\\]+$/.test(j.run) ? j.run : null;
  const green = typeof j.lastGreenAt === "string" && Number.isFinite(Date.parse(j.lastGreenAt)) ? j.lastGreenAt : null;
  return { state: j.state, reason: String(j.reason ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200), run, lastGreenAt: green };
}
// The product's clone and its main, from the board config: null (and a log line) when collector.repoPath is empty.
function e2eFolder(configText, log, home) {
  let k;
  try { k = JSON.parse(configText)?.collector; } catch { log("e2e: the board config could not be read"); return null; }
  const path = k?.repoPath;
  if (typeof path !== "string" || !path) { log("e2e: the board config has no collector.repoPath, the daily run is not read"); return null; }
  const word = (v, d) => (typeof v === "string" && v ? v : d);
  return { cwd: expandHome(path, home), ref: `${word(k.remote, "origin")}/${word(k.mainBranch, "main")}` };
}
const e2eFile = (stateFile) => join(dirname(stateFile), "e2e.json");
const e2eKept = (read, file) => { try { const k = JSON.parse(read(file)); return plain(k) && Number.isFinite(k.at) && plain(k.value) && E2E_STATES.includes(k.value.state) ? k : null; } catch { return null; } };
// Usage job: ask the script when the kept answer is 30 minutes old (or none), and keep what it says. Never throws.
export function e2eStep(configText, { stateFile, env, log = () => {}, now = Date.now(), run = defaultE2eRun, read = (p) => readFileSync(p, "utf8"), write = (p, t) => writeFileSync(p, t), home = homedir() } = {}) {
  try {
    const target = e2eFolder(configText, log, home);
    if (!target) return null;
    const file = e2eFile(stateFile), kept = e2eKept(read, file);
    if (kept && kept.at <= now && now - kept.at < E2E_EVERY_MS) return kept.value;
    const value = e2eReading(run(target, env));
    log(`e2e: the daily run reads ${value.state}`);
    write(file, JSON.stringify({ at: now, value }));
    return value;
  } catch (e) { log(`e2e failed: ${String(e.message).slice(0, 80)}`); return null; }
}
// Evidence job: the kept answer as the write for key e2e; unknown when it is missing or over 2 h old; null (written nothing) when not configured.
export function e2eWrite(configText, { stateFile, log = () => {}, now = Date.now(), read = (p) => readFileSync(p, "utf8"), home = homedir() } = {}) {
  if (!e2eFolder(configText, log, home)) return null;
  const kept = e2eKept(read, e2eFile(stateFile));
  if (kept && now - kept.at <= E2E_STALE_MS) return { key: "e2e", value: kept.value };
  return { key: "e2e", value: { state: "unknown", reason: kept ? "the daily full test run has not been read for over 2 hours" : "the daily full test run has not been read yet", run: null, lastGreenAt: null } };
}

// #C956: the team's visual lanes (config decisions.visualLanes), posted under the key look so the store's look rule can tell a Decision on a card of
// those lanes (the Worker has no board config). Posted every run, an empty list too, so a lane taken out of the config stops counting. A config
// that cannot be read, or whose lanes are not a list of plain names, writes nothing (the store keeps the last good list).
export function lookWrite(configText, { log = () => {} } = {}) {
  let lanes;
  try { lanes = JSON.parse(configText)?.decisions?.visualLanes; } catch { log("look: the board config could not be read"); return null; }
  if (lanes === undefined) lanes = [];
  if (!Array.isArray(lanes) || lanes.length > 20 || !lanes.every((r) => typeof r === "string" && /^[^<>{}\n]{1,60}$/.test(r))) { log("look: decisions.visualLanes is not a list of up to 20 role names; not posted"); return null; }
  return { key: "look", value: { visualLanes: [...lanes] } };
}

// #C736: the usage job also posts the day's runner and Actions usage (collector/actions-usage.mjs) to POST /api/probe/usage, which the
// store's Time spent chart and tiles read. It reads the team repository's workflow runs through gh in the repository folder of the board
// config (collector.repoPath), at most every 30 minutes for today and until read after the day ended for yesterday (the days read last are
// kept beside the state, in actions-usage.json). Anything that goes wrong here is logged and never fails the usage job: the usage tile above is
// posted first.
const defaultGh = (repoPath, env, exec = execFileSync) => (args, left = 60_000) => JSON.parse(exec("gh", ["api", ...args], { cwd: repoPath, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: Math.max(1000, Math.min(60_000, left)), maxBuffer: 32 * 1024 * 1024 }));
// The config's paths may start with "~" (as state.mjs reads them); a spawn's cwd does not expand it.
export const expandHome = (p, home = homedir()) => String(p).replace(/^~(?=\/|$)/, home);
// Every gh call checks the clock first: past the deadline (the job's limit less a margin) it stops, the day in hand stays due and nothing is
// saved for it, so the watchdog never kills the job between a post and its record, and the next run starts on it again.
// gh is told how long is left, so its own timeout is never longer than that.
const withDeadline = (gh, deadline, clock) => (args) => { const left = deadline - clock(); if (left <= 0) throw new Error("the job's time is spent"); return gh(args, left); };
export async function actionsUsageStep({ base, headers, fetchImpl, origConfig, stateFile, env, read, log, now = Date.now(), gh = null, write = (p, t) => writeFileSync(p, t), deadline = Infinity, clock = Date.now, home = homedir(), exec = execFileSync }) {
  try {
    const repoPath = JSON.parse(read(origConfig))?.collector?.repoPath;
    if (typeof repoPath !== "string" || !repoPath) { log("actions usage: the board config has no collector.repoPath"); return; }
    const file = join(dirname(stateFile), "actions-usage.json");
    let seen = {};
    try { const s = JSON.parse(read(file)); if (s && typeof s === "object" && !Array.isArray(s)) seen = s; } catch { /* first run */ }
    const post = async (row) => {
      const r = await fetchImpl(`${base}/api/probe/usage`, { method: "POST", headers, body: JSON.stringify(row), redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) log(`actions usage ${row.day} answered ${r.status}`);
      return r.ok;
    };
    const r = await runActionsUsage({ now, seen, gh: withDeadline(gh ?? defaultGh(expandHome(repoPath, home), env, exec), deadline, clock), post, log });
    if (r.posted) write(file, JSON.stringify(r.seen));
    log(`actions usage: ${r.posted} day(s) posted`);
  } catch (e) { log(`actions usage failed: ${String(e.message).slice(0, 120)}`); }
}

// One run: build the state, read it, post the job's keys.
// With privateDir, the cards come from the store (collector/store-cards.mjs), not from the old board's mirror, and the state is
// built and left in that private directory; without it, the job reads the old location as before.
// Whether gh can be run from the state child's environment. The evidence job still posts what git alone shows, but a run that cannot find
// gh ends as a failed run with a plain line in the log: it used to back off quietly for 30 minutes while the board showed every card
// of the main repository as shipped, never live (#C731).
export const defaultGhCheck = (env = childEnv(), exec = execFileSync) => { try { exec("gh", ["--version"], { env, timeout: 5000, stdio: "ignore" }); return true; } catch { return false; } };
export const GH_MISSING = "gh was not found on PATH: the deploy and CI runs were not read, so cards of the main repository cannot show live";

// #C962: the last line the state child printed to stderr, for the log and the page. A failed child used to leave only "node exited 1" (the 11-11
// freeze of 15:50 to 20:03 MT was one line, "agents.Security.card: not allowed", found only by running the child by hand). The child's own text
// never carries a card's words (the schema's errors name a field, not a value), and it is cut to 160 characters of plain text anyway.
export const CHILD_LINE_MAX = 160;
// What may leave the Mac as the reason: plain text, every word that holds a "/" (a file path, with the user's name and folders) shown as <path>, and
// every run of 24 or more letters, digits, - or _ (a token or key an error might ever quote) hidden, cut to CHILD_LINE_MAX (Checker LOW1 and
// Security's suggestion on fcaaa63).
export const plainLine = (s) => String(s ?? "").replace(/[^\x20-\x7e]/g, "").replace(/\S*\/\S*/g, "<path>").replace(/[A-Za-z0-9_-]{24,}/g, "<hidden>").replace(/\s+/g, " ").trim().slice(0, CHILD_LINE_MAX);
// The child's reason is its last "state: ..." line or its last "...Error: ..." line, not simply its last line: a crash outside the state child's own
// handlers ends with Node's "Node.js v24.21.0" after the stack (Checker F1 on fcaaa63, proved with a real child). Stack frames, the source excerpt's
// caret and Node's version trailer are never the reason; with neither kind of line, the last line left.
export const childLine = (e) => {
  const lines = String(e?.stderr ?? "").split(/\r?\n/).map((l) => l.replace(/[^\x20-\x7e]/g, "").trim()).filter((l) => l && !/^at\s/.test(l) && !/^Node\.js v\d/.test(l) && !/^[\^~|\s]+$/.test(l));
  const pick = lines.findLast((l) => /^state: /.test(l) || /^[A-Za-z]*(Error|Exception)\b/.test(l)) ?? lines.at(-1);
  return pick ? plainLine(pick) : "";
};
// #C996: the state child's own "timing:" line (collector/state.mjs timingText: fixed phase words and whole numbers), or "". Only a line of exactly that
// shape is ever logged, whatever else the child printed.
export const TIMING_LINE = /^timing:(?: [a-z][A-Za-z0-9+]{0,11}[=#]\d{1,9}){1,40}$/;
export const timingOf = (stdout) => String(stdout ?? "").split(/\r?\n/).map((l) => l.trim()).findLast((l) => TIMING_LINE.test(l)) ?? "";
// A run over this is logged and shown as slow: the job's limit is 170 s (worker/probe-jobs.mjs, #C996's stopgap; it was 90 s with 75 s
// here, when good runs took 60 to 88 s and one was killed), so this is as near its limit as 75 s was to 90 s. It reverts with the limit.
export const SLOW_RUN_MS = 150_000;

// #C982: the board Worker deploy's last result. The owner's deploy file leaves board-deploy-last.json { ok, at, line } beside the board config after every
// run (scripts/pair/deploy.template.mjs, recordLast); the probe posts it as evidence deploy.last so the page header can say "Deploy failed: <reason>" until a
// later deploy succeeds. No file (no deploy yet), or one that is unreadable or the wrong shape, posts nothing. The reason goes through plainLine: plain text,
// a path shown as <path>, a token-like run hidden, 160 characters at most. `read` is the job's file reader; the folder is the board config's own.
export const DEPLOY_LAST_FILE = "board-deploy-last.json";
export function deployLastWrite({ configPath, read }) {
  try {
    const v = JSON.parse(read(join(dirname(configPath), DEPLOY_LAST_FILE)));
    if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.ok !== "boolean" || !Number.isFinite(v.at)) return null;
    const line = plainLine(v.line);
    return { key: "deploy.last", value: { ok: v.ok, at: v.at, ...(line ? { line } : {}) } };
  } catch { return null; }
}

// #C1006: the app's session files, where each run's model is. A folder that cannot be read gives no sessions (appSessions says so by an empty list).
// Archived runs are read too: the newest run of a task is what the verdict needs, and the app archives a task's runs while it keeps running (Checker 2's F1).
export const scheduleSessions = (root) => appSessions(root, undefined, { includeArchived: true });
const defaultSessions = () => scheduleSessions(join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"));

export async function evidenceJob(o) {
  const t0 = Date.now(), timing = o.timing ?? {};
  try { return await evidenceJobRun({ ...o, timing }); } finally {
    const ms = Date.now() - t0;
    if (o.job === "evidence" && ms > SLOW_RUN_MS) o.log?.(`slow run: ${Math.round(ms / 1000)} s of ${JOBS.evidence.limitSec} s (state child ${timing.stateMs ?? "?"} ms, posts ${timing.postMs ?? "?"} ms)`);
  }
}

async function evidenceJobRun({ timing = {}, job, base, headers, configPath, stateFile, privateDir, prepare = prepareStoreState, fetchImpl = fetch, liveFetch = fetch, runner = runChild, env = childEnv(), build = (args, ms, extra) => defaultBuild(args, ms, runner, env, extra), deployRead = readDeploy, read = (p) => readFileSync(p, "utf8"), write = (p, t) => writeFileSync(p, t, { mode: 0o600 }), log = () => {}, ghCheck = defaultGhCheck, actions = {}, repoWords = {}, e2e = {}, sessionsRead = defaultSessions, switchFile = join(homedir(), ".flight-board", "stack-switch.json") }) {
  // One environment for both: the check asks whether gh runs in the very environment the state child gets.
  const t0 = Date.now();
  const ghOk = job === "evidence" ? ghCheck(env) : true;
  if (!ghOk) log(GH_MISSING);
  const finish = (r) => { if (!ghOk) throw new Error(GH_MISSING); return r; };
  const origConfig = configPath;
  let storeCardList = null;
  if (privateDir) ({ configPath, stateFile, cards: storeCardList } = await prepare({ privateDir, stateFile, configPath, base, headers, fetchImpl, log, switchFile }));
  // #C742: a card with no repo word whose Board-Id is in a configured repository gets that repository's name (never over a word already set).
  if (job === "evidence" && Array.isArray(storeCardList)) {
    let repos = [];
    try { repos = JSON.parse(read(origConfig))?.collector?.repos ?? []; } catch { log("repo words: the board config could not be read"); }
    await fillRepoWords({ cards: storeCardList, repos, base, headers, fetchImpl, log, ...repoWords });
  }
  // #C737: only the evidence job reads cards; it tells the state child what is deployed.
  const extra = job === "evidence" ? deployEnv(await deployRead({ base, headers, fetchImpl, log })) : {};
  const tState = Date.now();
  try {
    const built = await build(stateArgs(configPath), (JOBS[job].limitSec - 15) * 1000, extra);
    // #C996: where the child's time went, when it says (collector/state.mjs timingText).
    const t = timingOf(built?.stdout);
    if (t) log(`state child ${t}`);
  } catch (e) {
    // #C962: say why the child failed, in the log and (through main) on the page.
    const line = childLine(e);
    if (line) log(`state child said: ${line}`);
    const t = timingOf(e?.stdout);
    if (t) log(`state child ${t}`);
    throw Object.assign(e, { childLine: line });
  }
  timing.stateMs = Date.now() - tState;
  const state = JSON.parse(read(stateFile));
  const writes = evidenceWrites(state, job);
  // #C962: this run's own reading, so the page can show a slow run and clear an old failure. Not a heartbeat (the store ignores run.* for that).
  if (job === "evidence") writes.push({ key: "run.evidence", value: { ok: true, at: Date.now(), ms: Date.now() - t0, stateMs: timing.stateMs, ...(Date.now() - t0 > SLOW_RUN_MS ? { slow: true } : {}) } });
  // #C982: the board Worker deploy's last result, when there is one (the owner's deploy file wrote it beside the board config).
  if (job === "evidence") { const d = deployLastWrite({ configPath: origConfig, read }); if (d) writes.push(d); }
  log(`${writes.length} key(s) to write`);
  // #C927: the state child swallows a failed fetch (state.mjs repoAt: it reads what is in the clone and marks the run not fresh, and its own output is
  // dropped here), so the cards were read from an old copy and nothing said so. cardsCheckedAt is the last run every repository was read fresh.
  if (job === "evidence") { const ok = state?.board?.cardsCheckedAt; if (Number.isFinite(ok) && Number.isFinite(state.board.at) && state.board.at - ok > 2 * 60_000) log(`repository copy not fresh: a fetch failed, the cards were read from the clone as it was ${Math.round((state.board.at - ok) / 60_000)} min ago (retried next run)`); }
  const tPost = Date.now();
  // #C996: only what changed (dueWrites), kept beside the state; the posting stops cleanly before the job's limit (POST_TAIL_SEC short of the run's
  // start plus its limit, however late the child ended; the late writes stop at LATE_TAIL_SEC), and what went is recorded even when a post fails, so the keys left over lead the next run.
  const keptFile = join(dirname(stateFile), "evidence-posted.json");
  let kept = null;
  if (job === "evidence") { try { const k = JSON.parse(read(keptFile)); if (plain(k) && k.v === 1 && plain(k.keys)) kept = k.keys; } catch { /* the first run: everything is due */ } }
  const plan = job === "evidence" ? dueWrites(writes, kept, tPost) : { due: writes, carried: {}, hashes: new Map() };
  if (job === "evidence") log(`${plan.due.length} of ${writes.length} key(s) due (${writes.length - plan.due.length} unchanged)`);
  const saveKept = (keys) => { if (job !== "evidence") return; try { write(keptFile, JSON.stringify({ v: 1, keys: keptAfter(plan, keys, Date.now()) })); } catch { /* best effort: the next run posts them all */ } };
  let done;
  try { done = await postWrites(plan.due, { base, headers, fetchImpl, log, deadline: job === "evidence" ? t0 + (JOBS[job].limitSec - POST_TAIL_SEC) * 1000 : Infinity }); } catch (e) { saveKept(e.posted ?? []); throw e; }
  // A child that ended past the deadline still posts the heartbeat and the run's own reading (two posts, one round, up to LATE_TAIL_SEC short of the
  // limit): a slow run must never freeze the view, and its slow mark is the thing the page needs. The cards wait for the next run.
  if (job === "evidence" && done.stopped) {
    const wanted = plan.due.filter((w) => ESSENTIAL_KEYS.includes(w.key) && !done.ok.includes(w.key));
    if (wanted.length) {
      try { const e = await postWrites(wanted, { base, headers, fetchImpl, log, deadline: t0 + (JOBS[job].limitSec - LATE_TAIL_SEC) * 1000 }); done = { ...done, written: done.written + e.written, refused: done.refused + e.refused, ok: [...done.ok, ...e.ok] }; } catch (e) { saveKept([...done.ok, ...(e.posted ?? [])]); throw e; }
    }
  }
  saveKept(done.ok);
  if (done.stopped) log(`posts stopped at the deadline: ${done.written} of ${plan.due.length} written, the rest go first next run`);
  timing.postMs = Date.now() - tPost;
  // #C873: before the Actions step, which stops at the job's deadline; the script's own wait is capped at 30 s here.
  if (job === "usage") { let cfg2 = null; try { cfg2 = read(origConfig); } catch { log("e2e: the board config could not be read"); } if (cfg2) e2eStep(cfg2, { stateFile, env, log, ...e2e }); }
  if (job === "usage") await actionsUsageStep({ base, headers, fetchImpl, origConfig, stateFile, env, read, log, deadline: t0 + (JOBS.usage.limitSec - 15) * 1000, ...actions });
  if (job !== "evidence") return done;
  // Live last, so a product site that answers slowly (or not at all) can never hold up the evidence above.
  let cfg = null;
  try { cfg = read(origConfig); } catch { log("live: the board config could not be read"); }
  // Past LIVE_SKIP_SEC short of the limit the live read (up to 8 s) and the post after it cannot both fit: skipped this run, and logged.
  const tooLate = Date.now() > t0 + (JOBS[job].limitSec - LIVE_SKIP_SEC) * 1000;
  if (cfg && tooLate) log("live: skipped, the run is out of time");
  const live = cfg && !tooLate && await liveWrite(cfg, { fetchImpl: liveFetch, log });
  // #C873: the product's daily full test run (the usage job's kept answer), posted with live; a failure reading it is logged and the evidence above stands.
  let e2eW = null;
  try { e2eW = cfg && e2eWrite(cfg, { stateFile, log, ...e2e }); } catch (e) { log(`e2e failed: ${String(e.message).slice(0, 80)}`); }
  let lookW = null;
  try { lookW = cfg && lookWrite(cfg, { log }); } catch (e) { log(`look failed: ${String(e.message).slice(0, 80)}`); }
  // #C1006: each scheduled task's chosen model (board config) against the model its last run used (the app's session files). A failure is logged and
  // the store keeps its last reading, which the page shows as old after 36 h.
  let schedW = null;
  try { schedW = cfg && scheduleModelsWrite(cfg, { sessions: sessionsRead(), now: Date.now(), log }); } catch (e) { log(`schedule failed: ${String(e.message).slice(0, 80)}`); }
  const late = [lookW, schedW, live, e2eW].filter(Boolean); // look first: live stays the last write of the evidence job (e2e, when configured, follows it)
  if (late.length) { const l = await postWrites(late, { base, headers, fetchImpl, log, deadline: t0 + (JOBS[job].limitSec - LATE_TAIL_SEC) * 1000 }); return finish({ written: done.written + l.written, refused: done.refused + l.refused }); }
  return finish(done);
}

// #C962: a failed run tells the store why (the state child's last stderr line, else the error's message), so the page's Probe chip says it.
// Best effort and bounded: it never keeps the run alive, and a store that is the reason the run failed simply does not hear it.
export async function reportRunFailure(e, { base, headers, fetchImpl = fetch, waitMs = 5000 }) {
  const line = plainLine(e?.childLine || e?.message || "");
  try { await Promise.race([post(fetchImpl, base, headers, { key: "run.evidence", value: { ok: false, at: Date.now(), line } }), new Promise((r) => setTimeout(r, waitMs).unref())]); } catch { /* the store may be the reason */ }
}

// node probe-evidence.mjs --job evidence|usage --env <file> --config <board config> --state <state.json> [--base <url>] [--private-dir <dir>]
export async function main(argv, { exit = (c) => process.exit(c) } = {}) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const job = get("--job");
  if (!["evidence", "usage"].includes(job)) { console.error(`unknown job ${job}`); return exit(64); }
  const cfg = loadEnv(get("--env"));
  const base = get("--base") ?? cfg.BOARD_BASE_URL;
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(base ?? "")) { console.error("no board address: pass --base or set BOARD_BASE_URL"); return exit(64); }
  if (!get("--config") || !get("--state")) { console.error("pass --config and --state"); return exit(64); }
  const run = startRun(job);
  try {
    await run.step(`${job} readings`, () => evidenceJob({ job, base, headers: accessHeaders(cfg), configPath: get("--config"), stateFile: get("--state"), privateDir: get("--private-dir"), log: run.log }));
    return exit(run.finish(0));
  } catch (e) {
    run.log(`failed: ${String(e.message).slice(0, 200)}`);
    // #C962: tell the store why, best effort and bounded, so the page says why the probe is failing (never keeps the run alive).
    if (job === "evidence") await reportRunFailure(e, { base, headers: accessHeaders(cfg) });
    return exit(run.finish(1));
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
