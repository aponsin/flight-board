// The collector's fence (collector/fence.mjs): every call the collector's steps make passes; a near miss in any field is
// refused; any failure refuses. Fictional board, folders and sessions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { fenceSpec, scratchpads, decide, MESSAGE_MAX, PAGE_MAX, DERIVED_MAX, DB_TOOLS } from "../collector/fence.mjs";

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const SLUG = "11111111-2222-4333-8444-555555555555";
const raw = { artifactUrl: URL_, artifactSlug: SLUG, gate: { stateDir: "/srv/fb" }, collector: { repoPath: "/srv/repo", outDir: "/srv/fb/TestBoard01-out" } };
const config = fullConfig(raw);
const spec = fenceSpec({ config, configPath: "/srv/team/board.config.json", install: "/srv/fb/install/abc123", sendTo: "local_lead-1", uid: 501 });
const S = "sess-0001";
const PAD = "/private/tmp/claude-501/-srv-fb-TestBoard01/sess-0001/scratchpad";
const EXP = `${PAD}/flight-board-export`;
const DERIVED = "/srv/fb/TestBoard01-out/derived-all.json";
const doc = { cards: { a: { phase: "build" } }, at: 5 };
// The fence reads the probe's file through this; every other path is missing.
const read = (p) => { if (p !== DERIVED) throw new Error("no file"); return doc; };
const call = (tool_name, tool_input, over = {}) => ({ session_id: S, cwd: "/srv/fb/TestBoard01", hook_event_name: "PreToolUse", tool_name, tool_input, ...over });
const pass = (c, s = spec) => assert.equal(decide(c, s, read), null, JSON.stringify(c.tool_input));
const refused = (c, part, s = spec) => { const r = decide(c, s, read); assert.ok(r && r.includes(part), `"${part}" in: ${r}`); };
const PREP = "node /srv/fb/install/abc123/collector/collect.mjs --config /srv/team/board.config.json --prepare";
const RUN = "node /srv/fb/install/abc123/collector/collect.mjs --config /srv/team/board.config.json";
const list = (over = {}) => ({ slug: SLUG, collection: "waiting", limit: 100, ...over });
const query = (over = {}) => ({ slug: SLUG, collection: "steps", limit: 200, where: [{ field: "at", op: ">=", value: 1793700000000 }], ...over });
const setAll = (over = {}) => ({ slug: SLUG, ops: [{ op: "set", path: "derived/all", data: doc, ifVersion: 2, ...over }] });
const page = (docs = [{ id: "a", data: { name: "a" } }]) => JSON.stringify({ docs });
const write = (file_path, content, over = {}) => call("Write", { file_path, content, ...over });

test("the spec comes from the config and the fence's own command line; the scratchpad has exactly two spellings", () => {
  assert.deepEqual(spec.commands, [PREP, RUN]);
  assert.equal(spec.cwd, "/srv/fb/TestBoard01");
  assert.equal(spec.slug, SLUG);
  assert.equal(spec.derivedFile, DERIVED);
  assert.deepEqual(scratchpads(spec, S), [PAD, "/tmp/claude-501/-srv-fb-TestBoard01/sess-0001/scratchpad"]);
  assert.throws(() => fenceSpec({ config: fullConfig({}), configPath: "/c", install: "/i", sendTo: "x", uid: 1 }), /board link/);
  assert.throws(() => fenceSpec({ config, configPath: "/c", install: "/i", sendTo: "a b", uid: 1 }), /--send-to/);
  assert.throws(() => fenceSpec({ config: fullConfig({ artifactUrl: URL_, artifactSlug: SLUG }), configPath: "/c", install: "/i", sendTo: "x", uid: 1 }), /outDir/);
  assert.throws(() => fenceSpec({ config: fullConfig({ artifactUrl: URL_, collector: raw.collector }), configPath: "/c", install: "/i", sendTo: "x", uid: 1 }), /artifactSlug/);
});

