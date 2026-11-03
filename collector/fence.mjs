// The collector's fence, a PreToolUse hook on every tool (matcher "*") for the collector's scheduled run only, in the
// state folder's settings: node <pinned install>/collector/fence.mjs --config <board.config.json> [--send-to <session id>] || exit 2
// The lead's session is the config's gate.managerSession (#C586); --send-to is the fallback while the config has none.
// It lets through exactly the calls collector/TASK.md's steps make and refuses everything else (exit 2), whatever the
// permission mode decides: a run in auto mode can't be steered by board text into any other call (Security). It never
// grants: it only refuses, so it can't raise what the settings allow. Any failure refuses (the "|| exit 2" covers a
// crash or a missing file, which a hook would otherwise let pass). Paths and links compare as exact strings.
import { readFileSync, readlinkSync, existsSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { EXPORT_NAME, READ_COLLECTIONS, CURSOR, fileErrors } from "./export.mjs";
import { LIST_TOOL, USAGE_TOOL, contextRoles, readPlan } from "./context.mjs";

export const MESSAGE_MAX = 4096;
// The most the run may write of a page (about 100 KB a page is planned, collector/delta.mjs SWEEP_STAGES) and of derived/all.
export const PAGE_MAX = 400 * 1024;
export const DERIVED_MAX = 200 * 1024;
const SESSION = /^[A-Za-z0-9_-]{1,100}$/;
const FREE = new Set(["ToolSearch", "mcp__ccd_turn__update_plan", "mcp__ccd_turn__wrap_up"]);
// The claude-artifacts server's tools the run may call, on the board's own slug only (#C655).
export const DB_TOOLS = { list: "mcp__claude-artifacts__db_list", query: "mcp__claude-artifacts__db_query", get: "mcp__claude-artifacts__db_get", write: "mcp__claude-artifacts__db_write" };
const PAGE_NAME = /^[A-Za-z0-9_-]{1,60}$/;
const home = (p) => String(p).replace(/^~(?=\/|$)/, homedir());

// The collector's code may run from the fence's own pinned copy or from the current link (#C223): <install root>/../current,
// a symlink scripts/current.mjs points at a pinned copy once Security signed it, so a collector change needs no new
// settings. The link counts only while it is a symlink to <install root>/<full commit> holding the collector; anything
// else (a folder, a link elsewhere) and only the pinned copy runs. Returns the link's path, or null.
export function currentLink(install) {
  const root = dirname(install), link = join(dirname(root), "current");
  try { // readlinkSync throws on anything but a symlink
    const target = resolve(dirname(link), readlinkSync(link));
    if (dirname(target) !== root || !/^[0-9a-f]{40}$/.test(basename(target))) return null;
    return existsSync(join(target, "collector", "collect.mjs")) ? link : null;
  } catch { return null; }
}

// What one run may do, from the config and the fence's own command line: never from the call.
// install: the pinned copy this file runs from; current: currentLink(install) or null; configPath: exactly as the
// task's prompt types it. usageIds: the sessions --prepare planned to read (collector/context.mjs); now: the clock.
export function fenceSpec({ config, configPath, install, current = null, sendTo, uid, usageIds = [], now = Date.now() }) {
  const id = boardId(config);
  if (!id) throw new Error("the config has no board link");
  if (!config.collector.outDir) throw new Error("collector.outDir is empty");
  if (!config.artifactSlug) throw new Error("the config has no artifactSlug");
  if (!SESSION.test(String(sendTo ?? ""))) throw new Error("--send-to: a session id");
  const commands = [install, current].filter(Boolean).flatMap((dir) => {
    const collect = `node ${dir}/collector/collect.mjs --config ${configPath}`;
    return [`${collect} --prepare`, collect];
  });
  return {
    slug: config.artifactSlug,
    cwd: join(home(config.gate.stateDir), id),
    commands,
    derivedFile: join(home(config.collector.outDir), "derived-all.json"),
    roles: contextRoles(config),
    usageIds,
    sendTo,
    uid,
    now,
  };
}

// This session's scratchpad: <root>/<cwd, every character but a letter or digit as "-">/<session>/scratchpad, with /tmp
// and /private/tmp (the same folder on a Mac) written out as the only two roots.
export function scratchpads(spec, session) {
  const enc = spec.cwd.replace(/[^A-Za-z0-9]/g, "-");
  return ["/private/tmp", "/tmp"].map((base) => `${base}/claude-${spec.uid}/${enc}/${session}/scratchpad`);
}

const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (input, keys) => Object.keys(input).filter((k) => !keys.includes(k));

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// The reason a call is refused, or null when the fence lets it through. Pure but for read: the hook's input, the spec,
// and the memory files a tile write sends (their shape is checked here as well as by the gate).
export function decide(input, spec, read = readJson) {
  if (!plain(input)) return "no hook input";
  const { tool_name: tool, tool_input: t, session_id: session, cwd } = input;
  if (cwd !== spec.cwd) return `this fence is for runs in ${spec.cwd} only`;
  if (!SESSION.test(String(session ?? ""))) return "no session id";
  if (!plain(t)) return "no tool input";
  if (FREE.has(tool)) return null;
  if (tool === "Bash") {
    const extra = onlyKeys(t, ["command", "description", "timeout", "dangerouslyDisableSandbox"]);
    if (extra.length) return `Bash: unexpected ${extra.join(", ")}`;
    if (t.dangerouslyDisableSandbox !== undefined && t.dangerouslyDisableSandbox !== false) return "Bash: never outside the sandbox";
    if (!spec.commands.includes(t.command)) return "Bash: only the two collect.mjs commands, exactly as the steps write them (from the pinned copy or the current link)";
    return null;
  }
  if (Object.values(DB_TOOLS).includes(tool)) return dbCall(tool, t, spec, read);
  if (tool === "Write") return writeCall(t, spec, session);
  if (tool === "Read") {
    // The one file the run publishes: the probe's derived-all.json, so it can copy it into the db_write below.
    const extra = onlyKeys(t, ["file_path", "offset", "limit", "allow_large"]);
    if (extra.length) return `Read: unexpected ${extra.join(", ")}`;
    return t.file_path === spec.derivedFile ? null : "Read: the collector's derived-all.json only";
  }
  // Memory readings (collector/context.mjs): the session list once, then get_usage of each session --prepare planned.
  if (tool === LIST_TOOL || tool === USAGE_TOOL) {
    if (!spec.roles.length) return `${tool}: collector.contextRoles is empty`;
    const extra = onlyKeys(t, tool === LIST_TOOL ? ["limit"] : ["session_id"]);
    if (extra.length) return `${tool}: unexpected ${extra.join(", ")}`;
    if (tool === LIST_TOOL) return t.limit === undefined || (Number.isInteger(t.limit) && t.limit >= 1 && t.limit <= 200) ? null : `${tool}: limit a whole number from 1 to 200`;
    return spec.usageIds.includes(t.session_id) ? null : `${tool}: only a session --prepare planned to read`;
  }
  if (tool === "mcp__ccd_session_mgmt__send_message") {
    const extra = onlyKeys(t, ["session_id", "message"]);
    if (extra.length) return `send_message: unexpected ${extra.join(", ")}`;
    if (t.session_id !== spec.sendTo) return "send_message: only to the lead's session";
    if (typeof t.message !== "string" || t.message.length === 0) return "send_message: a message";
    if (Buffer.byteLength(t.message, "utf8") > MESSAGE_MAX) return `send_message: at most ${MESSAGE_MAX} bytes`;
    return null;
  }
  return `${String(tool)}: not one of the collector's steps`;
}

// The board's database tools (#C655), on the board's own slug and nothing else. db_list and db_query read an exported
// collection: one page (limit up to 1000) at the cursor the plan or the last page gave; db_query only with one condition,
// "at" or "updatedAt" at or after a time, as the plan wrote it. db_get reads derived/all (its version); db_write sets
// derived/all, one document, inline, at most DERIVED_MAX bytes. Nothing else: no delete, no merge, no other path.
function dbCall(tool, t, spec, read) {
  if (t.slug !== spec.slug) return "the board database: this board only";
  if (tool === DB_TOOLS.get) {
    const extra = onlyKeys(t, ["slug", "path"]);
    if (extra.length) return `db_get: unexpected ${extra.join(", ")}`;
    return t.path === "derived/all" ? null : "db_get: derived/all only";
  }
  if (tool === DB_TOOLS.write) return dbWrite(t, spec, read);
  const query = tool === DB_TOOLS.query;
  const extra = onlyKeys(t, query ? ["slug", "collection", "limit", "cursor", "where"] : ["slug", "collection", "limit", "cursor"]);
  if (extra.length) return `${query ? "db_query" : "db_list"}: unexpected ${extra.join(", ")}`;
  if (!READ_COLLECTIONS.includes(t.collection)) return "the board database: only the exported collections";
  if (!(Number.isInteger(t.limit) && t.limit >= 1 && t.limit <= 1000)) return "the board database: limit a whole number from 1 to 1000";
  if (t.cursor !== undefined && !(typeof t.cursor === "string" && CURSOR.test(t.cursor))) return "the board database: cursor as the board gave it";
  if (query && t.where !== undefined) {
    const w = t.where;
    const one = Array.isArray(w) && w.length === 1 && plain(w[0]) && onlyKeys(w[0], ["field", "op", "value"]).length === 0;
    if (!one || !["at", "updatedAt"].includes(w[0].field) || w[0].op !== ">=" || !(Number.isFinite(w[0].value) && w[0].value >= 0)) return "db_query: where is one condition, at or updatedAt >= a time";
  }
  return null;
}

// The same value whatever the order of an object's keys (a copy typed back may reorder them).
const canon = (v) => (Array.isArray(v) ? v.map(canon) : plain(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

function dbWrite(t, spec, read) {
  const extra = onlyKeys(t, ["slug", "ops"]);
  if (extra.length) return `db_write: unexpected ${extra.join(", ")}`;
  if (!Array.isArray(t.ops) || t.ops.length !== 1 || !plain(t.ops[0])) return "db_write: one operation";
  const op = t.ops[0];
  const bad = onlyKeys(op, ["op", "path", "data", "ifVersion"]);
  if (bad.length) return `db_write: unexpected ${bad.join(", ")}`;
  if (op.op !== "set" || op.path !== "derived/all") return "db_write: set derived/all only";
  if (op.ifVersion !== undefined && !(Number.isInteger(op.ifVersion) && op.ifVersion >= 1)) return "db_write: ifVersion a whole number";
  if (!plain(op.data)) return "db_write: derived/all is an object";
  if (Buffer.byteLength(JSON.stringify(op.data), "utf8") > DERIVED_MAX) return `db_write: derived/all at most ${DERIVED_MAX} bytes`;
  // What goes to the board is the probe's file, whole: nothing typed into it, nothing left out.
  let file;
  try { file = read(spec.derivedFile); } catch { return "db_write: can't read the collector's derived-all.json"; }
  return JSON.stringify(canon(file)) === JSON.stringify(canon(op.data)) ? null : "db_write: derived/all must be exactly the collector's derived-all.json";
}

// The Write tool (#C655): the pages, the sweep report and the seal in this session's export folder, nowhere else, each checked
// for its shape (collector/export.mjs fileErrors). A page is <collection>/<name>.page.json (a delta) or sweep/<collection>/<name>.page.json.
function writeCall(t, spec, session) {
  const extra = onlyKeys(t, ["file_path", "content"]);
  if (extra.length) return `Write: unexpected ${extra.join(", ")}`;
  if (typeof t.file_path !== "string" || typeof t.content !== "string") return "Write: a file_path and content";
  if (Buffer.byteLength(t.content, "utf8") > PAGE_MAX) return `Write: at most ${PAGE_MAX} bytes`;
  for (const pad of scratchpads(spec, session)) {
    const root = `${pad}/${EXPORT_NAME}/`;
    if (!t.file_path.startsWith(root)) continue;
    const parts = t.file_path.slice(root.length).split("/");
    const [first, second, third] = parts;
    let kind = null;
    if (parts.length === 1 && first === "sweep-next.json") kind = "report";
    else if (parts.length === 2 && first === "derived" && second === "all.json") kind = "seal";
    else if (parts.length === 2 && READ_COLLECTIONS.includes(first) && second.endsWith(".page.json") && PAGE_NAME.test(second.slice(0, -10))) kind = "page";
    else if (parts.length === 3 && first === "sweep" && READ_COLLECTIONS.includes(second) && third.endsWith(".page.json") && PAGE_NAME.test(third.slice(0, -10))) kind = "page";
    if (!kind) return `Write: only the export's pages, sweep-next.json and derived/all.json, in this session's scratchpad + /${EXPORT_NAME}`;
    const errs = fileErrors(kind, t.content);
    return errs.length ? `Write: ${errs.join("; ")}` : null;
  }
  return `Write: this session's scratchpad + /${EXPORT_NAME} only`;
}

// The hook: read the call, decide, refuse with exit 2. Every failure on the way refuses too.
export function main(argv, stdin) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const configPath = opt("--config");
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  const problems = checkConfig(raw);
  if (problems.length) throw new Error(problems.join("; "));
  const install = dirname(dirname(fileURLToPath(import.meta.url)));
  const config = fullConfig(raw), id = boardId(config);
  const plan = id ? readPlan(join(home(config.gate.stateDir), id)) : null;
  const spec = fenceSpec({ config, configPath, install, current: currentLink(install), sendTo: config.gate.managerSession || opt("--send-to"), uid: process.getuid(), usageIds: Object.values(plan?.roles ?? {}) });
  return decide(JSON.parse(stdin), spec);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let reason, tool = null;
  try {
    const raw = readFileSync(0, "utf8");
    try { tool = JSON.parse(raw)?.tool_name ?? null; } catch { /* main reports it */ }
    reason = main(process.argv.slice(2), raw);
  } catch (e) { reason = `fence error: ${e?.message ?? e}`; }
  // A refused memory read costs only that run's tiles (#C278): the run goes on with the export; anything else stops it.
  const next = tool === LIST_TOOL || tool === USAGE_TOOL ? "Skip the memory reads and go on with the export" : "Stop the run and tell the lead";
  if (reason) { process.stderr.write(`Refused by the collector's fence: ${reason}. ${next}.\n`); process.exit(2); }
  process.exit(0);
}
