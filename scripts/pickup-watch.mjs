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
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedCommit } from "./current.mjs"; // #C1165: the install the Stop hook pins

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
  // #C1419: the clear and the /pickup both landed between two checks (Steward read 116k working, then 29k idle a minute later): no reading
  // under FRESH, but a drop from LOW_START or more to under it can only be a fresh session that has already worked. A clear that still
  // reads under FRESH is the "send" case above and is not touched.
  if (t < LOW_START && rs.slice(0, -1).some((r) => tokensOf(r) >= LOW_START) && !rs.some((r) => tokensOf(r) < FRESH)) return "picked-up";
  return rs.length >= MAX_CHECKS ? "give-up" : "wait";
}

// #C870: one pass of the scheduled watchdog over the roster, as one decision. The Worker runs in Cloudflare and cannot reach
// local sessions, so the watchdog (the app's session tools) reads each role's row once per pass and runs:
//   node ~/.flight-board/current/scripts/pickup-watch.mjs --pass x --rows '<role>,<state>,<tokens>,<rc>;...' --config <board.config.json> [--state <file>]
//   (#C1132: --rows is the scheduled watchdog's form, no file tool; --rows-file <file> with the JSON list is the older one. Each printed action also carries `session`,
//   the id the config's rosterSessions holds for the role, or null)
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

// #C1132: the compact rows of --rows: "<role>,<state>,<tokens>,<remoteControl>" joined by ";" (a role may hold single spaces: "Checker 2"). A row is kept only when every
// field has its exact shape: role (ROLE), state idle or working, tokens digits (at most 9), remoteControl a word of letters, "_" and "-" (at most 20). So no quote, no space outside a role,
// no shell character and no free text reaches a command line, and a row that does not fit is dropped, never repaired. Returns the rows as passActions reads them.
const ROW_STATE = /^(?:idle|working)$/, ROW_TOKENS = /^\d{1,9}$/, ROW_RC = /^[A-Za-z][A-Za-z_-]{0,19}$/;
export function parseRows(text) {
  const out = [];
  for (const part of String(text ?? "").split(";").slice(0, 40)) {
    const f = part.split(",");
    if (f.length !== 4 || !ROLE.test(f[0]) || !ROW_STATE.test(f[1]) || !ROW_TOKENS.test(f[2]) || !ROW_RC.test(f[3])) continue;
    out.push({ role: f[0], state: f[1], tokens: Number(f[2]), remoteControl: f[3] });
  }
  return out;
}

// #C1132 (Security's M1 and L1): which paths --pass may take. The history file is written (mkdir -p, then overwritten), so it may only be the default <home>/.flight-board/pickup-pass.json (Security's M1 on 112256ee: the
// folder's other .json files are live board state) and not a symlink; the config is only read, and must be named board.config.json; the rows come from --rows or --rows-file, not both. Returns the reason, or null when all is well.
export function passPathRefusal({ state, config, rows, rowsFile, home }) {
  if (rows && rowsFile) return "--rows and --rows-file together: nothing is done";
  if (config && basename(config) !== "board.config.json") return "--config must name a file called board.config.json";
  if (state) {
    const only = resolve(home, ".flight-board", "pickup-pass.json"), file = resolve(state);
    if (file !== only) return `--state may only be ${only} (the default history file)`;
    try { if (lstatSync(file).isSymbolicLink()) return "--state is a symbolic link"; } catch { /* not there yet: it is made */ }
  }
  return null;
}

// The session id the config's rosterSessions holds for a role, only when it is a plain local session id (local_ and a uuid), else null (a role with none is reported, not sent to).
export const SESSION_ID = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const sessionOf = (sessions, role) => (sessions && Object.hasOwn(sessions, role) && typeof sessions[role] === "string" && SESSION_ID.test(sessions[role]) ? sessions[role] : null);