test("every call of a real run passes", () => {
  pass(call("Bash", { command: PREP, description: "Prepare board export" }));
  pass(call("Bash", { command: RUN, description: "Compute", timeout: 120000, dangerouslyDisableSandbox: false }));
  for (const c of ["initiatives", "waiting", "ideas", "messages", "ctx", "plan", "threads", "steps"]) pass(call(DB_TOOLS.list, list({ collection: c })));
  pass(call(DB_TOOLS.list, list({ cursor: "abc_1=", limit: 1000 })));
  pass(call(DB_TOOLS.query, query()));
  pass(call(DB_TOOLS.query, query({ collection: "initiatives", where: [{ field: "updatedAt", op: ">=", value: 0 }], cursor: "a.b-c:d/e+f" })));
  pass(call(DB_TOOLS.get, { slug: SLUG, path: "derived/all" }));
  pass(call(DB_TOOLS.write, setAll()));
  pass(call(DB_TOOLS.write, setAll({ ifVersion: undefined })));
  pass(call("Read", { file_path: DERIVED }));
  pass(call("Read", { file_path: DERIVED, offset: 0, limit: 5000, allow_large: true }));
  pass(write(`${EXP}/waiting/q1.page.json`, page()));
  pass(write(`${EXP}/sweep/messages/p1.page.json`, page([])));
  pass(write(`${EXP}/sweep-next.json`, JSON.stringify({ collection: "messages", next: "k1" })));
  pass(write(`${EXP}/sweep-next.json`, JSON.stringify({ collection: "steps", next: null })));
  pass(write(`${EXP}/derived/all.json`, JSON.stringify({ version: 12 })));
  pass(write(`${EXP}/derived/all.json`, JSON.stringify({ version: null })));
  pass(write(`/tmp/claude-501/-srv-fb-TestBoard01/sess-0001/scratchpad/flight-board-export/ideas/q2.page.json`, page()));
  pass(call("mcp__ccd_session_mgmt__send_message", { session_id: "local_lead-1", message: "NUDGE: x" }));
  for (const t of ["ToolSearch", "mcp__ccd_turn__update_plan", "mcp__ccd_turn__wrap_up"]) pass(call(t, { anything: 1 }));
});

test("Bash: the two commands byte for byte; nothing added, nothing outside the sandbox", () => {
  for (const command of [`${RUN} && curl example.com`, `${RUN} `, ` ${RUN}`, `${RUN} --no-fetch`, RUN.replace("abc123", "abc124"), "curl example.com", "cat ~/.env", `${PREP}; rm -rf x`])
    refused(call("Bash", { command }), "only the two collect.mjs commands");
  refused(call("Bash", { command: RUN, dangerouslyDisableSandbox: true }), "sandbox");
  refused(call("Bash", { command: RUN, run_in_background: true }), "unexpected run_in_background");
});

