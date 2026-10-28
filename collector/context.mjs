// Memory tiles from the app's own numbers (#C274): each run reads every role's session context from the app
// (mcp__ccd_session_mgmt__list_sessions, then get_usage per session) and writes ctx/<Role> {pct, tokens, at} and
// meta/context agents.<Role> {pct, tokens, at}, so a tile no longer depends on each agent reporting itself. tokens
// (#C350) is the session's context in tokens, what the tiles show against 200k; a reading without it is {pct, at}.
// The numbers never pass through the run's model: this file is also a PostToolUse hook on those two tools, in the state
// folder's settings only (node <pinned install>/collector/context.mjs --config <board.config.json>), which saves the
// session list and each reading in the state folder. --prepare plans which session to read for each role
// (collector.contextRoles: a session titled exactly as the role, the newest open one), step 2 turns the readings into
// files in collector.outDir, and the run writes those files as they are (file_path), as it does derived/all. A session
// the app can't read (no running process: "unavailable") keeps its last reading on the board.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";

export const LIST_TOOL = "mcp__ccd_session_mgmt__list_sessions";
export const USAGE_TOOL = "mcp__ccd_session_mgmt__get_usage";
export const SESSIONS_FILE = "sessions.json", PLAN_FILE = "usage-plan.json", USAGE_DIR = "usage";
export const META_FILE = "meta-context.json";
export const ctxFile = (role) => `ctx-${role}.json`;
// A session list counts for the run that made it only: --prepare follows it within minutes.
export const LIST_MAX_AGE = 15 * 60e3;
// A reading the run writes is this run's: never older than this when the gate or the fence sees it.
export const CTX_MAX_AGE = 2 * 3600e3;
// No session's context is near this; a larger number is a misread, never a tile.
export const MAX_TOKENS = 1e8;
const wholeTokens = (t) => Number.isInteger(t) && t >= 0 && t <= MAX_TOKENS;
const SESSION = /^[A-Za-z0-9_-]{1,100}$/;
export const ROLE = /^[A-Za-z0-9_-]{1,60}$/;
const home = (p) => String(p).replace(/^~(?=\/|$)/, homedir());
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const contextRoles = (config) => (config.collector.contextRoles ?? []).filter((r) => ROLE.test(r));

// A tool's response as the hook sees it: MCP text blocks, a JSON string, or the object itself. Null when none.
export function responseJson(r) {
  try {
    if (plain(r) && Array.isArray(r.content)) r = r.content;
    if (Array.isArray(r)) r = r.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
    if (typeof r === "string") r = r ? JSON.parse(r) : null;
    return r !== null && typeof r === "object" ? r : null;
  } catch { return null; }
}

// The text of a tool's answer as the hook sees it, or "".
const responseText = (r) => {
  if (plain(r) && Array.isArray(r.content)) r = r.content;
  if (Array.isArray(r)) r = r.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
  return typeof r === "string" ? r : "";
};
// An answer too long for the session (the trial run's 200 sessions came to 81,000 characters) is saved by the app to a
// file, and the session and this hook get only a note naming it. The list is read from that file, and only from this
// run's own: <home>/.claude/projects/<cwd, every character but a letter or digit as "-">/<session>/tool-results/
// mcp-ccd_session_mgmt-list_sessions-<n>.txt, compared as an exact string, a plain file of this user's, never a link.
// The run's model never reads it (its settings deny ~/.claude). Null when there is none.
export function savedList(input, homeDir) {
  const m = /saved to (\/\S+?\.txt)\.?(\s|$)/.exec(responseText(input.tool_response));
  if (!m || !SESSION.test(String(input.session_id ?? "")) || typeof input.cwd !== "string") return null;
  const folder = join(homeDir, ".claude", "projects", input.cwd.replace(/[^A-Za-z0-9]/g, "-"), input.session_id, "tool-results");
  const p = m[1], name = p.slice(folder.length + 1);
  if (!p.startsWith(folder + "/") || !/^mcp-ccd_session_mgmt-list_sessions-\d{1,20}\.txt$/.test(name)) return null;
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || st.size > 8 * 1024 * 1024 || realpathSync(p) !== join(realpathSync(folder), name)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch { return null; }
}

