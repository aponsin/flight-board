// The stuck-agent watchdog's check (#C529: it said "not stuck" 20 times overnight while Mainsite sat on a site approval,
// because its fingerprint was the transcript cursor and the app keeps adding "Linked sessions now" notices to it). It
// reads the minute probe's local reading instead (collector/state.mjs: <stateDir>/<board>/waiting-prompt.json, the roles
// stopped on a prompt, since when and the prompt's tool class) and runs as one bare command in the watchdog's task:
//   node <pinned copy>/scripts/prompt-watch.mjs --config <board.config.json>
// It prints one line for the push, naming each role and its prompt, once per stop that is STUCK_MS old, between DAY_FROM
// and DAY_TO local time (a stop at night is pushed at the first run after DAY_FROM); otherwise nothing. Its own state,
// the stops already pushed, is <stateDir>/<board>/prompt-watch.json (0600). A reading that is missing, broken or stale
// (the probe stopped) prints nothing and changes nothing. Never a network call; the line never carries transcript text.
import { readFileSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "./config.mjs";
import { LIVE_FRESH_MS, ROLE } from "../collector/state-schema.mjs";
import { isTime, plain, promptName, toolOf } from "../collector/prompt-alarm.mjs";

export const STUCK_MS = 30 * 60e3;
export const DAY_FROM = 7, DAY_TO = 22;
export const MAX_LINE = 200;
const home = (p) => String(p).replace(/^~(?=\/|$)/, homedir());

// reading: the parsed waiting-prompt.json (or null); state: { <role>: <since> } of the stops already pushed; hour: the
// local hour now. Returns { line (or null), state }.
export function promptWatch({ roster, reading, state = {}, now, hour }) {
  const before = plain(state) ? state : {};
  if (!plain(reading) || !isTime(reading.at) || now - reading.at >= LIVE_FRESH_MS || reading.at - now > 60e3 || !plain(reading.roles)) return { line: null, state: before };
  const roles = new Set(roster ?? []);
  const stopped = Object.entries(reading.roles).filter(([r, t]) => ROLE.test(r) && roles.has(r) && isTime(t) && t <= now);
  // A stop already pushed stays recorded while it lasts; a role that moved on, or stopped again since, is forgotten.
  const next = Object.fromEntries(stopped.filter(([r, t]) => before[r] === t));
  const day = hour >= DAY_FROM && hour < DAY_TO;
  const due = day ? stopped.filter(([r, t]) => next[r] !== t && now - t >= STUCK_MS).sort(([a], [b]) => a.localeCompare(b)) : [];
  if (!due.length) return { line: null, state: next };
  for (const [r, t] of due) next[r] = t;
  const bit = ([r, t]) => `${r} (${Math.floor((now - t) / 60e3)} min, ${promptName(toolOf(reading, r))})`;
  const tail = due.length === 1 ? " is waiting on a prompt in its session: open it in the Claude app and answer it." : " are waiting on a prompt in their sessions: open each in the Claude app and answer it.";
  let shown = due.length, line;
  do line = due.slice(0, shown).map(bit).join(", ") + (shown < due.length ? ` and ${due.length - shown} more` : "") + tail;
  while (line.length > MAX_LINE && --shown > 0);
  return { line: shown > 0 ? line : `${due.length} roles are waiting on a prompt in their sessions: open each in the Claude app and answer it.`, state: next };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const at = process.argv.indexOf("--config");
  let config;
  try {
    const raw = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
    if (at < 0 || checkConfig(raw).length) throw new Error();
    config = fullConfig(raw);
  } catch { process.exit(0); /* no config: nothing to say (the keeper's watchdog check notices a run that fails) */ }
  const dir = join(home(config.gate.stateDir), boardId(config)), file = join(dir, "prompt-watch.json"), now = Date.now();
  let reading = null, before = {};
  try { reading = JSON.parse(readFileSync(join(dir, "waiting-prompt.json"), "utf8")); } catch { /* no probe reading */ }
  try { before = JSON.parse(readFileSync(file, "utf8")); } catch { /* first run */ }
  const { line, state } = promptWatch({ roster: config.roster, reading, state: before, now, hour: new Date(now).getHours() });
  if (JSON.stringify(state) !== JSON.stringify(before)) {
    writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  if (line) console.log(line);
}
