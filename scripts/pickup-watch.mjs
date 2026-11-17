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
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
//   node ~/.flight-board/current/scripts/pickup-watch.mjs --pass x --rows-file <file> --config <board.config.json> [--state <file>]
//   (the rows are a JSON list like [{"role":"Checker","state":"idle","tokens":0,"remoteControl":"on"}, …], from the file or, with no
//   --rows-file, from the argument after --pass; --config is required: it limits the roles to its roster, and no readable roster sends nothing)
// A row is only what the session tools give: role; state "idle" or "working" (list_sessions); tokens the Messages tokens
// (get_usage; none listed is 0); remoteControl its remoteControlState. Everything else the program finds out itself
// (Checker 2's M1 and M2 on 8a27f1be: the watchdog agent judged "reset", "picked up" and "watch armed" from threads, so a
// cleared idle session with "reset" unknown got no pickup, and a role with no watch was told to arm one at every pass):
//   - a role's history is a small state file (--state, default ~/.flight-board/pickup-pass.json) the pass reads and
//     rewrites: "high" is a reading of LOW_START or more since the last pickup (a session that had a real context), "sent" is
//     this program's own /pickup, "worked" is the role seen working after it, "sawWatch" a watch seen armed for the role;
//   - a watch is armed when `ps` lists a wake-watch.mjs with that --role (nothing is read from a thread).
// It prints a JSON list of {role, do, ...} and the watchdog does exactly those, nothing else:
//   send_message  - {role, text: "/pickup <Role>"}: idle, Messages under FRESH, and it was high since the last pickup: it
//                   cleared. Never while it works (its reset turn may still run: a /pickup queued then ran before the clear and
//                   blocked it, 2026-11-10 9:47 pm), once per clear (the next one needs a new high reading), never for a role
//                   whose pass history never held a high reading (a first run on an already cleared session can't tell).
//   send_message  - {role, text: "arm your dispatch watch"}: once per pickup, and only for a role seen working after it and
//                   idle again with no watch armed, and seen with a watch before (Manager has none: it is never told).
//   set_remote_control - {role, on: true}: its Remote Control reads "off" (#C865; "unavailable" and "connecting" are left alone).
export const REARM_TEXT = "arm your dispatch watch";
// The ROLE form of the state schema: 2 to 24 characters, a letter first, single spaces inside (Security's L3 on 8a27f1be: no cap).
const ROLE = /^(?=.{2,24}$)[A-Za-z][A-Za-z0-9]*(?: [A-Za-z0-9]+)*$/;

// The roles with a dispatch watch armed, from `ps -axo args` text: a wake-watch.mjs line carrying "--role <name>".
export function watchRoles(psText) {
  const out = new Set();
  for (const line of String(psText ?? "").split("\n")) {
    // Only a node process counts: a "grep wake-watch.mjs --role Security" line is no watch (Checker 2's L1 on 222aa055).
    if (!line.includes("wake-watch.mjs") || !/^\s*(?:\S*\/)?node\s/.test(line)) continue;
    const m = line.match(/--role[ =]+(?:'([^']*)'|"([^"]*)"|(.+?))(?= --|\s*$)/);
    const name = (m && (m[1] ?? m[2] ?? m[3]) || "").trim();
    if (ROLE.test(name)) out.add(name);
  }
  return out;
}

// rows: the session tools' readings; state: the history by role (not changed); watching: watchRoles(...).
// Returns { actions, state } with the new history.
// roster: a Set of role names (the config's roster) or null for none given: a role outside it is dropped, so nothing is ever sent to a
// session the board does not know (Security's L1).
export function passActions(rows, state = {}, watching = new Set(), roster = null) {
  const actions = [], next = { ...state };
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.role !== "string" || !ROLE.test(r.role) || (roster && !roster.has(r.role))) continue;
    const role = r.role, idle = r.state === "idle", t = tokensOf(r), s = { ...(state[role] || {}) }, armed = watching.has(role);
    if (armed) s.sawWatch = true;
    if (t >= LOW_START) { s.high = true; s.sent = false; s.worked = false; s.rearmed = false; }
    // The pickup ran once the role is seen working, or its Messages have grown from the cleared 0 to FRESH or more (an hourly pass
    // almost never sees a pickup turn of a few minutes; a queued pickup stays at 0): Checker 2's M1 on 222aa055.
    else if (s.sent && (r.state === "working" || t >= FRESH)) s.worked = true;
    if (s.high && idle && t < FRESH) {
      actions.push({ role, do: "send_message", text: `/pickup ${role}` });
      s.high = false; s.sent = true; s.worked = false; s.rearmed = false;
    } else if (s.sent && s.worked && !s.rearmed && idle && s.sawWatch && !armed) {
      actions.push({ role, do: "send_message", text: REARM_TEXT });
      s.rearmed = true;
    }
    if (r.remoteControl === "off") actions.push({ role, do: "set_remote_control", on: true });
    next[role] = s;
  }
  return { actions, state: next };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === "--pass") {
    // Rows come from a file (--rows-file <file>: the watchdog writes it with the Write tool, so no quote in a value can break a
    // shell argument; Security's L3) or, as before, from the next argument. --config <board.config.json> limits the roles to its roster.
    const opt = (k) => { const i = process.argv.indexOf(k); return i > 2 && process.argv[i + 1] ? process.argv[i + 1] : null; };
    let rows = null, state = {}, roster = null;
    try { rows = JSON.parse(opt("--rows-file") ? readFileSync(opt("--rows-file"), "utf8") : (process.argv[3] ?? "[]")); } catch { /* below */ }
    if (!Array.isArray(rows)) { console.log("[]"); process.exit(0); }
    // --config is required (Security's INFO 1 on 222aa055): without a roster nothing is sent, even if the prompt's own check is skipped.
    if (opt("--config")) {
      try { const c = JSON.parse(readFileSync(opt("--config"), "utf8")); if (Array.isArray(c.roster)) roster = new Set(c.roster.filter((x) => typeof x === "string")); } catch { /* no roster: nothing is sent, below */ }
    }
    if (!roster) { console.log("[]"); process.exit(0); }
    const file = opt("--state") ?? join(homedir(), ".flight-board", "pickup-pass.json");
    try { const j = JSON.parse(readFileSync(file, "utf8")); if (j && typeof j === "object" && !Array.isArray(j)) state = j; } catch { /* no history yet */ }
    let ps = "";
    try { ps = execFileSync("ps", ["-axo", "args"], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { /* no watch seen */ }
    const { actions, state: next } = passActions(rows, state, watchRoles(ps), roster);
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(next)); } catch { /* the history is lost: no pickup is sent twice by it, the next pass starts clean */ }
    console.log(JSON.stringify(actions));
    process.exit(0);
  }
  let readings = null;
  try { readings = JSON.parse(process.argv[2] ?? "[]"); } catch { /* below */ }
  if (!Array.isArray(readings)) { console.log("wait"); process.exit(0); }
  console.log(decide(readings));
}
