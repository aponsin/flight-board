// The lead's wake watch (#C580): node scripts/wake-watch.mjs --config <board.config.json>, run by the lead's Monitor
// (timeout_ms 1800000). Each line it prints is one event, which starts a lead turn: "WAKE #<n>: the owner wrote on the
// board; read it now". It prints one line per new wake (gate/wake.mjs: the probe's wake.json against what this watch
// last printed, wake-seen.json), nothing else, and stops by itself before the Monitor's 30 minutes are up. Its
// heartbeat (wake-watch.alive.json) is what the lead's Stop hook looks at to ask for a re-arm. Nothing here reads the board
// or the transcript: counters and times only.
import { readFileSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "./config.mjs";
import { home } from "../gate/gate.mjs";
import { wakePaths, readWakeFile, writeAtomic, wakePending, wakeLine, POLL_MS, ALIVE_MAX_MS, MAX_RUN_MS } from "../gate/wake.mjs";
import { RESET_FILE, RESET_SEEN_FILE, WAKE_ROLES_FILE, WAKE_ROLES_SEEN_FILE, resetPending, resetSeen, resetLine, wakeLine as roleWakeLine, missingLine, ASKS_FILE, ASKS_SEEN_FILE, asksPending, asksSeen, askLine, TRUTH_FILE, TRUTH_SEEN_FILE, SHIP_ROLE, truthPending, truthSeen, truthLine, NOEVIDENCE_FILE, NOEVIDENCE_SEEN_FILE, noEvidencePending, noEvidenceLine, DISPATCH_FILE, DISPATCH_LATE_SEEN_FILE, dispatchSeenFile, dispatchPidFile, dispatchPending, dispatchSeen, dispatchLine, dispatchLateLine, dispatchWatchAlive, LINES_FILE, LINES_SEEN_FILE, linesPending, linesSeen, linesSeenFile, routeOf } from "../gate/reset.mjs";

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
  if (due.length) writeAtomic(join(dir, dispatchSeenFile(role)), JSON.stringify(dispatchSeen(seen, due)));
  return [...due.map(dispatchLine), ...mine].join("\n");
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
    const look = () => {
      let line = null;
      try { line = roleTick(dir, role, Date.now(), process.pid); } catch { /* try again next time */ }
      if (line) { console.log(line); stop(); process.exit(0); }
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
