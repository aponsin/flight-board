// Steward's pickup watch (#C498), as one decision from the readings so far, so the watch never judges by eye.
// After each 60 s wait Steward reads the target's row (list_sessions: idle or working) and its Messages tokens (get_usage;
// none listed is 0), adds them to the readings, and runs:
//   node ~/.flight-board/current/scripts/pickup-watch.mjs '[{"state":"working","tokens":14000}, …]'
// It prints one word and does that:
//   send       - idle with Messages under FRESH: the session cleared and sits there; send "/pickup <Role>" once, stop.
//   picked-up  - someone already picked it up; stop. Working under FRESH, or (#C498's follow-up: Manager was picked up
//                before the first check, and Steward then read 14k, 26k, 37k, 52k and waited out all ten minutes) seen
//                working under LOW_START at an earlier check: a fresh session (before its clear the lead reads far more).
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
  // A fresh session seen working at an earlier check was a pickup (Checker: an idle session reads 0, so its pickup turn
  // ending would read as "cleared" and send a second /pickup). Before its clear the lead reads far above LOW_START.
  if (rs.slice(0, -1).some((r) => r.state === "working" && tokensOf(r) < LOW_START)) return "picked-up";
  if (last.state === "idle" && t < FRESH) return "send";
  if (last.state === "working" && t < FRESH) return "picked-up";
  return rs.length >= MAX_CHECKS ? "give-up" : "wait";
}

// #C870: one pass of the scheduled watchdog over the roster, as one decision. The Worker runs in Cloudflare and cannot reach
// local sessions, so the watchdog (the app's session tools) reads each role's row once per pass and runs:
//   node ~/.flight-board/current/scripts/pickup-watch.mjs --pass '[{"role":"Checker","state":"idle","tokens":0,"reset":true,"pickedUp":false,"watchRunning":false,"remoteControl":"on"}, …]'
// A row: role; state "idle" or "working" (list_sessions); tokens the Messages tokens (get_usage; none listed is 0);
// reset true while the role announced a reset ("resetting after this") that no pickup has answered; pickedUp true once a
// pickup ran since that reset; watchRunning whether a dispatch watch is armed for it; remoteControl its remoteControlState.
// It prints a JSON list of {role, do, ...} and the watchdog does exactly those, nothing else:
//   send_message  - {role, text: "/pickup <Role>"}: the role reset, sits idle with an empty context, and was not picked up.
//                   Never while it is working (its reset turn may still run: a /pickup queued then ran before the clear and
//                   blocked it, 2026-11-10 9:47 pm), never twice for one reset, never for a role that did not reset.
//   send_message  - {role, text: "arm your dispatch watch"}: picked up, idle, and no watch armed (Checker 2026-11-10 9:42 pm).
//   set_remote_control - {role, on: true}: its Remote Control reads "off" (#C865; "unavailable" and "connecting" are left alone).
export const REARM_TEXT = "arm your dispatch watch";
export function passActions(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.role !== "string" || !/^[A-Za-z][A-Za-z0-9]*(?: [A-Za-z0-9]+)*$/.test(r.role)) continue;
    const idle = r.state === "idle", t = tokensOf(r);
    if (r.reset === true && r.pickedUp !== true && idle && t < FRESH) out.push({ role: r.role, do: "send_message", text: `/pickup ${r.role}` });
    else if (r.pickedUp === true && idle && r.watchRunning !== true) out.push({ role: r.role, do: "send_message", text: REARM_TEXT });
    if (r.remoteControl === "off") out.push({ role: r.role, do: "set_remote_control", on: true });
  }
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === "--pass") {
    let rows = null;
    try { rows = JSON.parse(process.argv[3] ?? "[]"); } catch { /* below */ }
    console.log(JSON.stringify(Array.isArray(rows) ? passActions(rows) : []));
    process.exit(0);
  }
  let readings = null;
  try { readings = JSON.parse(process.argv[2] ?? "[]"); } catch { /* below */ }
  if (!Array.isArray(readings)) { console.log("wait"); process.exit(0); }
  console.log(decide(readings));
}
