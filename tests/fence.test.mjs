// The collector's fence (collector/fence.mjs): every call the collector's steps make passes; a near miss in any field is
// refused; any failure refuses. Fictional board, folders and sessions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { fenceSpec, scratchpads, decide, MESSAGE_MAX } from "../collector/fence.mjs";

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const raw = { artifactUrl: URL_, gate: { stateDir: "/srv/fb" }, collector: { repoPath: "/srv/repo", outDir: "/srv/fb/TestBoard01-out" } };
const config = fullConfig(raw);
const spec = fenceSpec({ config, configPath: "/srv/team/board.config.json", install: "/srv/fb/install/abc123", sendTo: "local_lead-1", uid: 501 });
const S = "sess-0001";
const PAD = "/private/tmp/claude-501/-srv-fb-TestBoard01/sess-0001/scratchpad";
const call = (tool_name, tool_input, over = {}) => ({ session_id: S, cwd: "/srv/fb/TestBoard01", hook_event_name: "PreToolUse", tool_name, tool_input, ...over });
const pass = (c) => assert.equal(decide(c, spec), null, JSON.stringify(c.tool_input));
const refused = (c, part) => { const r = decide(c, spec); assert.ok(r && r.includes(part), `"${part}" in: ${r}`); };
const PREP = "node /srv/fb/install/abc123/collector/collect.mjs --config /srv/team/board.config.json --prepare";
const RUN = "node /srv/fb/install/abc123/collector/collect.mjs --config /srv/team/board.config.json";
const exp = (over = {}) => ({ action: "list", url: URL_, collection: "waiting", query: { limit: 1000 }, out_dir: `${PAD}/flight-board-export`, ...over });
const setAll = (over = {}) => ({ action: "set", url: URL_, collection: "derived", doc_id: "all", file_path: "/srv/fb/TestBoard01-out/derived-all.json", if_version: 2, ...over });

test("the spec comes from the config and the fence's own command line; the scratchpad has exactly two spellings", () => {
  assert.deepEqual(spec.commands, [PREP, RUN]);
  assert.equal(spec.cwd, "/srv/fb/TestBoard01");
  assert.deepEqual(scratchpads(spec, S), [PAD, "/tmp/claude-501/-srv-fb-TestBoard01/sess-0001/scratchpad"]);
  assert.throws(() => fenceSpec({ config: fullConfig({}), configPath: "/c", install: "/i", sendTo: "x", uid: 1 }), /board link/);
  assert.throws(() => fenceSpec({ config, configPath: "/c", install: "/i", sendTo: "a b", uid: 1 }), /--send-to/);
  assert.throws(() => fenceSpec({ config: fullConfig({ artifactUrl: URL_ }), configPath: "/c", install: "/i", sendTo: "x", uid: 1 }), /outDir/);
});

test("every call of a real run passes", () => {
  pass(call("Bash", { command: PREP, description: "Prepare board export" }));
  pass(call("Bash", { command: RUN, description: "Compute", timeout: 120000, dangerouslyDisableSandbox: false }));
  for (const c of ["initiatives", "waiting", "ideas", "messages", "derived", "ctx"]) pass(call("ArtifactData", exp({ collection: c })));
  pass(call("ArtifactData", exp({ action: "query", collection: "steps", query: { where: [["at", ">=", 1]], limit: 1000, cursor: "abc" } })));
  pass(call("ArtifactData", exp({ out_dir: "/tmp/claude-501/-srv-fb-TestBoard01/sess-0001/scratchpad/flight-board-export" })));
  pass(call("ArtifactData", { action: "get", url: URL_, collection: "derived", doc_id: "all", out_dir: `${PAD}/derived-version` }));
  pass(call("ArtifactData", setAll()));
  pass(call("ArtifactData", setAll({ if_version: undefined })));
  pass(call("mcp__ccd_session_mgmt__send_message", { session_id: "local_lead-1", message: "NUDGE: x" }));
  for (const t of ["ToolSearch", "mcp__ccd_turn__update_plan", "mcp__ccd_turn__wrap_up"]) pass(call(t, { anything: 1 }));
});