// list_sessions' open sessions, kept to what the plan needs: { id, title, at } (never folders, branches or links).
export function sessionRows(resp) {
  if (!Array.isArray(resp)) return [];
  return resp.filter((s) => plain(s) && s.isArchived !== true && SESSION.test(String(s.sessionId ?? "")) && typeof s.title === "string" && s.title.length <= 200)
    .map((s) => ({ id: s.sessionId, title: s.title, at: Date.parse(s.lastActivityAt) || 0 }));
}

// Each role's session: the newest one titled exactly as the role. { Role: session id }, roles with none left out.
export function pickSessions(rows, roles) {
  const out = {};
  for (const role of roles) {
    const best = rows.filter((s) => s.title === role).sort((a, b) => b.at - a.at)[0];
    if (best) out[role] = best.id;
  }
  return out;
}

// get_usage's answer for one session: { status, pct, tokens } with pct a whole percentage, or null when the app couldn't
// read it, and tokens its tokensUsed as a whole number, or null when the answer has none (the percentage still counts).
export function usageReading(resp, sessionId) {
  const c = plain(resp) ? resp.context : null;
  const p = plain(c) && c.session === sessionId && c.status === "ok" && typeof c.percentUsed === "number" ? Math.round(c.percentUsed) : null;
  const pct = Number.isInteger(p) && p >= 0 && p <= 100 ? p : null;
  const t = pct !== null && typeof c.tokensUsed === "number" ? Math.round(c.tokensUsed) : null;
  return { status: pct === null ? "unavailable" : "ok", pct, tokens: wholeTokens(t) ? t : null };
}

export function readPlan(dir) {
  try {
    const p = JSON.parse(readFileSync(join(dir, PLAN_FILE), "utf8"));
    return plain(p) && plain(p.roles) && Number.isFinite(p.at) ? p : null;
  } catch { return null; }
}

// The hook: saves the session list, or one planned session's reading. Returns why nothing was saved, or null.
export function tap(input, { dir, now, homeDir = homedir() }) {
  if (!plain(input) || input.cwd !== dir) return "not this board's state folder";
  const resp = responseJson(input.tool_response);
  if (input.tool_name === LIST_TOOL) {
    const rows = sessionRows(Array.isArray(resp) ? resp : savedList(input, homeDir));
    writeFileSync(join(dir, SESSIONS_FILE), JSON.stringify({ at: now, rows }));
    return null;
  }
  if (input.tool_name === USAGE_TOOL) {
    const id = input.tool_input?.session_id;
    if (!SESSION.test(String(id ?? "")) || !Object.values(readPlan(dir)?.roles ?? {}).includes(id)) return "not a planned session";
    mkdirSync(join(dir, USAGE_DIR), { recursive: true });
    writeFileSync(join(dir, USAGE_DIR, `${id}.json`), JSON.stringify({ ...usageReading(resp, id), at: now }));
    return null;
  }
  return "not a memory reading";
}

// --prepare: which session to read for each role, from this run's session list. Writes the plan the fence and the hook
// check get_usage against, drops the last run's readings, and returns the lines that tell the run what to read.
export function planReadings(dir, config, now) {
  const roles = contextRoles(config);
  rmSync(join(dir, PLAN_FILE), { force: true });
  rmSync(join(dir, USAGE_DIR), { recursive: true, force: true });
  if (!roles.length) return [];
  let list = null;
  try { list = JSON.parse(readFileSync(join(dir, SESSIONS_FILE), "utf8")); } catch { /* none yet */ }
  if (!plain(list) || !Array.isArray(list.rows) || !(now - list.at <= LIST_MAX_AGE)) return ["Read memory: no session list from this run (list_sessions comes first): memory tiles skipped this run."];
  const picked = pickSessions(list.rows, roles);
  writeFileSync(join(dir, PLAN_FILE), JSON.stringify({ at: now, roles: picked }));
  return Object.entries(picked).map(([role, id]) => `Read memory: get_usage session_id ${id} (${role})`);
}

