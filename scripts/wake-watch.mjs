// The lead's wake watch (#C580): node scripts/wake-watch.mjs --config <board.config.json>, run by the lead's Monitor
// (timeout_ms 1800000). Each line it prints is one event, which starts a lead turn: "WAKE #<n>: the owner wrote on the
// board; read it now". It prints one line per new wake (gate/wake.mjs: the probe's wake.json against what this watch
// last printed, wake-seen.json), nothing else, and stops by itself before the Monitor's 30 minutes are up. Its
// heartbeat (wake-watch.alive.json) is what the lead's Stop hook looks at to ask for a re-arm. Nothing here reads the board
// or the transcript: counters and times only.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "./config.mjs";
import { home } from "../gate/gate.mjs";
import { wakePaths, readWakeFile, writeAtomic, wakePending, wakeLine, POLL_MS, ALIVE_MAX_MS, MAX_RUN_MS } from "../gate/wake.mjs";

// One look: the heartbeat, then the line to print, or null. Marks the wake seen only once it is returned.
export function tick(dir, now, pid = process.pid) {
  const p = wakePaths(dir);
  writeAtomic(p.alive, JSON.stringify({ at: now, pid }));
  const wake = readWakeFile(p.wake), seen = readWakeFile(p.seen);
  if (!wakePending(wake, seen)) return null;
  writeAtomic(p.seen, JSON.stringify({ seq: wake.seq, at: wake.at }));
  return wakeLine(wake);
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
  if (otherWatchAlive(dir, start)) { console.log("wake-watch: another watch is already running; nothing to arm"); process.exit(0); }
  const loop = () => {
    const now = Date.now();
    let line = null;
    try { line = tick(dir, now); } catch { /* a file that can't be written this time: the next look tries again */ }
    if (line) console.log(line);
    if (now - start >= MAX_RUN_MS) process.exit(0);
  };
  loop();
  setInterval(loop, POLL_MS);
}
