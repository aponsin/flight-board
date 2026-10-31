// Steward's pickup watch (#C498), as one decision from the readings so far, so the watch never judges by eye.
// After each 60 s wait Steward reads the target's row (list_sessions: idle or working) and its Messages tokens (get_usage;
// none listed is 0), adds them to the readings, and runs:
//   node ~/.flight-board/current/scripts/pickup-watch.mjs '[{"state":"working","tokens":14000}, …]'
// It prints one word and does that:
//   send       - idle with Messages under FRESH: the session cleared and sits there; send "/pickup <Role>" once, stop.
//   picked-up  - someone already picked it up; stop. Working under FRESH, or (#C498's follow-up: Manager was picked up
//                before the first check, and Steward then read 14k, 26k, 37k, 52k and waited out all ten minutes) working
//                and its Messages growing at every check from a start under LOW_START: a fresh session filling up.
//   wait       - not cleared yet: wait 60 s again.
//   give-up    - MAX_CHECKS checks done: leave it to the keeper's hourly step 4.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FRESH = 5_000, LOW_START = 60_000, MAX_CHECKS = 10;
const tokensOf = (r) => (Number.isFinite(r?.tokens) && r.tokens >= 0 ? r.tokens : 0);

export function decide(readings) {
  const rs = Array.isArray(readings) ? readings.filter((r) => r && (r.state === "idle" || r.state === "working")) : [];
  if (!rs.length) return "wait";
  const last = rs[rs.length - 1], t = tokensOf(last);
  if (last.state === "idle" && t < FRESH) return "send";
  if (last.state === "working" && t < FRESH) return "picked-up";
  // Growing at every check from a low start: two readings at least, all working, each above the one before.
  if (rs.length >= 2 && tokensOf(rs[0]) < LOW_START && rs.every((r) => r.state === "working") && rs.every((r, k) => k === 0 || tokensOf(r) > tokensOf(rs[k - 1]))) return "picked-up";
  return rs.length >= MAX_CHECKS ? "give-up" : "wait";
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let readings = null;
  try { readings = JSON.parse(process.argv[2] ?? "[]"); } catch { /* below */ }
  if (!Array.isArray(readings)) { console.log("wait"); process.exit(0); }
  console.log(decide(readings));
}