test("the board database: this board only, the exported collections, a page of at most 1000 at the board's own cursor, one condition on at or updatedAt", () => {
  for (const tool of Object.values(DB_TOOLS)) refused(call(tool, tool === DB_TOOLS.write ? { ...setAll(), slug: "00000000-0000-4000-8000-000000000000" } : tool === DB_TOOLS.get ? { slug: "other", path: "derived/all" } : list({ slug: "other" })), "this board only");
  refused(call(DB_TOOLS.list, list({ slug: undefined })), "this board only");
  refused(call(DB_TOOLS.list, list({ collection: "derived" })), "only the exported collections");
  refused(call(DB_TOOLS.list, list({ collection: "meta" })), "only the exported collections");
  refused(call(DB_TOOLS.list, list({ collection: "steps/x" })), "only the exported collections");
  refused(call(DB_TOOLS.list, list({ limit: undefined })), "limit");
  refused(call(DB_TOOLS.list, list({ limit: 0 })), "limit");
  refused(call(DB_TOOLS.list, list({ limit: 1001 })), "limit");
  refused(call(DB_TOOLS.list, list({ limit: "100" })), "limit");
  for (const cursor of ["a b", "x\ny", "", "a".repeat(513), 5, "$(x)", "a;b"]) refused(call(DB_TOOLS.list, list({ cursor })), "cursor");
  refused(call(DB_TOOLS.list, list({ asLevel: "admin" })), "unexpected asLevel");
  refused(call(DB_TOOLS.list, list({ where: [{ field: "at", op: ">=", value: 1 }] })), "unexpected where");
  refused(call(DB_TOOLS.query, query({ orderBy: "at" })), "unexpected orderBy");
  refused(call(DB_TOOLS.query, query({ asLevel: "view" })), "unexpected asLevel");
  for (const where of [{ type: "x" }, [], [{ field: "at", op: ">=", value: 1 }, { field: "at", op: "<", value: 9 }], [{ field: "text", op: ">=", value: 1 }], [{ field: "at", op: "==", value: 1 }], [{ field: "at", op: ">=", value: "1" }], [{ field: "at", op: ">=", value: -1 }], [{ field: "at", op: ">=", value: 1, extra: 1 }], [["at", ">=", 1]]])
    refused(call(DB_TOOLS.query, query({ where })), "where is one condition", spec);
  refused(call(DB_TOOLS.get, { slug: SLUG, path: "waiting/x" }), "derived/all only");
  refused(call(DB_TOOLS.get, { slug: SLUG, path: "derived/all", asLevel: "view" }), "unexpected asLevel");
});

test("db_write: set derived/all, one operation, the probe's file exactly, at most DERIVED_MAX bytes; nothing else", () => {
  refused(call(DB_TOOLS.write, { slug: SLUG, ops: [] }), "one operation");
  refused(call(DB_TOOLS.write, { slug: SLUG, ops: [setAll().ops[0], setAll().ops[0]] }), "one operation");
  refused(call(DB_TOOLS.write, { ...setAll(), idempotencyKey: "abc" }), "unexpected idempotencyKey");
  refused(call(DB_TOOLS.write, { ...setAll(), asLevel: "admin" }), "unexpected asLevel");
  for (const op of ["merge", "update", "delete"]) refused(call(DB_TOOLS.write, setAll({ op })), "set derived/all only");
  for (const path of ["derived/other", "waiting/x", "ctx/Manager", "meta/context", "derived/all/x"]) refused(call(DB_TOOLS.write, setAll({ path })), "set derived/all only");
  refused(call(DB_TOOLS.write, setAll({ ifVersion: "2" })), "whole number");
  refused(call(DB_TOOLS.write, setAll({ ifVersion: 0 })), "whole number");
  refused(call(DB_TOOLS.write, setAll({ extra: 1 })), "unexpected extra");
  refused(call(DB_TOOLS.write, setAll({ data: [1] })), "an object");
  refused(call(DB_TOOLS.write, setAll({ data: undefined })), "an object");
  // The data must be what the probe wrote: a typo, an extra card, a missing one, an injected field are refused; key order is not.
  refused(call(DB_TOOLS.write, setAll({ data: { ...doc, at: 6 } })), "exactly the collector's derived-all.json");
  refused(call(DB_TOOLS.write, setAll({ data: { ...doc, planted: "x" } })), "exactly");
  refused(call(DB_TOOLS.write, setAll({ data: { cards: {}, at: 5 } })), "exactly");
  pass(call(DB_TOOLS.write, setAll({ data: { at: 5, cards: { a: { phase: "build" } } } })));
  // The file missing or unreadable: refused, never written blind.
  assert.match(decide(call(DB_TOOLS.write, setAll()), spec, () => { throw new Error("gone"); }), /can't read the collector's derived-all.json/);
  const big = { x: "y".repeat(DERIVED_MAX) };
  assert.equal(decide(call(DB_TOOLS.write, setAll({ data: big })), spec, () => big).includes(`${DERIVED_MAX} bytes`), true);
});