// The roles with a dispatch watch armed, from `ps -axo args` text: a wake-watch.mjs line carrying "--role <name>".
// #C1165: with `pin` (the 40-hex install the Stop hook pins in the settings) only a watch RUNNING that install's copy counts: a watch on an older install, on `current` or on a checkout is not armed
// on the code the board decides with, so its role is re-armed. With no pin known (the settings name none) every wake-watch line counts, as before.
export function watchRoles(psText, pin = null) {
  const out = new Set();
  for (const line of String(psText ?? "").split("\n")) {
    // Only a node process counts: a "grep wake-watch.mjs --role Security" line is no watch (Checker 2's L1 on 222aa055).
    if (!line.includes("wake-watch.mjs") || !/^\s*(?:\S*\/)?node\s/.test(line)) continue;
    if (/^[0-9a-f]{40}$/.test(String(pin ?? "")) && !line.includes(`/install/${pin}/scripts/wake-watch.mjs`)) continue;
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
    // #C1132: --rows '<role>,<state>,<tokens>,<remoteControl>;<next row>' takes the rows with no file tool (the scheduled watchdog forbids them, #C443) and no
    // JSON in a shell argument: every field is a plain word or a number, so nothing in it can be a quote, and a row that is not that shape is dropped (parseRows).
    // Security's M1 and L1 on d71cebd6: the command is pre-approved as a prefix rule, so every path it takes is the program's to hold, not the prompt's. Refused (prints [], says why on stderr,
    // touches nothing): a --state outside ~/.flight-board (it creates folders and overwrites the file), a --config not named board.config.json, and --rows with --rows-file.
    const bad = passPathRefusal({ state: opt("--state"), config: opt("--config"), rows: opt("--rows"), rowsFile: opt("--rows-file"), home: homedir() });
    if (bad) { console.error(`pickup-watch: ${bad}`); console.log("[]"); process.exit(0); }
    let rows = null, state = {}, roster = null;
    try { rows = opt("--rows") ? parseRows(opt("--rows")) : JSON.parse(opt("--rows-file") ? readFileSync(opt("--rows-file"), "utf8") : (process.argv[3] ?? "[]")); } catch { /* below */ }
    if (!Array.isArray(rows)) { console.log("[]"); process.exit(0); }
    // --config is required (Security's INFO 1 on 222aa055): without a roster nothing is sent, even if the prompt's own check is skipped.
    let sessions = {};
    if (opt("--config")) {
      try {
        const c = JSON.parse(readFileSync(opt("--config"), "utf8"));
        if (Array.isArray(c.roster)) roster = new Set(c.roster.filter((x) => typeof x === "string"));
        // #C1132: each action carries the session id the config holds for its role (rosterSessions), so the scheduled run reads no file to find it.
        if (c.rosterSessions && typeof c.rosterSessions === "object") sessions = c.rosterSessions;
      } catch { /* no roster: nothing is sent, below */ }
    }
    if (!roster) { console.log("[]"); process.exit(0); }
    const file = opt("--state") ?? join(homedir(), ".flight-board", "pickup-pass.json");
    try { const j = JSON.parse(readFileSync(file, "utf8")); if (j && typeof j === "object" && !Array.isArray(j)) state = j; } catch { /* no history yet */ }
    let ps = "";
    try { ps = execFileSync("ps", ["-axo", "args"], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { /* no watch seen */ }
    let pin = null; try { pin = pinnedCommit(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")); } catch { /* no settings: no pin */ }
    const { actions, state: next } = passActions(rows, state, watchRoles(ps, pin), roster);
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(next)); } catch { /* the history is lost: no pickup is sent twice by it, the next pass starts clean */ }
    console.log(JSON.stringify(actions.map((a) => ({ ...a, session: sessionOf(sessions, a.role) }))));
    process.exit(0);
  }
  let readings = null;
  try { readings = JSON.parse(process.argv[2] ?? "[]"); } catch { /* below */ }
  if (!Array.isArray(readings)) { console.log("wait"); process.exit(0); }
  console.log(decide(readings));
}
