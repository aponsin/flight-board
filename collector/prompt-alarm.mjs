// A role stopped on a prompt in its own session (#C526: Mainsite sat on a site approval from 05:55Z to 15:45Z, and #C520
// stalled all night). The minute probe (collector/state.mjs, promptSince) writes <stateDir>/<board>/waiting-prompt.json
// { at, roles: { <role>: <since> } } on this machine; here, once a roster role has been stopped NEEDS_USER_MS or more, one
// NUDGE to the lead for that stop: raise the owner's ask and push him once. When the role moves on, one more: mark the ask
// done. The Collector can't write an ask or push (the gate, its fence): the lead does both, as for the deaf line. A
// reading that is missing, broken or stale says nothing and changes nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_FRESH_MS, ROLE, TOOLS } from "./state-schema.mjs";

export const NEEDS_USER_MS = 15 * 60e3;
export const isTime = (v) => Number.isInteger(v) && v >= 1577836800000 && v <= 4102444800000;
export const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const askId = (role) => `needs-user-${role.toLowerCase()}`;
import { mtTime as hhmm } from "../worker/team-time.mjs"; // #C983: Mountain Time, never UTC "Z"

// What the prompt is, from the probe's tool class (#C529, reading.tools): a few fixed words, never anything from the
// reading itself but a class name the enum knows. Missing or unknown: "a prompt".
const NAMED = { AskUserQuestion: "a question", mcp: "an app or site approval", Bash: "a command approval", Edit: "a file-edit approval", Write: "a file-edit approval", NotebookEdit: "a file-edit approval", WebFetch: "a web approval", WebSearch: "a web approval" };
export function promptName(cls) {
  if (Object.hasOwn(NAMED, cls)) return NAMED[cls];
  return TOOLS.includes(cls) && cls !== "Agent" ? `a ${cls} approval` : "a prompt";
}
// The tool class the reading gives for a role, or null.
export const toolOf = (reading, role) => (plain(reading?.tools) && Object.hasOwn(reading.tools, role) ? reading.tools[role] : null);

// reading: the parsed waiting-prompt.json (or null); state: { <role>: <since> } of the stops already sent.
export function promptAlarm({ config, reading, now, state = {} }) {
  const lead = config.gate?.managerRole ?? "Manager";
  if (!plain(reading) || !isTime(reading.at) || now - reading.at >= LIVE_FRESH_MS || reading.at - now > 60e3 || !plain(reading.roles)) return { lines: [], state };
  const roster = new Set(config.roster ?? []);
  const stopped = Object.fromEntries(Object.entries(reading.roles).filter(([r, t]) => ROLE.test(r) && roster.has(r) && isTime(t)));
  const next = {}, lines = [];
  for (const [role, since] of Object.entries(plain(state) ? state : {})) {
    if (!ROLE.test(role) || !isTime(since)) continue;
    if (stopped[role] === since) next[role] = since;
    else lines.push(`NUDGE ${role} is past its prompt: mark waiting/${askId(role)} done.`);
  }
  for (const [role, since] of Object.entries(stopped).sort(([a], [b]) => a.localeCompare(b))) {
    if (next[role] === since || now - since < NEEDS_USER_MS) continue;
    next[role] = since;
    const what = promptName(toolOf(reading, role));
    lines.push(`NUDGE ${role} is waiting on ${what} in its session since ${hhmm(since)} (${Math.floor((now - since) / 60e3)} min): raise waiting/${askId(role)} (kind "action", text "${role} is waiting on ${what} in its session: open it in the Claude app and answer it") unless it is open, and push the owner once, naming ${what}.${role === lead ? ` (It is ${lead} itself: the keeper or Steward relays this.)` : ""}`);
  }
  return { lines, state: next };
}

// With its state next to the mirror (<dir>/prompt-alarm.json). Returns the NUDGE lines.
export function runPromptAlarm(dir, config, now) {
  let reading = null, before = {};
  try { reading = JSON.parse(readFileSync(join(dir, "waiting-prompt.json"), "utf8")); } catch { /* no probe reading yet */ }
  try { before = JSON.parse(readFileSync(join(dir, "prompt-alarm.json"), "utf8")); } catch { /* first run */ }
  const { lines, state } = promptAlarm({ config, reading, now, state: before });
  writeFileSync(join(dir, "prompt-alarm.json"), JSON.stringify(state));
  return lines;
}
