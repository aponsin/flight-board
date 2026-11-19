// The lead's wake watch (#C580): node scripts/wake-watch.mjs --config <board.config.json>, run by the lead's Monitor
// (timeout_ms 1800000). Each line it prints is one event, which starts a lead turn: "WAKE #<n>: the owner wrote on the
// board; read it now". It prints one line per new wake (gate/wake.mjs: the probe's wake.json against what this watch
// last printed, wake-seen.json), nothing else, and stops by itself before the Monitor's 30 minutes are up. Its
// heartbeat (wake-watch.alive.json) is what the lead's Stop hook looks at to ask for a re-arm. Nothing here reads the board
// or the transcript: counters and times only.
import { readFileSync, realpathSync, unlinkSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId, home, pinnedCommit } from "./config.mjs";
import { wakePaths, readWakeFile, writeAtomic, wakePending, wakeLine, POLL_MS, ALIVE_MAX_MS, MAX_RUN_MS } from "../gate/wake.mjs";
import { RESET_FILE, RESET_SEEN_FILE, WAKE_ROLES_FILE, WAKE_ROLES_SEEN_FILE, resetPending, resetSeen, resetLine, wakeLine as roleWakeLine, missingLine, ASKS_FILE, ASKS_SEEN_FILE, asksPending, asksSeen, askLine, TRUTH_FILE, TRUTH_SEEN_FILE, SHIP_ROLE, truthPending, truthSeen, truthLine, NOEVIDENCE_FILE, NOEVIDENCE_SEEN_FILE, noEvidencePending, noEvidenceLine, DISPATCH_FILE, DISPATCH_LATE_SEEN_FILE, dispatchSeenFile, dispatchWokenFile, dispatchPidFile, dispatchPending, dispatchSeen, dispatchLine, dispatchLateLine, dispatchWatchAlive, LINES_FILE, LINES_SEEN_FILE, linesPending, linesSeen, linesSeenFile, routeOf } from "../gate/reset.mjs";

// One look: the heartbeat, then the line to print, or null. Marks the wake seen only once it is returned.
export function tick(dir, now, pid = process.pid, roster = null, lead = null) {
  const p = wakePaths(dir);
  writeAtomic(p.alive, JSON.stringify({ at: now, pid }));
  const lines = resetLines(dir, roster, now, lead);
  const wake = readWakeFile(p.wake), seen = readWakeFile(p.seen);
  if (wakePending(wake, seen)) {
    writeAtomic(p.seen, JSON.stringify({ seq: wake.seq, at: wake.at }));
    lines.unshift(wakeLine(wake));
  }
  return lines.length ? lines.join("\n") : null;
}

