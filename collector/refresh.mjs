// The collector on demand, a Stop hook for the lead only: node collector/refresh.mjs --config <board.config.json>
// Besides its hourly run, the collector should run within minutes of anything that moves a card. When the lead's turn
// ends and something happened since the collector's last run, the hook holds the turn once (exit 2) with "start the
// collector now", so the lead's next step is run_scheduled_task, never the lead remembering. The triggers:
// - a ship: a repository's origin/main (local refs: every ship is a push from this machine) moved since the last run;
// - the owner marked an item done ("Board reply [<id>]: marked done");
// - the owner asked for a refresh (the word "refresh" in what the owner typed, a thread message or a reply's note).
// Never while a run is in flight, within debounceMin of the last run's start or of the hook's last ask (a run asked for
// starts a minute or so later), or twice in a row (stop_hook_active). It only ever names run_scheduled_task <taskId>.
// The last run is the time collect.mjs --prepare notes in <stateDir>/<board>/export-since.json, with the refresh repos'
// origin/main at that moment (the ship baseline, so a ship during a long lead turn is still seen); it has finished when
// <outDir>/derived-all.json is newer.

import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync, realpathSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { readLines, sessionRole } from "../gate/session.mjs";
const MID = "The user sent a new message while you were working:";
const NOT_TYPED = ["<", "Another Claude session sent", "Stop hook feedback", "Base directory for this skill"];
const REFRESH = /\brefresh\b/i;

// The text blocks of one transcript entry a person or a session sent (tool results are not).
function texts(l) {
  const c = l?.message?.content;
  if (typeof c === "string") return [c];
  return Array.isArray(c) ? c.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text) : [];
}

// The owner's words in one message: a board comment's quoted lines, or what was typed (a mid-turn message's part).
// Returns { done: [ids], refresh: bool }.
export function ownerSaid(text) {
  const out = { done: [], refresh: false };
  let t = String(text ?? "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  if (/=== BEGIN ARTIFACT COMMENT/.test(t) || t.trimStart().startsWith("[Artifact comment sent to Claude]")) {
    for (const line of t.split("\n")) {
      let m = /^>\s*Board reply \[([^\]\s]{1,80})\]: (.*)$/.exec(line);
      if (m) {
        if (/^marked done\b/.test(m[2])) out.done.push(m[1]);
        // A reply quotes the item's own text: only the owner's note counts.
        const note = m[2].includes(" Note: ") ? m[2].split(" Note: ").slice(1).join(" Note: ") : "";
        if (REFRESH.test(note)) out.refresh = true;
        continue;
      }
      m = /^>\s*Board thread \[[^\]\s]{1,80}\]: Owner: (.*)$/.exec(line);
      if (m && REFRESH.test(m[1])) out.refresh = true;
    }
    return out;
  }
  if (t.includes(MID)) t = t.split(MID, 2)[1].split("This is how Claude Code surfaces", 1)[0];
  else if (NOT_TYPED.some((p) => t.trimStart().startsWith(p))) return out;
  out.refresh = REFRESH.test(t);
  return out;
}

// What the owner did, with when: [{ at (ms), kind: "done" | "refresh", id? }], from the transcript's lines.
export function ownerEvents(lines) {
  const out = [];
  for (const l of lines) {
    if (l?.type !== "user" || l.isMeta) continue;
    const at = Date.parse(l.timestamp ?? "");
    if (!Number.isFinite(at)) continue;
    for (const t of texts(l)) {
      const s = ownerSaid(t);
      for (const id of s.done) out.push({ at, kind: "done", id });
      if (s.refresh) out.push({ at, kind: "refresh" });
    }
  }
  return out;
}

// The reason to start the collector now, or null. Pure: everything comes in.
// run: { startedAt, finishedAt } (ms or null); refs: { repo: sha } now; baseline: { repo: sha } as of the last run.
export function decide({ lead, stopActive, now, run = {}, refs = {}, baseline = {}, events = [], askedAt = null, debounceMin = 10, flightMin = 15 }) {
  if (!lead || stopActive) return null;
  if (Number.isFinite(askedAt) && now - askedAt < debounceMin * 60e3) return null;
  const started = Number.isFinite(run.startedAt) ? run.startedAt : null;
  const finished = Number.isFinite(run.finishedAt) ? run.finishedAt : null;
  if (started != null && (finished == null || finished < started) && now - started < flightMin * 60e3) return null;
  if (started != null && now - started < debounceMin * 60e3) return null;
  const since = started ?? -Infinity;
  const why = [];
  for (const [repo, sha] of Object.entries(refs)) if (sha && baseline[repo] && sha !== baseline[repo]) why.push(`${repo} shipped`);
  const done = [...new Set(events.filter((e) => e.kind === "done" && e.at > since).map((e) => e.id))];
  if (done.length) why.push(`marked done: ${done.join(", ")}`);
  if (events.some((e) => e.kind === "refresh" && e.at > since)) why.push("the owner asked for a refresh");
  return why.length ? why.join("; ") : null;
}