test("Write: only the export's pages, the sweep report and the seal, in this session's scratchpad, each by its shape", () => {
  const W = (path, content = page()) => write(path, content);
  // Where.
  refused(W(`${PAD}/other.json`), "this session's scratchpad + /flight-board-export only");
  refused(W(`${PAD}/flight-board-export/notes.txt`), "pages, sweep-next.json");
  refused(W(`${EXP}/waiting/q1.json`), "pages, sweep-next.json");
  refused(W(`${EXP}/waiting/q1.page.json.x`), "pages, sweep-next.json");
  refused(W(`${EXP}/derived/q1.page.json`), "pages, sweep-next.json");
  refused(W(`${EXP}/derived/other.json`), "pages, sweep-next.json");
  refused(W(`${EXP}/elsewhere/q1.page.json`), "pages, sweep-next.json");
  refused(W(`${EXP}/sweep/derived/p1.page.json`), "pages, sweep-next.json");
  refused(W(`${EXP}/sweep/waiting/deeper/p1.page.json`), "pages, sweep-next.json");
  refused(W(`${EXP}/sweep/p1.page.json`), "pages, sweep-next.json");
  refused(W(`${EXP}/waiting/../../x.page.json`), "pages, sweep-next.json");
  refused(W(`${EXP}/waiting/a b.page.json`), "pages, sweep-next.json");
  refused(W(`${EXP}/waiting/.page.json`), "pages, sweep-next.json");
  refused(W(`${EXP}/${"n".repeat(61)}/x.page.json`), "pages, sweep-next.json");
  refused(W(`${PAD.replace("sess-0001", "sess-0002")}/flight-board-export/waiting/q1.page.json`), "this session's scratchpad");
  refused(W("/srv/fb/TestBoard01/mirror/initiatives/x.json"), "this session's scratchpad");
  refused(W(`${EXP}x/waiting/q1.page.json`), "this session's scratchpad");
  refused(W("/Users/x/.claude/settings.json", "{}"), "this session's scratchpad");
  refused(call("Write", { file_path: `${EXP}/waiting/q1.page.json`, content: page(), extra: 1 }), "unexpected extra");
  refused(call("Write", { file_path: `${EXP}/waiting/q1.page.json` }), "a file_path and content");
  refused(call("Write", { content: page() }), "a file_path and content");
  refused(W(`${EXP}/waiting/q1.page.json`, "x".repeat(PAGE_MAX + 1)), `at most ${PAGE_MAX} bytes`);
  // What: a page is {docs: [{id, data}]}, nothing else.
  const bad = (content, part) => refused(W(`${EXP}/waiting/q1.page.json`, content), part);
  bad("{not json", "not JSON");
  bad("[]", "not an object");
  bad("null", "not an object");
  bad(JSON.stringify({ docs: [], extra: 1 }), "{docs: [...]} only");
  bad(JSON.stringify({ docs: {} }), "{docs: [...]} only");
  bad(JSON.stringify({ docs: Array.from({ length: 1001 }, (_, i) => ({ id: `d${i}`, data: {} })) }), "at most 1000");
  bad(JSON.stringify({ docs: ["x"] }), "{id, data} only");
  bad(JSON.stringify({ docs: [{ id: "a", data: {}, version: 3 }] }), "{id, data} only");
  bad(JSON.stringify({ docs: [{ id: "../a", data: {} }] }), "a document id");
  bad(JSON.stringify({ docs: [{ id: "a b", data: {} }] }), "a document id");
  bad(JSON.stringify({ docs: [{ id: 7, data: {} }] }), "a document id");
  bad(JSON.stringify({ docs: [{ id: "a", data: [1] }] }), "data is an object");
  bad(JSON.stringify({ docs: [{ id: "a", data: "x" }] }), "data is an object");
  bad(JSON.stringify({ docs: [{ id: "a" }] }), "data is an object");
  pass(W(`${EXP}/waiting/q1.page.json`, JSON.stringify({ docs: Array.from({ length: 1000 }, (_, i) => ({ id: `d${i}`, data: { n: i } })) })));
  // The report: {collection, next}.
  const rep = (content, part) => refused(W(`${EXP}/sweep-next.json`, content), part);
  rep(JSON.stringify({ collection: "waiting" }), "{collection, next} only");
  rep(JSON.stringify({ collection: "waiting", next: null, x: 1 }), "{collection, next} only");
  rep(JSON.stringify({ collection: "derived", next: null }), "an exported one");
  rep(JSON.stringify({ collection: "waiting", next: "a b" }), "null or the board's cursor");
  rep(JSON.stringify({ collection: "waiting", next: 5 }), "null or the board's cursor");
  rep("[]", "not an object");
  // The seal: {version}.
  const seal = (content, part) => refused(W(`${EXP}/derived/all.json`, content), part);
  seal(JSON.stringify({ version: "3" }), "version");
  seal(JSON.stringify({ version: -1 }), "version");
  seal(JSON.stringify({ version: 1.5 }), "version");
  seal(JSON.stringify({}), "{version} only");
  seal(JSON.stringify({ version: 1, planted: "x" }), "{version} only");
});

