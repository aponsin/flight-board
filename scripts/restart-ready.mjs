// Part A of #C861 (the owner's wish: no manual restart steps; design in the owner's shared folder, c861-restart-design.md; Manager: build part A only).
// A READ-ONLY check that says whether the app could be restarted right now, every item of the contract's "Safe to restart" row named, and what it would do:
//   node <pinned copy>/scripts/restart-ready.mjs --config <board.config.json> --dry-run [--force-at HH:MM]
// It has no way to quit, close, signal or open anything: no restart action exists in this file (a test holds that), and it refuses to run without
// --dry-run. Part B, the action, needs the owner's go. It never writes and never calls the network. restart-check.mjs (what every pack's restart step runs)
// is untouched.
// The checks, in the order the first failing one is named:
//   ship       no ship run alive, and the ship role not working on a card in the ship phase (restart-check.mjs's own rule)
//   install    no pack install running (a board-store deploy, tree or hooks file, board-deploy.mjs or an install script)
//   agents     no team agent but the lead working or touched in the last 2 minutes (the lead is the one asking)
//   outside    no session outside the team active in the last 5 minutes
//   scheduled  no scheduled task running
//   github     no GitHub run (CI or ship) in progress
//   lock       no ship lock held
//   remote     Remote Control on, so the owner can still reach the app after it restarts
// A check this script cannot read on this machine (the app's session list, its scheduled tasks and Remote Control, GitHub, the ship lock) is UNKNOWN, and an
// unknown check is never ok: the line says it cannot read it. --force-at HH:MM (today, local time): from then on a check that waited only for people
// (agents, outside, scheduled) no longer holds the restart; a ship, an install, a GitHub run, the lock, Remote Control off or any unknown check still does,
// so a force never cuts a ship. Drain-then-go (agents told to finish and pause) is part B's.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "./config.mjs";
import { liveStateFile } from "./live-state.mjs";
import { shipRuns, liveShip, verdict as shipVerdict, LIVE_FRESH } from "./restart-check.mjs";