// What --prepare notes at a run's start: its time and each refresh repo's origin/main then. git(path) gives a sha or null.
export function runMark(at, repos, git) {
  const refs = {};
  for (const repo of repos) { const sha = git(home(repo)); if (sha) refs[basename(home(repo))] = sha; }
  return { at, refs };
}

// The refs to compare against: the ones --prepare noted at the run's start (markRefs) when it did; else (a run before
// this code) the ones kept for this run, or, when a newer run has started, today's.
// state: { runAt, refs } as saved; returns { baseline, save } (save: the state to write, or null when unchanged).
export function baselineFor(state, startedAt, refs, markRefs = null) {
  if (markRefs && typeof markRefs === "object" && !Array.isArray(markRefs)) return { baseline: markRefs, save: state?.runAt === startedAt ? null : { runAt: startedAt ?? null, refs: markRefs } };
  if (state && state.runAt === startedAt && state.refs && typeof state.refs === "object") return { baseline: state.refs, save: null };
  return { baseline: refs, save: { runAt: startedAt ?? null, refs } };
}

// The hook. Advisory: anything that goes wrong lets the turn end (exit 0); only a reason holds it (exit 2).
export function main(input, { config, env = process.env, now = Date.now(), git, read = readFileSync, write = writeJson, mtime = mtimeOf } = {}) {
  const lines = input?.transcript_path ? readLines(input.transcript_path) : [];
  const { role } = sessionRole(lines, env.FLIGHT_BOARD_ROLE);
  const lead = role === config.gate.managerRole;
  if (!lead || input?.stop_hook_active) return null;
  const r = config.collector.refresh;
  const dir = join(home(config.gate.stateDir), boardId(config) ?? "no-board");
  let startedAt = null, markRefs = null, state = null;
  try { const m = JSON.parse(read(join(dir, "export-since.json"), "utf8")); startedAt = m.at; markRefs = m.refs ?? null; } catch { /* never ran */ }
  try { state = JSON.parse(read(join(dir, "refresh.json"), "utf8")); } catch { /* first time */ }
  const finishedAt = config.collector.outDir ? mtime(join(home(config.collector.outDir), "derived-all.json")) : null;
  const { refs } = runMark(null, r.repos, git);
  const { baseline, save } = baselineFor(state, Number.isFinite(startedAt) ? startedAt : null, refs, markRefs);
  const askedAt = save ? null : state?.askedAt ?? null;
  const why = decide({ lead: true, stopActive: false, now, run: { startedAt, finishedAt }, refs, baseline, events: ownerEvents(lines), askedAt, debounceMin: r.debounceMin, flightMin: r.flightMin });
  const next = { ...(save ?? state), ...(why ? { askedAt: now } : askedAt != null ? { askedAt } : {}) };
  if (save || why) write(join(dir, "refresh.json"), next);
  return why ? `Start the collector now: call mcp__scheduled-tasks__run_scheduled_task with taskId ${r.taskId}, once (${why}). Then finish.` : null;
}

const home = (p) => String(p).replace(/^~(?=\/|$)/, homedir());
function writeJson(path, data) { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(data)); renameSync(tmp, path); }
function mtimeOf(path) { try { return statSync(path).mtimeMs; } catch { return null; } }
// origin/main as this checkout last saw it (a push or a fetch updates it): never a network call.
export function localMain(repo) {
  try { const sha = execFileSync("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim(); return /^[0-9a-f]{40}$/.test(sha) ? sha : null; } catch { return null; }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let reason = null;
  try {
    const at = process.argv.indexOf("--config");
    const raw = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
    if (at < 0 || checkConfig(raw).length) process.exit(0);
    reason = main(JSON.parse(readFileSync(0, "utf8")), { config: fullConfig(raw), git: localMain });
  } catch { process.exit(0); }
  if (reason) { process.stderr.write(reason + "\n"); process.exit(2); }
  process.exit(0);
}