test("memory readings (#C274): the session list and get_usage of a planned session only; the tiles are written by the roles, not by this run", () => {
  const on = fenceSpec({ config: fullConfig({ ...raw, collector: { ...raw.collector, contextRoles: ["Checker", "Manager"] } }), configPath: "/srv/team/board.config.json", install: "/srv/fb/install/abc123", sendTo: "local_lead-1", uid: 501, usageIds: ["local_c"] });
  const ok = (c) => assert.equal(decide(c, on, read), null, JSON.stringify(c.tool_input));
  const no = (c, part, s = on) => { const r = decide(c, s, read); assert.ok(r && r.includes(part), `"${part}" in: ${r}`); };
  ok(call("mcp__ccd_session_mgmt__list_sessions", { limit: 200 }));
  ok(call("mcp__ccd_session_mgmt__list_sessions", {}));
  ok(call("mcp__ccd_session_mgmt__get_usage", { session_id: "local_c" }));
  no(call("mcp__ccd_session_mgmt__list_sessions", { limit: 500 }), "limit");
  no(call("mcp__ccd_session_mgmt__list_sessions", { include_archived: true }), "unexpected include_archived");
  no(call("mcp__ccd_session_mgmt__get_usage", { session_id: "local_m" }), "a session --prepare planned");
  no(call("mcp__ccd_session_mgmt__get_usage", {}), "a session --prepare planned");
  no(call("mcp__ccd_session_mgmt__get_usage", { session_id: "local_c", x: 1 }), "unexpected x");
  // With no roles configured, none of it.
  no(call("mcp__ccd_session_mgmt__list_sessions", {}), "collector.contextRoles is empty", spec);
  // The old tool is gone for good, and writes to ctx and meta are not this run's.
  no(call("ArtifactData", { action: "list", url: URL_, collection: "waiting" }), "not one of the collector's steps");
  no(call(DB_TOOLS.write, { slug: SLUG, ops: [{ op: "set", path: "ctx/Checker", data: { pct: 1, at: 1 } }] }), "set derived/all only");
  no(call(DB_TOOLS.write, { slug: SLUG, ops: [{ op: "update", path: "meta/context", data: { agents: {} }, ifVersion: 9 }] }), "set derived/all only");
});

