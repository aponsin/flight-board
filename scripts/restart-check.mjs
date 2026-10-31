// Is it safe to restart the agents now? (#C505: both of 2026-10-30's install restarts stopped Release mid-ship, and only
// the owner could clean up, with git reset --hard.) Every pack's restart step runs this first:
//   node <pinned copy>/scripts/restart-check.mjs --config <board.config.json>
// It prints one line and exits 0 for "ok", 3 for "wait". It reads, on this machine only:
//   - the ship run itself: a process running the team's ship command (SHIP_COMMAND; a --dry-run doesn't count). It runs
//     from the merges through CI and the deploy, so while it lives a restart cuts a ship;
//   - the live state (<stateDir>/<board>/state.json, collector/state.mjs, each minute), while under LIVE_FRESH old: the
//     ship role working on a card in the ship phase;
//   - the version, for the line only: the newest candidate branch (collector.candidatePattern) the team's checkouts know
//     of, made since the run started. Old candidates stay on GitHub after a red run, so a branch alone is never a ship.
// Never a network call, never a write.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "./config.mjs";

export const SHIP_ROLE = "Release";
export const SHIP_COMMAND = /(?:^|[\s/])ship\.mjs(?:\s|$)/;
export const LIVE_FRESH = 3 * 60e3;
const home = (p) => String(p).replace(/^~(?=\/|$)/, homedir());

// ps's elapsed time, [[dd-]hh:]mm:ss, in ms; null when it doesn't read as one.
export function elapsedMs(t) {
  const m = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(String(t).trim());
  return m ? ((+(m[1] ?? 0) * 24 + +(m[2] ?? 0)) * 60 + +m[3]) * 60e3 + +m[4] * 1e3 : null;
}
// The ship runs alive, from `ps -Ao pid=,etime=,command=`: [{ pid, startedAt }].
export function shipRuns(psOut, now) {
  const out = [];
  for (const line of String(psOut).split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || !SHIP_COMMAND.test(m[3]) || /\s--dry-run(?:\s|$)/.test(m[3]) || !/\bnode\b/.test(m[3])) continue;
    const e = elapsedMs(m[2]);
    out.push({ pid: +m[1], startedAt: e == null ? null : now - e });
  }
  return out;
}
// The version of the run started at `startedAt`: the newest candidate made since, by its name ("v1.2.3"); else null.
export function runVersion(candidates, startedAt, re) {
  const v = candidates.filter((c) => re.test(c.branch) && (startedAt == null || c.at >= startedAt - 60e3)).sort((a, b) => b.at - a.at)[0];
  const m = v && /v(\d+\.\d+\.\d+)/.exec(v.branch);
  return m ? m[1] : null;
}
// The ship role's card in the ship phase, by a fresh live state: its id and number, or null.
export function liveShip(state, { now, shipPhase, shipRole = SHIP_ROLE }) {
  if (!state || !state.board || !Number.isFinite(state.board.at) || now - state.board.at > LIVE_FRESH || now - state.board.at < -60e3) return null;
  const a = state.agents && state.agents[shipRole];
  if (!a || a.state !== "working" || typeof a.card !== "string") return null;
  const c = state.cards && state.cards[a.card];
  return c && c.phase === shipPhase ? { card: a.card, num: Number.isInteger(c.num) ? c.num : null, since: Number.isFinite(a.since) ? a.since : null } : null;
}
const hhmm = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
// The verdict: { ok, line }.
export function verdict({ runs, live, version, now, shipRole = SHIP_ROLE }) {
  // A card id from state.json reaches the owner's terminal only when it is plainly one (Security: an escape sequence in
  // board data could spoof the line).
  const card = live ? (live.num ? `#C${live.num}` : /^[A-Za-z0-9_.-]{1,80}$/.test(String(live.card)) ? live.card : "a ship card") : null;
  if (runs.length) {
    const at = runs.map((r) => r.startedAt).filter(Number.isFinite).sort((a, b) => a - b)[0];
    const bits = [at != null ? `since ${hhmm(at)}` : null, card].filter(Boolean).join(", ");
    return { ok: false, line: `wait: ${shipRole} is shipping${version ? ` v${version}` : ""}${bits ? ` (${bits})` : ""}: restart once it ends.` };
  }
  if (live) return { ok: false, line: `wait: ${shipRole} is working on ${card}, which is ready to ship${live.since ? ` (since ${hhmm(live.since)})` : ""}: restart once ${shipRole} is idle.` };
  return { ok: true, line: "ok: no ship running; restart now." };
}

function candidatesIn(repos, re) {
  const out = [];
  for (const repo of repos) {
    try {
      const refs = execFileSync("git", ["for-each-ref", "refs/heads", "refs/remotes/origin", "--format=%(refname) %(committerdate:unix)"], { cwd: home(repo), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
      for (const l of refs.split("\n")) {
        const [ref, t] = l.split(" ");
        const branch = String(ref).replace(/^refs\/(?:heads|remotes\/origin)\//, "");
        if (ref && re.test(branch) && /^\d+$/.test(t)) out.push({ branch, at: +t * 1000 });
      }
    } catch { /* not a checkout: no candidates from it */ }
  }
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const at = process.argv.indexOf("--config");
  let config;
  try {
    const raw = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
    if (at < 0 || checkConfig(raw).length) throw new Error();
    config = fullConfig(raw);
  } catch { console.log("wait: can't read the board's config, so can't tell whether a ship is running: ask Release."); process.exit(3); }
  const now = Date.now(), c = config.collector;
  let ps = "";
  try { ps = execFileSync("ps", ["-Ao", "pid=,etime=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }); }
  catch { console.log("wait: can't list this machine's processes, so can't tell whether a ship is running: ask Release."); process.exit(3); }
  let state = null;
  try { state = JSON.parse(readFileSync(join(home(config.gate.stateDir), boardId(config), "state.json"), "utf8")); } catch { /* none: the process alone decides */ }
  const runs = shipRuns(ps, now).filter((r) => r.pid !== process.pid);
  const re = c.candidatePattern ? new RegExp(c.candidatePattern) : null;
  const version = runs.length && re ? runVersion(candidatesIn(c.refresh?.repos ?? [], re), runs[0].startedAt, re) : null;
  const v = verdict({ runs, live: liveShip(state, { now, shipPhase: c.shipPhase }), version, now });
  console.log(v.line);
  process.exit(v.ok ? 0 : 3);
}
