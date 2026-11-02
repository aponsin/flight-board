// The lead's wake path (#C580): the owner's board message or answer starts a lead turn within about a minute, with no
// comment auto-reply (the app's auto mode refuses most of those).
//   page    board_wake {kind}, a connector call at the owner's write           -> the state Worker's counter (worker/)
//   probe   collector/state.mjs, once a minute, GET /b/<board id>/wake         -> <stateDir>/<board>/wake.json { seq, at }
//   watch   scripts/wake-watch.mjs, run by the lead's Monitor                  -> one line when wake.json's seq is above
//                                                                                 the last one it printed (wake-seen.json)
// Nothing here carries text: a counter and times. The lead reads the board for what the owner wrote.
// The lead's Stop hook (gate/stop.mjs) asks to arm the watch when wake.json exists (the probe polls) and the watch's
// heartbeat (wake-watch.alive.json) is missing or older than ALIVE_MAX_MS.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export const WAKE_FILE = "wake.json", SEEN_FILE = "wake-seen.json", ALIVE_FILE = "wake-watch.alive.json";
export const POLL_MS = 5_000, ALIVE_MAX_MS = 60_000, MAX_RUN_MS = 29.5 * 60e3;

export const wakePaths = (dir) => ({ wake: join(dir, WAKE_FILE), seen: join(dir, SEEN_FILE), alive: join(dir, ALIVE_FILE) });

const whole = (n) => Number.isInteger(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
// { seq, at } from a file's text, or null: whole numbers only, nothing else kept.
export function parseWake(text) {
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" && !Array.isArray(j) && whole(j.seq) && whole(j.at) ? { seq: j.seq, at: j.at } : null;
  } catch { return null; }
}
export const readWakeFile = (path) => { try { return parseWake(readFileSync(path, "utf8")); } catch { return null; } };

export const writeAtomic = (path, text) => { const tmp = `${path}.${process.pid}.part`; writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, path); };

// The probe's side: the Worker's answer { seq, at } (anything else is none) against what wake.json holds. Returns the
// file's new text, or null when nothing changes (same seq, or an answer that went back: a Worker redeployed on a new
// namespace restarts at 0, and a lower seq must never hide the next real one, so it is taken as the new count).
export function nextWakeFile(answer, current) {
  const a = answer && typeof answer === "object" ? parseWake(JSON.stringify({ seq: answer.seq, at: answer.at })) : null;
  if (!a) return null;
  if (current && current.seq === a.seq && current.at === a.at) return null;
  return JSON.stringify(a);
}

// The watch's side: whether wake.json is ahead of what the watch last printed. A lower seq than seen (the Worker
// restarted its count) counts as new too, and resets what is seen.
export const wakePending = (wake, seen) => !!wake && wake.seq > 0 && (!seen || wake.seq !== seen.seq || wake.at !== seen.at);

export const wakeLine = (wake) => `WAKE #${wake.seq}: the owner wrote on the board; read it now (messages and answered asks)`;

// The Stop hook's ask. hasWake: wake.json exists (the probe polls the Worker, so the wake path is on). aliveAt: the
// heartbeat's time, or null.
export function watchAsk({ hasWake, aliveAt, now, command }) {
  if (!hasWake) return null;
  if (Number.isFinite(aliveAt) && aliveAt <= now + 5_000 && now - aliveAt <= ALIVE_MAX_MS) return null;
  return `Wake watch: the owner's board messages reach you through it and it isn't running. Arm it now (Monitor, timeout_ms 1800000, description "board wake"): ${command}. Re-arm it whenever it ends.`;
}