test("send_message: the lead's session only, the message capped; every other tool refused", () => {
  refused(call("mcp__ccd_session_mgmt__send_message", { session_id: "local_other", message: "x" }), "lead's session");
  refused(call("mcp__ccd_session_mgmt__send_message", { session_id: "local_lead-1", message: "x".repeat(MESSAGE_MAX + 1) }), "at most");
  refused(call("mcp__ccd_session_mgmt__send_message", { session_id: "local_lead-1", message: "" }), "a message");
  refused(call("mcp__ccd_session_mgmt__send_message", { session_id: "local_lead-1", message: "x", extra: 1 }), "unexpected extra");
  for (const tool of ["Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "SendMessage", "NotebookEdit", "mcp__scheduled-tasks__create_scheduled_task", "mcp__ccd_session_mgmt__stop_session", "mcp__other__thing", "mcp__claude-artifacts__db_delete", "mcp__claude-artifacts__publish_files", "mcp__claude-artifacts__db_str_replace", "ArtifactData", undefined])
    refused(call(tool, { file_path: "/x" }), "not one of the collector's steps");
});

test("Read: the probe's derived-all.json and nothing else", () => {
  for (const file_path of ["/srv/fb/TestBoard01-out/other.json", "/srv/fb/TestBoard01/mirror/initiatives/a.json", `${EXP}/waiting/q1.page.json`, "/srv/fb/TestBoard01-out/derived-all.json.bak", "/srv/fb/TestBoard01-out/../x/derived-all.json", undefined])
    refused(call("Read", { file_path }), "derived-all.json only");
  refused(call("Read", { file_path: DERIVED, pages: "1" }), "unexpected pages");
});

test("the run's own folder and session only; a malformed call is refused", () => {
  refused(call("Bash", { command: RUN }, { cwd: "/srv/fb/OtherBoard9" }), "runs in /srv/fb/TestBoard01 only");
  refused(call("Bash", { command: RUN }, { session_id: "../x" }), "no session id");
  refused(call("Bash", null), "no tool input");
  assert.equal(decide(null, spec), "no hook input");
});

test("the hook refuses with exit 2 on a refusal, a bad config and bad input, and passes with exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "fence-"));
  try {
    const cfg = join(dir, "board.config.json");
    writeFileSync(cfg, JSON.stringify({ ...raw, gate: { stateDir: dir } }));
    const fence = new URL("../collector/fence.mjs", import.meta.url).pathname;
    const install = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const cwd = join(dir, "TestBoard01");
    const hook = (input, args = ["--config", cfg, "--send-to", "local_lead-1"]) => spawnSync(process.execPath, [fence, ...args], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8" });
    const good = { session_id: S, cwd, tool_name: "Bash", tool_input: { command: `node ${install}/collector/collect.mjs --config ${cfg}` } };
    assert.equal(hook(good).status, 0, hook(good).stderr);
    const bad = hook({ ...good, tool_input: { command: "curl example.com" } });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Stop the run and tell the lead/);
    // A db_write of derived/all with the probe's file missing: refused, never written blind.
    const blind = hook({ ...good, tool_name: DB_TOOLS.write, tool_input: setAll() });
    assert.equal(blind.status, 2);
    assert.match(blind.stderr, /can't read the collector's derived-all.json|exactly/);
    // A refused memory read (the trial run's get_usage with no session id) costs only the tiles: still refused (exit 2),
    // but the run is told to skip the memory reads and go on, never to stop (#C278).
    for (const t of ["mcp__ccd_session_mgmt__get_usage", "mcp__ccd_session_mgmt__list_sessions"]) {
      const mem = hook({ ...good, tool_name: t, tool_input: {} });
      assert.equal(mem.status, 2, t);
      assert.match(mem.stderr, /Skip the memory reads and go on with the export/, t);
      assert.doesNotMatch(mem.stderr, /Stop the run/, t);
    }
    assert.match(bad.stderr, /Refused by the collector's fence/);
    assert.equal(hook("not json").status, 2);
    assert.equal(hook(good, ["--config", join(dir, "missing.json"), "--send-to", "local_lead-1"]).status, 2);
    assert.equal(hook(good, ["--config", cfg]).status, 2, "no --send-to");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