test("Bash: the two commands byte for byte; nothing added, nothing outside the sandbox", () => {
  for (const command of [`${RUN} && curl example.com`, `${RUN} `, ` ${RUN}`, `${RUN} --no-fetch`, RUN.replace("abc123", "abc124"), "curl example.com", "cat ~/.env", `${PREP}; rm -rf x`])
    refused(call("Bash", { command }), "only the two collect.mjs commands");
  refused(call("Bash", { command: RUN, dangerouslyDisableSandbox: true }), "sandbox");
  refused(call("Bash", { command: RUN, run_in_background: true }), "unexpected run_in_background");
});

test("ArtifactData: this board, the exported collections into this session's scratchpad, and set derived/all from the file", () => {
  refused(call("ArtifactData", exp({ url: "https://claude.ai/" + "artifact/OtherBoard9" })), "this board only");
  refused(call("ArtifactData", setAll({ url: URL_ + "x" })), "this board only");
  refused(call("ArtifactData", exp({ out_dir: undefined })), "scratchpad");
  refused(call("ArtifactData", exp({ out_dir: `${PAD}/flight-board-export/../../x` })), "scratchpad");
  refused(call("ArtifactData", exp({ out_dir: PAD.replace("sess-0001", "sess-0002") + "/flight-board-export" })), "scratchpad");
  refused(call("ArtifactData", exp({ out_dir: `${PAD}/flight-board-export/` })), "scratchpad");
  refused(call("ArtifactData", exp({ collection: "steps/x/y" })), "exported collections");
  refused(call("ArtifactData", exp({ query: { limit: 1, as_level: "admin" } })), "query takes");
  refused(call("ArtifactData", exp({ as_level: "view" })), "unexpected as_level");
  refused(call("ArtifactData", exp({ doc_id: "x" })), "unexpected doc_id");
  refused(call("ArtifactData", { action: "get", url: URL_, collection: "waiting", doc_id: "all", out_dir: `${PAD}/derived-version` }), "derived/all only");
  refused(call("ArtifactData", { action: "get", url: URL_, collection: "derived", doc_id: "all" }), "derived-version");
  refused(call("ArtifactData", setAll({ doc_id: "other" })), "derived/all only");
  refused(call("ArtifactData", setAll({ collection: "waiting" })), "derived/all only");
  refused(call("ArtifactData", setAll({ file_path: "/srv/fb/TestBoard01-out/other.json" })), "output file only");
  refused(call("ArtifactData", setAll({ file_path: undefined, data: { x: 1 } })), "unexpected data");
  refused(call("ArtifactData", setAll({ if_version: "2" })), "whole number");
  for (const action of ["update", "batch", "delete", "str_replace", "profiles"]) refused(call("ArtifactData", { action, url: URL_ }), "not one of the steps");
});

test("send_message: the lead's session only, the message capped; every other tool refused", () => {
  refused(call("mcp__ccd_session_mgmt__send_message", { session_id: "local_other", message: "x" }), "lead's session");
  refused(call("mcp__ccd_session_mgmt__send_message", { session_id: "local_lead-1", message: "x".repeat(MESSAGE_MAX + 1) }), "at most");
  refused(call("mcp__ccd_session_mgmt__send_message", { session_id: "local_lead-1", message: "" }), "a message");
  refused(call("mcp__ccd_session_mgmt__send_message", { session_id: "local_lead-1", message: "x", extra: 1 }), "unexpected extra");
  for (const tool of ["Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "SendMessage", "NotebookEdit", "mcp__scheduled-tasks__create_scheduled_task", "mcp__ccd_session_mgmt__stop_session", "mcp__other__thing", undefined])
    refused(call(tool, { file_path: "/x" }), "not one of the collector's steps");
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
    assert.match(bad.stderr, /Refused by the collector's fence/);
    assert.equal(hook("not json").status, 2);
    assert.equal(hook(good, ["--config", join(dir, "missing.json"), "--send-to", "local_lead-1"]).status, 2);
    assert.equal(hook(good, ["--config", cfg]).status, 2, "no --send-to");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
