// The collector's fence, a PreToolUse hook on every tool (matcher "*") for the collector's scheduled run only, in the
// state folder's settings: node <pinned install>/collector/fence.mjs --config <board.config.json> --send-to <session id> || exit 2
// It lets through exactly the calls collector/TASK.md's steps make and refuses everything else (exit 2), whatever the
// permission mode decides: a run in auto mode can't be steered by board text into any other call (Security). It never
// grants: it only refuses, so it can't raise what the settings allow. Any failure refuses (the "|| exit 2" covers a
// crash or a missing file, which a hook would otherwise let pass). Paths and links compare as exact strings.
import { readFileSync, readlinkSync, existsSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { EXPORT_NAME, EXPORT_COLLECTIONS } from "./collect.mjs";
import { LIST_TOOL, USAGE_TOOL, META_FILE, ctxFile, contextRoles, contextWriteErrors, readPlan } from "./context.mjs";

export const MESSAGE_MAX = 4096;
const SESSION = /^[A-Za-z0-9_-]{1,100}$/;
const FREE = new Set(["ToolSearch", "mcp__ccd_turn__update_plan", "mcp__ccd_turn__wrap_up"]);
const QUERY_KEYS = new Set(["limit", "cursor", "where", "order_by"]);
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
  if (!SESSION.test(String(sendTo ?? ""))) throw new Error("--send-to: a session id");
  const commands = [install, current].filter(Boolean).flatMap((dir) => {
    const collect = `node ${dir}/collector/collect.mjs --config ${configPath}`;
    return [`${collect} --prepare`, collect];
  });
  return {
    url: config.artifactUrl,
    cwd: join(home(config.gate.stateDir), id),
    commands,
    derivedFile: join(home(config.collector.outDir), "derived-all.json"),
    roles: contextRoles(config),
    ctxFile: (role) => join(home(config.collector.outDir), ctxFile(role)),
    metaFile: join(home(config.collector.outDir), META_FILE),
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
  if (tool === "ArtifactData") return artifactData(t, spec, session, read);
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

function artifactData(t, spec, session, read) {
  if (t.url !== spec.url) return "ArtifactData: this board only";
  const pads = scratchpads(spec, session);
  const inPad = (dir, name) => pads.some((p) => dir === `${p}/${name}`);
  const write = ["action", "url", "collection", "doc_id", "file_path", "if_version"];
  const keys = { list: ["action", "url", "collection", "query", "out_dir"], query: ["action", "url", "collection", "query", "out_dir"], get: ["action", "url", "collection", "doc_id", "out_dir"], set: write, update: write }[t.action];
  if (!keys) return `ArtifactData: ${String(t.action)} is not one of the steps`;
  const extra = onlyKeys(t, keys);
  if (extra.length) return `ArtifactData: unexpected ${extra.join(", ")}`;
  if (t.action === "list" || t.action === "query") {
    if (!EXPORT_COLLECTIONS.includes(t.collection)) return "ArtifactData: only the exported collections";
    if (t.query !== undefined && !(plain(t.query) && onlyKeys(t.query, [...QUERY_KEYS]).length === 0)) return "ArtifactData: query takes limit, cursor, where and order_by only";
    if (!inPad(t.out_dir, EXPORT_NAME)) return `ArtifactData: export into this session's scratchpad + /${EXPORT_NAME} only`;
    return null;
  }
  if (t.if_version !== undefined && !Number.isInteger(t.if_version)) return "ArtifactData: if_version a whole number";
  if (t.collection === "ctx" || (t.collection === "meta" && t.doc_id === "context")) return memoryWrite(t, spec, pads, read);
  if (t.collection !== "derived" || t.doc_id !== "all") return "ArtifactData: derived/all only";
  if (t.action === "update") return "ArtifactData: derived/all: set only";
  if (t.action === "get") return inPad(t.out_dir, "derived-version") ? null : "ArtifactData: get into this session's scratchpad + /derived-version only";
  if (t.file_path !== spec.derivedFile) return "ArtifactData: set derived/all from the collector's output file only";
  return null;
}

// ctx/<Role> set and meta/context update, each from its own file in collector.outDir, whose content is checked too; and
// the get of meta/context into the scratchpad for its version.
function memoryWrite(t, spec, pads, read) {
  if (!spec.roles.length) return "ArtifactData: collector.contextRoles is empty";
  const meta = t.collection === "meta";
  if (t.action === "get") return meta && pads.some((p) => t.out_dir === `${p}/context-version`) ? null : "ArtifactData: get meta/context into this session's scratchpad + /context-version only";
  if (meta ? t.action !== "update" : t.action !== "set") return meta ? "ArtifactData: meta/context: update only" : "ArtifactData: ctx/<Role>: set only";
  if (!meta && !spec.roles.includes(t.doc_id)) return `ArtifactData: ctx/${t.doc_id} is not in collector.contextRoles`;
  if (t.file_path !== (meta ? spec.metaFile : spec.ctxFile(t.doc_id))) return "ArtifactData: a memory write comes from its own file in collector.outDir only";
  let data;
  try { data = read(t.file_path); } catch { return "ArtifactData: can't read the memory file"; }
  const errs = contextWriteErrors({ op: t.action, collection: t.collection, doc_id: t.doc_id, data }, spec.roles, spec.now);
  return errs.length ? `ArtifactData: ${errs.join("; ")}` : null;
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
  const spec = fenceSpec({ config, configPath, install, current: currentLink(install), sendTo: opt("--send-to"), uid: process.getuid(), usageIds: Object.values(plan?.roles ?? {}) });
  return decide(JSON.parse(stdin), spec);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let reason;
  try { reason = main(process.argv.slice(2), readFileSync(0, "utf8")); } catch (e) { reason = `fence error: ${e?.message ?? e}`; }
  if (reason) { process.stderr.write(`Refused by the collector's fence: ${reason}. Stop the run and tell the lead.\n`); process.exit(2); }
  process.exit(0);
}
