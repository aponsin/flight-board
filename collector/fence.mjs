// The collector's fence, a PreToolUse hook on every tool (matcher "*") for the collector's scheduled run only, in the
// state folder's settings: node <pinned install>/collector/fence.mjs --config <board.config.json> || exit 2
// The same file is the PostToolUse hook of the board's read tools (db_list, db_query, db_get): it records what the board
// answered, in the run's scratchpad, so the model copies nothing (#C656, Security R1).
// It lets through exactly the calls collector/TASK.md's steps make and refuses everything else (exit 2), whatever the
// permission mode decides: a run in auto mode can't be steered by board text into any other call (Security). It never
// grants in one case only: a db_write of derived/all carrying the placeholder {"fromFile": true} (#C668) is answered with
// permissionDecision "allow" and updatedInput (the probe's file in the placeholder's place), after decide passed the whole call;
// every other call gets no answer but a refusal (exit 2) or silence (exit 0), so the settings alone decide it. Whether a settings
// deny rule still beats a hook's allow depends on the app's version (Security checks it). Any failure refuses (the "|| exit 2" covers a
// crash or a missing file, which a hook would otherwise let pass). Paths and links compare as exact strings.
import { readFileSync, readlinkSync, existsSync, mkdirSync, writeFileSync, renameSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { EXPORT_NAME, READ_COLLECTIONS, CURSOR, DOC_ID, CALLS_DIR, FAILED_FILE } from "./export.mjs";

// The most the run may publish as derived/all.
export const DERIVED_MAX = 200 * 1024;
const SESSION = /^[A-Za-z0-9_-]{1,100}$/;
const FREE = new Set(["ToolSearch", "mcp__ccd_turn__update_plan", "mcp__ccd_turn__wrap_up"]);
// The claude-artifacts server's tools the run may call, on the board's own slug only (#C655).
export const AD_TOOL = "ArtifactData"; // the app's own database tool, taken by the same steps (#C710)
export const DB_TOOLS = { list: "mcp__claude-artifacts__db_list", query: "mcp__claude-artifacts__db_query", get: "mcp__claude-artifacts__db_get", write: "mcp__claude-artifacts__db_write" };
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
// task's prompt types it.
export function fenceSpec({ config, configPath, install, current = null, uid }) {
  const id = boardId(config);
  if (!id) throw new Error("the config has no board link");
  if (!config.collector.outDir) throw new Error("collector.outDir is empty");
  if (!config.artifactSlug) throw new Error("the config has no artifactSlug");
  const commands = [install, current].filter(Boolean).flatMap((dir) => {
    const collect = `node ${dir}/collector/collect.mjs --config ${configPath}`;
    return [`${collect} --prepare`, collect];
  });
  return {
    slug: config.artifactSlug,
    url: config.artifactUrl,
    cwd: join(home(config.gate.stateDir), id),
    commands,
    derivedFile: join(home(config.collector.outDir), "derived-all.json"),
    uid,
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
// and the probe's derived-all.json a db_write must equal.
export function decide(input, spec, read = readJson, mtime = mtimeMs, now = Date.now) {
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
  if (Object.values(DB_TOOLS).includes(tool)) return dbCall(tool, t, spec, read, mtime, now);
  if (tool === AD_TOOL) return adCall(t, spec, read, mtime, now);
  if (tool === "Read") {
    // The one file the run publishes: the probe's derived-all.json, so it can copy it into the db_write below.
    const extra = onlyKeys(t, ["file_path", "offset", "limit", "allow_large"]);
    if (extra.length) return `Read: unexpected ${extra.join(", ")}`;
    return t.file_path === spec.derivedFile ? null : "Read: the collector's derived-all.json only";
  }
  return `${String(tool)}: not one of the collector's steps`;
}

// The board's database tools (#C655), on the board's own slug and nothing else. db_list and db_query read an exported
// collection: one page (limit up to 1000) at the cursor the plan or the last page gave; db_query only with one condition,
// "at" or "updatedAt" at or after a time, as the plan wrote it. db_get reads derived/all (its version); db_write sets
// derived/all, one document, inline, at most DERIVED_MAX bytes. Nothing else: no delete, no merge, no other path.
function dbCall(tool, t, spec, read, mtime, now) {
  if (t.slug !== spec.slug) return "the board database: this board only";
  if (tool === DB_TOOLS.get) {
    const extra = onlyKeys(t, ["slug", "path"]);
    if (extra.length) return `db_get: unexpected ${extra.join(", ")}`;
    return t.path === "derived/all" ? null : "db_get: derived/all only";
  }
  if (tool === DB_TOOLS.write) return dbWrite(t, spec, read, mtime, now);
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

// ArtifactData (#C710): the app's own database tool, which the scheduled run was given in place of the db_* tools. The same steps
// and limits, on the board's own link (spec.url, exactly): list / query of an exported collection (query.limit 1 to 1000,
// query.cursor of the board's characters, query.where one condition, "at" or "updatedAt" at or after a time), get of derived/all,
// and set of derived/all from the probe's own derived-all.json (file_path, exactly that path; if_version a whole number). No
// out_dir (the PostToolUse hook records the answer), no inline data, no order_by, no other action.
function adCall(t, spec, read, mtime, now) {
  if (t.url !== spec.url) return "ArtifactData: this board only";
  const keys = { get: ["url", "action", "collection", "doc_id"], set: ["url", "action", "collection", "doc_id", "file_path", "if_version"], list: ["url", "action", "collection", "query"], query: ["url", "action", "collection", "query"] }[t.action];
  if (!keys) return `ArtifactData: ${String(t.action)} is not one of the collector's steps`;
  const extra = onlyKeys(t, keys);
  if (extra.length) return `ArtifactData ${t.action}: unexpected ${extra.join(", ")}`;
  if (t.action === "get" || t.action === "set") {
    if (t.collection !== "derived" || t.doc_id !== "all") return `ArtifactData ${t.action}: derived/all only`;
    if (t.action === "get") return null;
    if (t.if_version !== undefined && !(Number.isInteger(t.if_version) && t.if_version >= 1)) return "ArtifactData set: if_version a whole number";
    if (t.file_path !== spec.derivedFile) return "ArtifactData set: derived/all from the collector's derived-all.json only";
    let file;
    try { file = read(spec.derivedFile); } catch { return "ArtifactData set: can't read the collector's derived-all.json"; }
    if (!plain(file)) return "ArtifactData set: the collector's derived-all.json is an object";
    if (Buffer.byteLength(JSON.stringify(file), "utf8") > DERIVED_MAX) return `ArtifactData set: derived/all at most ${DERIVED_MAX} bytes`;
    const stale = staleReason(spec, mtime, now);
    return stale ? stale.replace(/^db_write/, "ArtifactData set") : null;
  }
  if (!READ_COLLECTIONS.includes(t.collection)) return "ArtifactData: only the exported collections";
  const q = t.query;
  if (!plain(q)) return `ArtifactData ${t.action}: query takes limit, cursor${t.action === "query" ? " and where" : ""}`;
  const bad = onlyKeys(q, t.action === "query" ? ["limit", "cursor", "where"] : ["limit", "cursor"]);
  if (bad.length) return `ArtifactData ${t.action}: query has ${bad.join(", ")}`;
  if (!(Number.isInteger(q.limit) && q.limit >= 1 && q.limit <= 1000)) return "ArtifactData: query.limit a whole number from 1 to 1000";
  if (q.cursor !== undefined && !(typeof q.cursor === "string" && CURSOR.test(q.cursor))) return "ArtifactData: query.cursor as the board gave it";
  if (q.where !== undefined && !whereOk(q.where)) return 'ArtifactData query: where is one condition, ["at" or "updatedAt", ">=", a time]';
  return null;
}
const whereOk = (w) => Array.isArray(w) && w.length === 1 && Array.isArray(w[0]) && w[0].length === 3 && ["at", "updatedAt"].includes(w[0][0]) && w[0][1] === ">=" && Number.isFinite(w[0][2]) && w[0][2] >= 0;

// The same value whatever the order of an object's keys (the copy typed into the write may reorder them).
const canon = (v) => (Array.isArray(v) ? v.map(canon) : plain(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

// #C668: the run does not retype the summary (about 30 KB, and about one run in five broke it). Its db_write carries the
// placeholder {"fromFile": true} and this fence, which is also the call's PreToolUse hook, puts the probe's derived-all.json in
// its place (rewriteOf, answered to the app as updatedInput). The placeholder is taken only while that file is the probe's recent
// derive: not more than FRESH_MAX_MS old and not dated in the future, and only in a run whose --prepare wrote the plan
// (export-since.json), so the placeholder can never publish an old summary. It is NOT required to be newer than the plan: the
// probe derives after it has merged this run's export, which is after the run reaches this step (merge, then about 25 s of derive),
// so such a file cannot exist yet and every run stopped here (#C668 fix). The probe derives at least every ten minutes, so a live
// probe leaves a file well inside the window; a dead one leaves it to age out and the run stops, loudly. The published summary is
// the probe's last derive as of the run, up to one run older than the mirror (TASK.md). A typed copy that equals the file is
// still taken, as before.
export const PLACEHOLDER = { fromFile: true };
export const FRESH_MAX_MS = 30 * 60e3;
export const FUTURE_MAX_MS = 60e3;
const isPlaceholder = (d) => plain(d) && Object.keys(d).length === 1 && d.fromFile === true;
const mtimeMs = (p) => statSync(p).mtimeMs;
function staleReason(spec, mtime, now) {
  let file;
  try { file = mtime(spec.derivedFile); mtime(join(spec.cwd, "export-since.json")); } catch { return "db_write: can't date the collector's derived-all.json, or this run has no plan (export-since.json)"; }
  const age = now() - file;
  if (age > FRESH_MAX_MS) return `db_write: the collector's derived-all.json is more than ${FRESH_MAX_MS / 60e3} minutes old`;
  if (age < -FUTURE_MAX_MS) return "db_write: the collector's derived-all.json is dated in the future";
  return null;
}
// The call with the placeholder replaced by the file, or null when the call carries none (decide has already passed it).
// It reads through the same `read` decide used; main passes a reader that reads the file once, so the object sent is the one checked.
export function rewriteOf(input, spec, read = readJson) {
  if (input?.tool_name !== DB_TOOLS.write) return null;
  const op = input?.tool_input?.ops?.[0];
  if (!op || !isPlaceholder(op.data)) return null;
  const file = read(spec.derivedFile);
  return { ...input.tool_input, ops: [{ ...op, data: file }] };
}

function dbWrite(t, spec, read, mtime, now) {
  const extra = onlyKeys(t, ["slug", "ops"]);
  if (extra.length) return `db_write: unexpected ${extra.join(", ")}`;
  if (!Array.isArray(t.ops) || t.ops.length !== 1 || !plain(t.ops[0])) return "db_write: one operation";
  const op = t.ops[0];
  const bad = onlyKeys(op, ["op", "path", "data", "ifVersion"]);
  if (bad.length) return `db_write: unexpected ${bad.join(", ")}`;
  if (op.op !== "set" || op.path !== "derived/all") return "db_write: set derived/all only";
  if (op.ifVersion !== undefined && !(Number.isInteger(op.ifVersion) && op.ifVersion >= 1)) return "db_write: ifVersion a whole number";
  if (isPlaceholder(op.data)) {
    let file;
    try { file = read(spec.derivedFile); } catch { return "db_write: can't read the collector's derived-all.json"; }
    if (!plain(file)) return "db_write: the collector's derived-all.json is an object";
    if (Buffer.byteLength(JSON.stringify(file), "utf8") > DERIVED_MAX) return `db_write: derived/all at most ${DERIVED_MAX} bytes`;
    return staleReason(spec, mtime, now);
  }
  if (!plain(op.data)) return "db_write: derived/all is an object";
  if (Buffer.byteLength(JSON.stringify(op.data), "utf8") > DERIVED_MAX) return `db_write: derived/all at most ${DERIVED_MAX} bytes`;
  // What goes to the board is the probe's file, whole: nothing typed into it, nothing left out.
  let file;
  try { file = read(spec.derivedFile); } catch { return "db_write: can't read the collector's derived-all.json"; }
  return JSON.stringify(canon(file)) === JSON.stringify(canon(op.data)) ? null : "db_write: derived/all must be exactly the collector's derived-all.json";
}

// What the board answered (#C656, Security R1). The run reads the board with db_list, db_query and db_get, and a model that
// retyped what it read into a file would put its own errors, or an injected line, into the mirror the gate trusts (an owner's
// message relabelled, an answered ask dropped). So the model copies nothing: this file is also the PostToolUse hook of those
// three tools, and it records the answer itself, from tool_response, in the run's scratchpad. The probe takes the documents from
// those records (collector/delta.mjs ingestCalls) and the model cannot write a file at all.
//
// The text the tool answers with: a summary object, then the documents between <untrusted-document-NAME> tags, one JSON object a
// line, NAME random for each answer, so only the closing tag with the same NAME ends the data (a document that contains a
// closing tag of another name is still data). An answer that does not parse whole, whose count is not the documents it holds,
// or that holds a document without its data (one too large to send) is no record: the probe then has nothing to take.
const texts = (v, out = [], depth = 0) => {
  if (typeof v === "string") out.push(v);
  else if (depth < 6 && Array.isArray(v)) for (const x of v) texts(x, out, depth + 1);
  else if (depth < 6 && plain(v)) for (const k of ["text", "content", "result", "output"]) if (k in v) texts(v[k], out, depth + 1);
  return out;
};
export function parseAnswer(response, kind) {
  const all = texts(response).join("\n");
  const open = /<untrusted-document-([A-Za-z0-9]+)>/.exec(all);
  const head = (open ? all.slice(0, open.index) : all).trim();
  let summary;
  try { summary = JSON.parse(head); } catch { return { error: "the summary is not JSON" }; }
  if (!plain(summary)) return { error: "the summary is not an object" };
  const docs = [];
  if (open) {
    const close = `</untrusted-document-${open[1]}>`;
    const start = open.index + open[0].length, end = all.indexOf(close, start);
    if (end < 0) return { error: "no closing tag" };
    for (const line of all.slice(start, end).split("\n")) {
      if (!line.trim()) continue;
      let d;
      try { d = JSON.parse(line); } catch { return { error: "a document is not JSON" }; }
      docs.push(d);
    }
  }
  if (kind === "get") {
    if (summary.exists === false) return { version: null };
    if (!Number.isInteger(summary.version) || summary.version < 1) return { error: "no version" };
    return { version: summary.version };
  }
  // The board answers a query that matches nothing with the bare {"docs": [], "nextCursor": ""}: no count and no tagged block. That
  // shape, and only that (an empty docs list, nothing else in it, no block), is the empty answer; any other bare shape is no record.
  const bareEmpty = !open && summary.count === undefined && Array.isArray(summary.docs) && summary.docs.length === 0
    && Object.keys(summary).every((k) => k === "docs" || k === "nextCursor");
  if (!bareEmpty && (!Number.isInteger(summary.count) || summary.count !== docs.length)) return { error: "the count is not the documents" };
  const next = summary.nextCursor === undefined || summary.nextCursor === "" ? null : summary.nextCursor;
  if (next !== null && !(typeof next === "string" && CURSOR.test(next))) return { error: "the next cursor is not the board's characters" };
  const out = [];
  for (const d of docs) {
    if (!plain(d) || typeof d.id !== "string" || !DOC_ID.test(d.id) || !plain(d.data)) return { error: "a document has no id or no data" };
    out.push({ id: d.id, data: d.data });
  }
  return { docs: out, next };
}

// ArtifactData's answer (#C710): a line "N document(s) from collection "X":", then the documents between
// "=== BEGIN ARTIFACT DB <NAME> ..." and "=== END ARTIFACT DB <NAME> ===" (one JSON object a line, {id, data, version, updatedAt},
// NAME random for each answer), then, when more pages exist, a line `next_cursor: "<token>" ...`. "No documents matched ..." is an
// empty page and `No document "<id>" ...` is a get of nothing. Anything that does not parse whole, or whose count or collection is
// not what the call asked for, is no record.
export function parseAdAnswer(response, kind, collection) {
  const all = texts(response).join("\n");
  if (kind === "get" && /^No document "/.test(all.trim())) return { version: null };
  if (kind !== "get" && new RegExp(`^No documents matched in collection "${collection}"\\.\\s*$`).test(all.trim())) return { docs: [], next: null };
  const open = /^=== BEGIN ARTIFACT DB ([0-9a-f]{8}) [^\n]*===$/m.exec(all);
  if (!open) return { error: "no document block" };
  const head = /^(\d+) documents? from collection "([^"]+)":$/m.exec(all.slice(0, open.index));
  if (!head || head[2] !== collection) return { error: "the answer is not for this collection" };
  const close = `=== END ARTIFACT DB ${open[1]} ===`;
  const start = open.index + open[0].length, end = all.indexOf(`\n${close}`, start);
  if (end < 0) return { error: "no closing marker" };
  const docs = [];
  for (const line of all.slice(start, end).split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { return { error: "a document is not JSON" }; }
    docs.push(d);
  }
  if (Number(head[1]) !== docs.length) return { error: "the count is not the documents" };
  if (kind === "get") {
    if (docs.length !== 1 || !Number.isInteger(docs[0]?.version) || docs[0].version < 1) return { error: "no version" };
    return { version: docs[0].version };
  }
  const tail = all.slice(end + close.length + 1);
  const m = /^next_cursor: "([^"]*)"/m.exec(tail);
  const next = m ? m[1] : null;
  if (next !== null && !CURSOR.test(next)) return { error: "the next cursor is not the board's characters" };
  const out = [];
  for (const d of docs) {
    if (!plain(d) || typeof d.id !== "string" || !DOC_ID.test(d.id) || !plain(d.data)) return { error: "a document has no id or no data" };
    out.push({ id: d.id, data: d.data });
  }
  return { docs: out, next };
}

// The file a PostToolUse hook writes for one answer, or an error. kind of the tool: list, query or get. The seal is the answer
// to db_get of derived/all: the run reads it last, so its file is the newest.
export function captureOf(input, spec, token) {
  const { tool_name: tool, tool_input: t, session_id: session } = input;
  const ad = tool === AD_TOOL;
  const kind = ad ? t?.action : Object.entries(DB_TOOLS).find(([, v]) => v === tool)?.[0];
  if (!["list", "query", "get"].includes(kind)) return { skip: true };
  // Any failure leaves a FAILED marker beside the records (when the run's folder can be told): the export is then not sealed, so
  // the probe never merges a delta that is missing a page (Security F1).
  let base = null;
  try { const pad = SESSION.test(String(session ?? "")) ? scratchpads(spec, session)[0] : null; if (pad) base = `${pad}/${EXPORT_NAME}`; } catch { /* no folder to mark */ }
  const fail = (error) => ({ error, ...(base ? { failed: `${base}/${CALLS_DIR}/${FAILED_FILE}` } : {}) });
  const why = decide(input, spec);
  if (why) return fail(why);
  const a = ad ? parseAdAnswer(input.tool_response, kind, t.collection) : parseAnswer(input.tool_response, kind);
  if (a.error) return fail(a.error);
  if (!base) return fail("no folder for the run");
  if (kind === "get") return { path: `${base}/derived/all.json`, content: JSON.stringify({ version: a.version }) };
  // The record has one shape whichever tool made it: ArtifactData's [[field, op, value]] is written as db_query's [{field, op, value}].
  const limit = ad ? t.query.limit : t.limit, cursor = ad ? t.query.cursor : t.cursor;
  const w = ad ? t.query.where : t.where;
  const where = kind === "query" ? (ad && w ? w.map(([field, op, value]) => ({ field, op, value })) : w ?? null) : null;
  const record = { tool: kind, collection: t.collection, limit, cursor: cursor ?? null, where, docs: a.docs, next: a.next };
  return { path: `${base}/${CALLS_DIR}/${token}.json`, content: JSON.stringify(record) };
}

function save(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.part`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

// What a failed capture leaves for the lead to read (#C660): the raw tool_response with every string cut so a document line is
// at most LINE_MAX characters and the whole at most RESPONSE_MAX, the structure kept (so the shape of the app's answer shows),
// plus the tool, its input (cut the same way) and the error. The file sits in the task's folder, which the run's Read deny
// covers, so the model never sees it; one file, overwritten by the next failure.
export const PARSE_FAILURE_FILE = "hook-parse-failure.json";
export const LINE_MAX = 80, RESPONSE_MAX = 4000, INPUT_MAX = 1000;
export function cut(value, max) {
  let left = max;
  const walk = (v, depth) => {
    if (typeof v === "string") {
      const lines = v.split("\n").map((l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l));
      let s = lines.join("\n");
      if (s.length > left) s = `${s.slice(0, Math.max(left, 0))}…`;
      left -= s.length;
      return s;
    }
    if (v === null || typeof v !== "object") return v;
    if (depth >= 8) return "…";
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.slice(0, LINE_MAX), walk(x, depth + 1)]));
  };
  return walk(value, 0);
}
export function parseFailureRecord(input, error) {
  return JSON.stringify({ tool: String(input?.tool_name ?? "").slice(0, LINE_MAX), error: String(error).slice(0, 200), tool_input: cut(input?.tool_input, INPUT_MAX), tool_response: cut(input?.tool_response, RESPONSE_MAX) });
}
// Never throws: a failure to write leaves the hook's answer as it was.
export function recordParseFailure(spec, input, error) {
  try {
    const path = join(spec.cwd, PARSE_FAILURE_FILE), tmp = `${path}.${process.pid}.part`;
    writeFileSync(tmp, parseFailureRecord(input, error), { mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* the refusal below still stops the run */ }
}

// The hook: read the call, decide, refuse with exit 2. Every failure on the way refuses too. A PostToolUse call records the answer.
export function main(argv, stdin) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const configPath = opt("--config");
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  const problems = checkConfig(raw);
  if (problems.length) throw new Error(problems.join("; "));
  const install = dirname(dirname(fileURLToPath(import.meta.url)));
  const config = fullConfig(raw);
  const spec = fenceSpec({ config, configPath, install, current: currentLink(install), uid: process.getuid() });
  const input = JSON.parse(stdin);
  if (input?.hook_event_name === "PostToolUse") {
    const r = captureOf(input, spec, `${Date.now()}-${randomBytes(4).toString("hex")}`);
    if (r.error) { recordParseFailure(spec, input, r.error); if (r.failed) { try { save(r.failed, "failed"); } catch { /* the refusal below still stops the run */ } } return `could not record the board's answer: ${r.error}`; }
    if (r.path) save(r.path, r.content);
    return null;
  }
  const read = readOnce();
  const why = decide(input, spec, read);
  if (why) return why;
  const updatedInput = rewriteOf(input, spec, read);
  return updatedInput ? { updatedInput } : null;
}

// A reader that reads each path once and gives the same object again: decide's checks and the copy sent are one read (#C668, Checker 3).
export function readOnce(read = readJson) {
  const seen = new Map();
  return (p) => { if (!seen.has(p)) seen.set(p, read(p)); return seen.get(p); };
}

// The answer to the app for a call whose placeholder the fence filled in: allow it, as rewritten (#C668).
export const allowAs = (updatedInput) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput } });

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let reason;
  try { reason = main(process.argv.slice(2), readFileSync(0, "utf8")); } catch (e) { reason = `fence error: ${e?.message ?? e}`; }
  if (reason && typeof reason === "object") { process.stdout.write(`${allowAs(reason.updatedInput)}\n`); process.exit(0); }
  if (reason) { process.stderr.write(`Refused by the collector's fence: ${reason}. Stop the run and tell the lead.\n`); process.exit(2); }
  process.exit(0);
}