export const AGENT_QUIET_MS = 2 * 60e3, OUTSIDE_QUIET_MS = 5 * 60e3;
export const CHECKS = ["ship", "install", "agents", "outside", "scheduled", "github", "lock", "remote"];
export const FORCEABLE = ["agents", "outside", "scheduled"]; // only these wait for people; the rest never yield to a force
const home = (p) => String(p).replace(/^~(?=\/|$)/, homedir());
const hhmm = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const ok = (note) => ({ status: "ok", note });
const wait = (note) => ({ status: "wait", note });
const unknown = (what) => ({ status: "unknown", note: `can't read ${what} on this machine` });
// Plain words only reach the line: a role or card from board data is shown only when it is plainly one.
const plain = (s) => (/^[A-Za-z0-9 _.#-]{1,60}$/.test(String(s)) ? String(s) : "?");

// A pack install running, from `ps -Ao pid=,etime=,command=`: the owner's deploy, tree and hooks files, board-deploy.mjs, or a board-v<n>-install.sh.
export const INSTALL_COMMAND = /(?:^|[\s/])(?:board-store-(?:deploy|tree|hooks)-pc\d+\.mjs|board-deploy\.mjs|board-v\d+(?:\.\d+)*-install\.sh)(?:\s|$)/;
export function installRuns(psOut) {
  return String(psOut).split("\n").filter((l) => { const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l); return m && INSTALL_COMMAND.test(m[3]) && /\b(?:node|sh|bash|zsh)\b/.test(m[3]); }).length;
}

// The verdict, from readings only. readings: { ship: { runs, live } | null, install: <count> | null, agents: <state.json agents> | null (null: no fresh live state),
// outside: <count of sessions outside the team active in 5 min> | null, scheduled: <count running> | null, github: <count in progress> | null,
// lock: <true if held> | null, remote: <true|false> | null }. now in ms; lead: the role that is asking; forceAt: ms or null.
// Returns { ok (would restart now), forced, checks: [{ name, status, note }], first (the first check that is not ok, or null), line }.
export function readyVerdict({ readings = {}, now, lead = "Manager", forceAt = null }) {
  const r = readings, checks = [];
  const push = (name, c) => checks.push({ name, ...c });
  if (!r.ship) push("ship", unknown("the ship run or the live state"));
  // live undefined: there is no fresh live state, so only a ship run found in the process list can be seen. No run seen then is not "no ship" (F2 of #C861).
  else if (r.ship.live === undefined && !(r.ship.runs ?? []).length) push("ship", unknown("a fresh live state, so a ship in the ship phase can't be ruled out"));
  else { const v = shipVerdict({ runs: r.ship.runs ?? [], live: r.ship.live ?? null, version: null, now }); push("ship", v.ok ? ok("no ship running") : wait(v.line.replace(/^wait: /, "").replace(/: restart once.*$/, ""))); }
  push("install", Number.isInteger(r.install) ? (r.install === 0 ? ok("no pack install running") : wait(`${r.install} pack install${r.install > 1 ? "s" : ""} running`)) : unknown("the processes"));
  if (!r.agents || typeof r.agents !== "object") push("agents", unknown("a fresh live state of the agents"));
  else {
    const busy = Object.entries(r.agents).filter(([role, a]) => role !== lead && a && typeof a === "object"
      && (a.state === "working" || (Number.isFinite(a.lastActivityAt) && now - a.lastActivityAt < AGENT_QUIET_MS))).map(([role]) => plain(role)).sort();
    push("agents", busy.length ? wait(`${busy.join(", ")} active in the last 2 min`) : ok("no agent active in 2 min"));
  }
  const count = (name, v, quiet, what, bad) => push(name, Number.isInteger(v) && v >= 0 ? (v === 0 ? ok(quiet) : wait(bad(v))) : unknown(what));
  count("outside", r.outside, "no session outside the team active in 5 min", "the app's sessions", (n) => `${n} session${n > 1 ? "s" : ""} outside the team active in 5 min`);
  count("scheduled", r.scheduled, "no scheduled task running", "the app's scheduled tasks", (n) => `${n} scheduled task${n > 1 ? "s" : ""} running`);
  count("github", r.github, "no GitHub run in progress", "GitHub's runs (no network call here)", (n) => `${n} GitHub run${n > 1 ? "s" : ""} in progress`);
  push("lock", r.lock === false ? ok("no ship lock held") : r.lock === true ? wait("a ship lock is held") : unknown("the ship lock"));
  push("remote", r.remote === true ? ok("Remote Control is on") : r.remote === false ? wait("Remote Control is off: the owner could not reach the app after a restart") : unknown("Remote Control's state"));
  const forced = Number.isFinite(forceAt) && now >= forceAt;
  const holds = (c) => c.status !== "ok" && !(forced && FORCEABLE.includes(c.name) && c.status === "wait");
  const first = checks.find((c) => c.status !== "ok") ?? null, hold = checks.find(holds) ?? null;
  const good = !hold, usedForce = good && forced && checks.some((c) => c.status !== "ok");
  const line = good
    ? `${usedForce ? `would restart now: the force time ${hhmm(forceAt)} has passed, and only people were holding it (${checks.filter((c) => c.status !== "ok").map((c) => c.name).join(", ")})` : "would restart now: every check is ok"}`
    : `would wait: ${hold.name}: ${hold.note}${Number.isFinite(forceAt) ? (forced ? " (a force never yields to this)" : ` (force at ${hhmm(forceAt)})`) : ""}`;
  return { ok: good, forced: usedForce, checks, first, line };
}

// --force-at HH:MM today, local time -> ms, or null when absent or not a clock time (the CLI refuses a bad one).
export function parseForceAt(text, now) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text ?? ""));
  if (!m) return null;
  const d = new Date(now); d.setHours(+m[1], +m[2], 0, 0);
  return d.getTime();
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2), val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const known = new Set(["--config", "--dry-run", "--force-at"]);
  if (!args.includes("--dry-run") || args.some((a, n) => a.startsWith("--") && !known.has(a)) || args.some((a, n) => !a.startsWith("--") && !["--config", "--force-at"].includes(args[n - 1]))) {
    console.error("Usage: node scripts/restart-ready.mjs --config <board.config.json> --dry-run [--force-at HH:MM]\nThis build only checks: it has no way to restart or quit anything."); process.exit(2);
  }
  const now = Date.now(), forceText = val("--force-at"), forceAt = forceText === undefined ? null : parseForceAt(forceText, now);
  if (forceText !== undefined && forceAt === null) { console.error("--force-at takes a clock time today, HH:MM (24 hours)."); process.exit(2); }
  if (forceAt !== null && forceAt < now) { console.error("--force-at is a time that has already passed today, which would force the restart at once: give a later time."); process.exit(2); }
  let config, rawConfig;
  try { const raw = JSON.parse(readFileSync(val("--config"), "utf8")); if (checkConfig(raw).length) throw new Error(); config = fullConfig(raw); rawConfig = raw; }
  catch { console.log("would wait: can't read the board's config, so can't tell what is running."); process.exit(3); }
  let ps = null;
  try { ps = execFileSync("ps", ["-Ao", "pid=,etime=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }); } catch { /* unknown below */ }
  let state = null;
  try { state = JSON.parse(readFileSync(liveStateFile(config, rawConfig), "utf8")); } catch { /* unknown below */ }
  const fresh = state?.board && Number.isFinite(state.board.at) && now - state.board.at <= LIVE_FRESH && now - state.board.at >= -60e3;
  const readings = {
    ship: ps === null ? null : { runs: shipRuns(ps, now).filter((r) => r.pid !== process.pid), live: fresh ? liveShip(state, { now, shipPhase: config.collector.shipPhase }) : undefined },
    install: ps === null ? null : installRuns(ps),
    agents: fresh ? state.agents ?? {} : null,
    // Not readable from a script on this machine: the app's sessions, scheduled tasks and Remote Control, GitHub (no network here), the ship lock.
    outside: null, scheduled: null, github: null, lock: null, remote: null,
  };
  const v = readyVerdict({ readings, now, lead: config.gate.managerRole, forceAt });
  for (const c of v.checks) console.log(`${c.status === "ok" ? "ok  " : c.status === "wait" ? "wait" : "????"} ${c.name}: ${c.note}`);
  console.log(`Dry run: ${v.line}. Nothing was changed.`);
  process.exit(v.ok ? 0 : 3);
}