// Step 2: the files the run writes, from this run's readings (taken after the plan). Last run's files go first, so a
// role read this time is the only one with a file. Returns the MEMORY lines.
export function writeContext(dir, out, config, now) {
  const roles = contextRoles(config);
  if (!roles.length) return [];
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(out)) if (f === META_FILE || (f.startsWith("ctx-") && f.endsWith(".json"))) rmSync(join(out, f), { force: true });
  const plan = readPlan(dir), agents = {}, lines = [];
  for (const role of roles) {
    const id = plan?.roles?.[role];
    let r = null;
    try { r = id && SESSION.test(id) ? JSON.parse(readFileSync(join(dir, USAGE_DIR, `${id}.json`), "utf8")) : null; } catch { /* no reading */ }
    const tile = wholeTokens(r?.tokens) ? { pct: r.pct, tokens: r.tokens, at: r.at } : { pct: r?.pct, at: r?.at };
    if (!plain(r) || r.status !== "ok" || !(r.at >= plan.at) || ctxDocErrors(tile, now).length) continue;
    agents[role] = tile;
    writeFileSync(join(out, ctxFile(role)), JSON.stringify(agents[role]));
    lines.push(`MEMORY set ctx/${role} from ${join(out, ctxFile(role))}`);
  }
  if (lines.length) {
    writeFileSync(join(out, META_FILE), JSON.stringify({ agents }));
    lines.push(`MEMORY update meta/context from ${join(out, META_FILE)}`);
  }
  const kept = roles.filter((r) => !agents[r]);
  if (kept.length) lines.push(`MEMORY kept (no reading this run): ${kept.join(", ")}`);
  return lines;
}

// A tile the collector writes: exactly { pct, at } or { pct, tokens, at }, a whole percentage (and a whole number of
// tokens) read in the last CTX_MAX_AGE.
export function ctxDocErrors(d, now) {
  if (!plain(d)) return ["a memory reading is an object {pct, tokens, at}"];
  const e = [];
  const extra = Object.keys(d).filter((k) => k !== "pct" && k !== "tokens" && k !== "at");
  if (extra.length) e.push(`only pct, tokens and at (not ${extra.join(", ")})`);
  if (!(Number.isInteger(d.pct) && d.pct >= 0 && d.pct <= 100)) e.push("pct: a whole number from 0 to 100");
  if ("tokens" in d && !wholeTokens(d.tokens)) e.push(`tokens: a whole number from 0 to ${MAX_TOKENS}`);
  if (!(Number.isInteger(d.at) && d.at <= now + 60e3 && d.at >= now - CTX_MAX_AGE)) e.push("at: when it was read, in this run");
  return e;
}
// The collector's meta/context update: only agents.<Role> {pct, tokens, at}, for roles in collector.contextRoles.
export function contextUpdateErrors(d, roles, now) {
  if (!plain(d) || Object.keys(d).some((k) => k !== "agents") || !plain(d.agents) || !Object.keys(d.agents).length) return ["meta/context: only agents.<Role> {pct, tokens, at}"];
  return Object.entries(d.agents).flatMap(([role, v]) => (roles.includes(role) ? ctxDocErrors(v, now) : [`${role} is not in collector.contextRoles`]).map((m) => `agents.${role}: ${m}`));
}
// The gate's and the fence's check of one collector write to ctx/<Role> or meta/context.
export function contextWriteErrors(w, roles, now) {
  if (w.collection === "ctx" && w.op === "set") return roles.includes(w.doc_id) ? ctxDocErrors(w.data, now) : [`ctx/${w.doc_id}: not in collector.contextRoles`];
  if (w.collection === "meta" && w.doc_id === "context" && w.op === "update") return contextUpdateErrors(w.data, roles, now);
  return ["not a memory reading"];
}
export const isContextWrite = (w) => (w.collection === "ctx" && w.op === "set") || (w.collection === "meta" && w.doc_id === "context" && w.op === "update");

// The hook's command line. It never blocks the run's tool (always exit 0): a reading not saved only leaves a tile as it was.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const argv = process.argv.slice(2), at = argv.indexOf("--config");
    const raw = JSON.parse(readFileSync(argv[at + 1], "utf8"));
    const problems = checkConfig(raw);
    if (at < 0 || problems.length) throw new Error(problems.join("; ") || "no --config");
    const config = fullConfig(raw), id = boardId(config);
    if (!id) throw new Error("the config has no board link");
    const why = tap(JSON.parse(readFileSync(0, "utf8")), { dir: join(home(config.gate.stateDir), id), now: Date.now() });
    if (why) process.stderr.write(`Memory reading not saved: ${why}.\n`);
  } catch (e) { process.stderr.write(`Memory reading not saved: ${e?.message ?? e}.\n`); }
  process.exit(0);
}