// One look of an owner's watch (#C631): the pid file's beat, then the DISPATCH line for the role's newest unprinted level-1 item,
// or null. Marks it printed only once it is returned. The role must be on the roster and not the lead (the caller checks).
export function roleTick(dir, role, now, pid = process.pid) {
  writeAtomic(join(dir, dispatchPidFile(role)), JSON.stringify({ pid, at: now }));
  const read = (name) => { try { return JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { return null; } };
  const seen = read(dispatchSeenFile(role)), due = dispatchPending(read(DISPATCH_FILE), seen, { role, level: 1 });
  // #C678: the nudges and conflicts the probe marked for this role (its own seen file, one batch once).
  const batch = read(LINES_FILE), lseen = read(linesSeenFile(role)), mine = linesPending(batch, lseen, { role, now });
  if (Number.isInteger(batch?.at) && batch.at !== lseen?.at) writeAtomic(join(dir, linesSeenFile(role)), JSON.stringify(linesSeen(batch, lseen, mine, now)));
  if (!due.length && !mine.length) return null;
  if (due.length) {
    writeAtomic(join(dir, dispatchSeenFile(role)), JSON.stringify(dispatchSeen(seen, due)));
    writeAtomic(join(dir, dispatchWokenFile(role)), JSON.stringify({ at: now, cards: due.map((i) => i.card).slice(0, 8) }));
  }
  return [...due.map(dispatchLine), ...mine].join("\n");
}

// #C1158 (11-17: a start push woke the reviewers although #C1139 stops that, because their --once watches had been started from older installs, which have no such rule, and a
// --once watch keeps the code it started with until it fires): a watch knows the install it runs from and the install the Stop hook pins (settings.json), and when they differ it
// prints one line and ends, so its role re-arms on the pinned install. Only an install folder counts (a watch run from a checkout, or a settings file with no single pin, is left alone),
// and a pair is told once per role: a role that re-arms from the same stale path keeps running, so this can never be a wake loop.
const INSTALL_SHA = /\/\.flight-board\/install\/([0-9a-f]{40})(?:\/|$)/;
export const installShaOf = (path) => INSTALL_SHA.exec(String(path ?? "").replaceAll("\\", "/"))?.[1] ?? null;
// The install the Stop hook pins: the one sha the settings' gate hooks run from; none, or more than one, is no pin (#C1166: scripts/config.mjs's one reader, the release job's and the pickup pass's too).
export const pinnedInstallOf = pinnedCommit;
export const staleLine = (own, pin) => `wake-watch: stale pin: this watch runs from install ${own.slice(0, 12)} but the Stop hook pins ${pin.slice(0, 12)}; it ends now so you re-arm on the pinned install (the path your Stop hook prints)`;
const staleFile = (role) => `stale-pin-${String(role).replace(/[^A-Za-z0-9]+/g, "-")}.json`;
// The line to print, or null. Marks the pair told only when it is returned.
export function staleCheck(dir, role, own, settingsText, now = Date.now()) {
  const pin = pinnedInstallOf(settingsText);
  if (!own || !pin || own === pin) return null;
  let seen = null; try { seen = JSON.parse(readFileSync(join(dir, staleFile(role)), "utf8")); } catch { /* none */ }
  if (seen?.own === own && seen?.pin === pin) return null;
  writeAtomic(join(dir, staleFile(role)), JSON.stringify({ own, pin, at: now }));
  return staleLine(own, pin);
}
// #C1165 (Manager's audit 11-17: after a restart, roles whose Stop hook had printed no path re-armed from memory, on old installs or on `current`): `wake-watch.mjs --pinned ...` arms the watch
// from the install the Stop hook pins in the settings, whichever copy of this file the command named. This decides it, pure: { file } is the pinned install's wake-watch.mjs and { here } says
// whether that is this very file (then it just runs); { why } is no pin, or a pinned install with no such file. It never names `current`, a checkout or any other folder: only
// <install root>/<the one sha the settings pin>/scripts/wake-watch.mjs. `real` and `exists` are injectable for the tests.
export function pinnedLaunch({ settingsText, installRoot, self, exists = existsSync, real = realpathSync }) {
  const pin = pinnedInstallOf(settingsText);
  if (!pin) return { why: "the Stop hook names no single install in the settings" };
  const file = join(installRoot, pin, "scripts", "wake-watch.mjs");
  if (!exists(file)) return { why: `the pinned install ${pin.slice(0, 12)} has no scripts/wake-watch.mjs` };
  let here = false; try { here = real(file) === real(self); } catch { here = false; }
  return { file, pin, here };
}
// #C1240 (11-18: after each of six installs every role's watch ended "stale pin" and had to be re-armed by hand; Triage, Demos and Sales re-armed several times and asked whether something looped,
// Triage stopped re-arming): a watch armed with --pinned runs as a child of a small launcher that stays up. When the pin moves, the child (told so by FOLLOW_ENV) ends with STALE_EXIT and prints
// nothing; the launcher reads the settings again and starts the new pin's copy, so the role is never woken for a pin change and never sits unwatched. The launcher only ever starts
// <install root>/<the one sha the settings pin>/scripts/wake-watch.mjs (pinnedLaunch), as before. A watch armed on a path, with no --pinned, keeps the old behaviour: the stale line, then it ends.
export const STALE_EXIT = 75, FOLLOW_ENV = "WAKE_WATCH_FOLLOW", FOLLOW_MAX = 3, FOLLOW_WINDOW_MS = 60e3;
// What the launcher does when its child has ended: { again: true, recent } to start the pin's copy again, or { again: false, code, why? } to end with that code. A child that ended any other way
// (it printed a DISPATCH line and exited 0, or failed) ends the launcher the same way; more than FOLLOW_MAX pin changes inside FOLLOW_WINDOW_MS is a loop, not a re-install, and ends it with a line.
export function followStep({ code, signal, error }, recent, now) {
  if (error) return { again: false, code: 1 };
  if (code !== STALE_EXIT) return { again: false, code: code ?? (signal ? 1 : 0) };
  const kept = [...recent.filter((t) => now - t < FOLLOW_WINDOW_MS && t <= now), now];
  if (kept.length > FOLLOW_MAX) return { again: false, code: 1, why: `the pin changed ${kept.length} times in ${FOLLOW_WINDOW_MS / 1000} s; the watch ends, arm it again by hand` };
  return { again: true, recent: kept };
}
// Every DISPATCH line says which install decided it (a reader can see a watch on old code).
export const withInstall = (text, own) => (own ? String(text).split("\n").map((l) => (l.startsWith("DISPATCH ") ? `${l} [watch install ${own.slice(0, 12)}]` : l)).join("\n") : String(text));

// #C1159 (Checker 2's two LOWs on #C1158): one look of an owner's watch, the line to print or null. The stale-pin check goes FIRST: a watch on an old install must not run its old
// dispatch code (roleTick would decide a card with it, mark it printed and beat the pid file), so it ends with the stale line and leaves the dispatch for the re-armed watch. Every
// DISPATCH line it does print says which install decided it (the tag is added here, at the print site).
export function watchLook(dir, role, own, settingsText, now, pid = process.pid) {
  const stale = staleCheck(dir, role, own, settingsText, now);
  if (stale) return { line: stale, stale: true };
  const line = roleTick(dir, role, now, pid);
  return line ? { line: withInstall(line, own), stale: false } : null;
}

// The roles the probe asked to reset (#C592, gate/reset.mjs) that this watch has not printed yet; marks them printed.
function resetLines(dir, roster = null, now = Date.now(), lead = null) {
  // Only roster roles are ever named (Security: a planted file in the state folder must not make the lead wake or reset a role the team does not have).
  const onRoster = (r) => !roster || roster.includes(r);
  const read = (name) => { try { return JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { return null; } };
  const out = [];
  const asked = read(RESET_FILE), seen = read(RESET_SEEN_FILE), roles = resetPending(asked, seen).filter(onRoster);
  if (roles.length) { writeAtomic(join(dir, RESET_SEEN_FILE), JSON.stringify(resetSeen(asked, seen, roles))); out.push(...roles.map(resetLine)); }
  // Roles with no open session (#C583): "WAKE <role>" for those with work, one "ROSTER missing" line for the rest.
  const wasked = read(WAKE_ROLES_FILE), wseen = read(WAKE_ROLES_SEEN_FILE);
  const wake = resetPending(wasked, wseen, "roles").filter(onRoster), missing = resetPending(wasked, wseen, "missing").filter(onRoster);
  if (wake.length || missing.length) {
    writeAtomic(join(dir, WAKE_ROLES_SEEN_FILE), JSON.stringify(resetSeen(wasked, resetSeen(wasked, wseen, wake, "roles"), missing, "missing")));
    out.push(...wake.map(roleWakeLine));
    if (missing.length) out.push(missingLine(missing));
  }
  // A question for the owner with no Needs-you item (#C584): "ASK <role> <card>", once per card.
  const asks = read(ASKS_FILE), pending = asksPending(asks, read(ASKS_SEEN_FILE)).filter((a) => onRoster(a.role));
  if (pending.length || (asks && !sameSeen(asks, read(ASKS_SEEN_FILE)))) writeAtomic(join(dir, ASKS_SEEN_FILE), JSON.stringify(asksSeen(asks)));
  out.push(...pending.map(askLine));
  // What the probe found true of the cards (#C617): "SHIP <card>" (signed, not on main: Release is to ship it) and "CLOSE <card>"
  // (live, still open), once per card and tip. A SHIP line is printed only when the roster has the ship role.
  const truth = read(TRUTH_FILE), tseen = read(TRUTH_SEEN_FILE), due = truthPending(truth, tseen, now), todo = due.filter((a) => a.kind !== "ship" || onRoster(SHIP_ROLE));
  const nextSeen = truthSeen(truth, tseen, todo, now);
  if (JSON.stringify(nextSeen) !== JSON.stringify(tseen ?? { items: {} })) writeAtomic(join(dir, TRUTH_SEEN_FILE), JSON.stringify(nextSeen));
  out.push(...todo.map(truthLine));
  // What the derive step found (#C642): CONFLICT, LIVE BUT OPEN, NUDGE and MIRROR DRIFT lines, once per batch.
  // #C678: a line about one agent's card goes to that agent's watch; the lead keeps it only when that role has no open session.
  const away = [...(Array.isArray(wasked?.roles) ? wasked.roles : []), ...(Array.isArray(wasked?.missing) ? wasked.missing : [])].filter((r) => typeof r === "string");
  const batch = read(LINES_FILE), batchSeen = read(LINES_SEEN_FILE);
  // ...or whose own watch is not running: nobody would print its line (Security on 3eb2450).
  for (const l of Array.isArray(batch?.lines) ? batch.lines : []) { const r = typeof l === "string" ? routeOf(l) : null; if (r && !away.includes(r) && !dispatchWatchAlive(join(dir, dispatchPidFile(r)), now)) away.push(r); }
  const shown = linesPending(batch, batchSeen, { lead, roster, away, now });
  if (Number.isInteger(batch?.at) && batch.at !== batchSeen?.at) writeAtomic(join(dir, LINES_SEEN_FILE), JSON.stringify(linesSeen(batch, batchSeen, shown, now)));
  out.push(...shown);
  // The probe finds no branch for any open card (#C632): one NOEVIDENCE line per outage; the seen file is cleared when it ends.
  const blind = read(NOEVIDENCE_FILE), blindSeen = read(NOEVIDENCE_SEEN_FILE);
  if (noEvidencePending(blind, blindSeen)) { writeAtomic(join(dir, NOEVIDENCE_SEEN_FILE), JSON.stringify({ since: blind.since })); out.push(noEvidenceLine(blind.since)); }
  else if (blind && !Number.isInteger(blind.since) && blindSeen?.since != null) writeAtomic(join(dir, NOEVIDENCE_SEEN_FILE), JSON.stringify({ since: null }));
  // A dispatched card nothing has moved on for 30 minutes (#C631): one DISPATCH-LATE line per card and spell, for the roster's roles.
  const late = dispatchPending(read(DISPATCH_FILE), read(DISPATCH_LATE_SEEN_FILE), { level: 2 }).filter((i) => onRoster(i.role));
  if (late.length) { writeAtomic(join(dir, DISPATCH_LATE_SEEN_FILE), JSON.stringify(dispatchSeen(read(DISPATCH_LATE_SEEN_FILE), late))); out.push(...late.map(dispatchLateLine)); }
  return out;
}
const sameSeen = (asks, seen) => JSON.stringify(asksSeen(asks)) === JSON.stringify(seen ?? { asks: {} });

// The watch is ending (its planned stop before the Monitor's 30 minutes, or a signal): the heartbeat goes with it, but only
// if it is this process's own. The end of the process ends the Monitor, which starts a lead turn, and that turn's Stop check
// must find no watch running, or it would ask for nothing and the lead would sit unwatched (Checker on 47d99b8d).
export function endWatch(dir, pid = process.pid) {
  const p = wakePaths(dir);
  try {
    const a = JSON.parse(readFileSync(p.alive, "utf8"));
    if (a?.pid === pid) unlinkSync(p.alive);
  } catch { /* none, or not ours */ }
}

// Another watch alive: a fresh heartbeat of another process that still exists.
export function otherWatchAlive(dir, now, pid = process.pid) {
  try {
    const a = JSON.parse(readFileSync(wakePaths(dir).alive, "utf8"));
    if (!Number.isInteger(a?.pid) || a.pid === pid || !Number.isFinite(a.at) || now - a.at > ALIVE_MAX_MS || a.at > now + 5_000) return false;
    process.kill(a.pid, 0);
    return true;
  } catch (e) { return e?.code === "EPERM"; }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  // #C1165: --pinned hands over to the pinned install's copy of this file (same arguments, without --pinned) unless this already is it; no pin, no watch.
  // #C1240: the launcher stays up and follows the pin (see followStep): the pinned copy runs as its child, also when it is this very file, and the child is told to end quietly (STALE_EXIT) when the pin moves.
  if (process.argv.includes("--pinned") && process.env[FOLLOW_ENV] !== "1") {
    const settingsNow = () => { try { return readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"); } catch { return null; /* no settings: no pin */ } };
    const installRoot = join(homedir(), ".flight-board", "install");
    let current = null;
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { if (current) current.kill(sig); else process.exit(0); });
    let recent = [], first = true;
    for (;;) {
      const launch = pinnedLaunch({ settingsText: settingsNow(), installRoot, self: fileURLToPath(import.meta.url) });
      if (launch.why) { console.error(first ? `wake-watch: --pinned: ${launch.why}; nothing armed` : `wake-watch: --pinned: ${launch.why}; the watch ends, arm it again by hand`); process.exit(1); }
      first = false;
      const ended = await new Promise((resolve) => {
        current = spawn(process.execPath, [launch.file, ...process.argv.slice(2).filter((a) => a !== "--pinned")], { stdio: "inherit", env: { ...process.env, [FOLLOW_ENV]: "1" } });
        current.on("exit", (code, signal) => resolve({ code, signal }));
        current.on("error", (e) => { console.error(`wake-watch: --pinned: could not start the pinned copy: ${e.message}`); resolve({ error: e }); });
      });
      current = null;
      const step = followStep(ended, recent, Date.now());
      if (!step.again) { if (step.why) console.error(`wake-watch: --pinned: ${step.why}`); process.exit(step.code); }
      recent = step.recent;
    }
  }
  const at = process.argv.indexOf("--config");
  let config;
  try {
    const raw = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
    if (at < 0 || checkConfig(raw).length) throw new Error("bad config");
    config = fullConfig(raw);
  } catch { console.error("wake-watch: no usable --config"); process.exit(1); }
  const id = boardId(config);
  if (!id) { console.error("wake-watch: the config has no board link"); process.exit(1); }
  const dir = join(home(config.gate.stateDir), id), start = Date.now();
  const ri = process.argv.indexOf("--role");
  if (ri > 0) {
    // An owner's watch (#C631): node wake-watch.mjs --config <cfg> --role <Role> --once, run by the owner as a background Bash with no
    // timeout. It blocks, beating its pid file, until the probe dispatches a card to the role; it prints that DISPATCH line and
    // exits, and the exit wakes the idle session. Roster roles other than the lead only.
    const role = process.argv[ri + 1];
    if (!process.argv.includes("--once") || !config.roster.includes(role) || role === config.gate.managerRole) { console.error("wake-watch: --role <a roster role other than the lead> --once"); process.exit(1); }
    const pidFile = join(dir, dispatchPidFile(role));
    if (dispatchWatchAlive(pidFile, start) && (() => { try { return JSON.parse(readFileSync(pidFile, "utf8")).pid !== process.pid; } catch { return false; } })()) { console.log(`wake-watch: ${role}'s watch is already running; nothing to arm`); process.exit(0); }
    const stop = () => { try { if (JSON.parse(readFileSync(pidFile, "utf8")).pid === process.pid) unlinkSync(pidFile); } catch { /* none, or not ours */ } };
    // #C1158: the install this watch runs from, and the settings file whose Stop hook entry pins the install to be on.
    const own = installShaOf(realpathSync(fileURLToPath(import.meta.url)));
    const settingsFile = join(homedir(), ".claude", "settings.json");
    const look = () => {
      let settingsText = null;
      try { settingsText = readFileSync(settingsFile, "utf8"); } catch { /* no settings to read: no pin */ }
      let got = null;
      try { got = watchLook(dir, role, own, settingsText, Date.now(), process.pid); } catch { /* try again next time */ }
      // #C1240: under a --pinned launcher a moved pin ends this copy quietly, so the launcher starts the new pin's copy and nobody is woken for it.
      if (got?.stale && process.env[FOLLOW_ENV] === "1") { stop(); process.exit(STALE_EXIT); }
      if (got) { console.log(got.line); stop(); process.exit(0); }
    };
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { stop(); process.exit(0); });
    look();
    setInterval(look, POLL_MS);
  } else {
  if (otherWatchAlive(dir, start)) { console.log("wake-watch: another watch is already running; nothing to arm"); process.exit(0); }
  const loop = () => {
    const now = Date.now();
    let line = null;
    try { line = tick(dir, now, process.pid, config.roster, config.gate.managerRole); } catch { /* a file that can't be written this time: the next look tries again */ }
    if (line) console.log(line);
    if (now - start >= MAX_RUN_MS) { endWatch(dir); process.exit(0); }
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { endWatch(dir); process.exit(0); });
  loop();
  setInterval(loop, POLL_MS);
  }
}
