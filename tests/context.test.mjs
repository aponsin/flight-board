// Memory tiles from the app's own numbers (collector/context.mjs, #C274): the run's session list and context readings,
// saved by its PostToolUse hook, become ctx/<Role> and meta/context files the run writes as they are. Fictional sessions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkConfig, fullConfig } from "../scripts/config.mjs";
import { contextRoles, responseJson, sessionRows, pickSessions, usageReading, tap, planReadings, readPlan, writeContext, ctxDocErrors, contextUpdateErrors, CTX_MAX_AGE } from "../collector/context.mjs";

const NOW = 1_793_050_000_123;
const roles = ["Checker", "Manager", "Security"];
const text = (o) => [{ type: "text", text: JSON.stringify(o) }];
const row = (sessionId, title, at, over = {}) => ({ sessionId, title, cwd: "/srv/code", isArchived: false, isRunning: false, lastActivityAt: new Date(at).toISOString(), ...over });
const usage = (session, percentUsed, status = "ok") => ({ plan: { status: "ok" }, context: { session, status, percentUsed, tokensUsed: 1, contextWindow: 100 } });

test("config: collector.contextRoles is a list of role names a session can be titled with; empty (the default) turns it off", () => {
  assert.deepEqual(checkConfig({ collector: { contextRoles: ["Checker", "Release-2"] } }), []);
  for (const bad of ["Checker", [""], ["two words"], ["a/b"], [1], Array(41).fill("X")]) assert.match(checkConfig({ collector: { contextRoles: bad } }).join(), /contextRoles/);
  assert.deepEqual(contextRoles(fullConfig({})), []);
  assert.deepEqual(contextRoles(fullConfig({ collector: { contextRoles: roles } })), roles);
});

test("a tool's response is read as JSON whether it comes as text blocks, a string, or an object", () => {
  assert.deepEqual(responseJson(text({ a: 1 })), { a: 1 });
  assert.deepEqual(responseJson({ content: text({ a: 2 }) }), { a: 2 });
  assert.deepEqual(responseJson('{"a":3}'), { a: 3 });
  assert.deepEqual(responseJson({ a: 4 }), { a: 4 });
  for (const bad of [null, "not json", [{ type: "image" }], 7]) assert.equal(responseJson(bad), null);
});

test("each role's session is the newest open one titled exactly as the role; archived ones, other titles and bad ids never", () => {
  const rows = sessionRows([
    row("local_c-old", "Checker", NOW - 9e6), row("local_c-new", "Checker", NOW - 1e6), row("local_c-arch", "Checker", NOW, { isArchived: true }),
    row("local_m", "Manager", NOW - 5e6), row("local_x", "Checker (old)", NOW), row("bad id!", "Security", NOW), { title: "Security" }, "junk",
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["local_c-old", "local_c-new", "local_m", "local_x"]);
  assert.deepEqual(pickSessions(rows, roles), { Checker: "local_c-new", Manager: "local_m" });
  assert.deepEqual(sessionRows({ not: "a list" }), []);
});

test("a reading is a whole percentage from that session's own window; unavailable or another session's is none", () => {
  assert.deepEqual(usageReading(usage("local_c", 28), "local_c"), { status: "ok", pct: 28 });
  assert.deepEqual(usageReading(usage("local_c", 28.6), "local_c"), { status: "ok", pct: 29 });
  assert.deepEqual(usageReading(usage("local_c", null, "unavailable"), "local_c"), { status: "unavailable", pct: null });
  assert.deepEqual(usageReading(usage("local_other", 28), "local_c"), { status: "unavailable", pct: null });
  for (const p of [-1, 101, "28", NaN]) assert.equal(usageReading(usage("local_c", p), "local_c").pct, null, String(p));
});

const setup = () => {
  const base = mkdtempSync(join(tmpdir(), "fb-ctx-"));
  const dir = join(base, "state", "TestBoard01"), out = join(base, "out");
  mkdirSync(dir, { recursive: true });
  return { base, dir, out };
};
const hook = (dir, tool_name, tool_input, tool_response, over = {}) => ({ session_id: "sess-1", cwd: dir, hook_event_name: "PostToolUse", tool_name, tool_input, tool_response, ...over });

test("the hook keeps the session list and each planned session's reading in the state folder, and nothing else", () => {
  const { base, dir } = setup();
  try {
    tap(hook(dir, "mcp__ccd_session_mgmt__list_sessions", { limit: 200 }, text([row("local_c", "Checker", NOW - 1e3), row("local_m", "Manager", NOW - 2e3)])), { dir, now: NOW });
    const saved = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"));
    assert.equal(saved.at, NOW);
    assert.deepEqual(saved.rows.map((r) => [r.id, r.title]), [["local_c", "Checker"], ["local_m", "Manager"]]);
    assert.equal(JSON.stringify(saved).includes("/srv/code"), false, "only id, title and last activity are kept");
    // A reading counts only for a session the plan names (--prepare wrote it).
    writeFileSync(join(dir, "usage-plan.json"), JSON.stringify({ at: NOW, roles: { Checker: "local_c" } }));
    tap(hook(dir, "mcp__ccd_session_mgmt__get_usage", { session_id: "local_c" }, text(usage("local_c", 41))), { dir, now: NOW + 5 });
    tap(hook(dir, "mcp__ccd_session_mgmt__get_usage", { session_id: "local_m" }, text(usage("local_m", 50))), { dir, now: NOW + 6 });
    assert.deepEqual(readdirSync(join(dir, "usage")), ["local_c.json"]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "usage", "local_c.json"), "utf8")), { status: "ok", pct: 41, at: NOW + 5 });
    // Another folder, another tool: nothing saved.
    assert.equal(tap(hook(join(base, "elsewhere"), "mcp__ccd_session_mgmt__list_sessions", {}, text([])), { dir, now: NOW }), "not this board's state folder");
    assert.equal(tap(hook(dir, "Bash", { command: "x" }, "y"), { dir, now: NOW }), "not a memory reading");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a session list too long for the run is read from the file the app saved it to: that run's own file only (the trial run, #C274)", () => {
  const { base, dir } = setup();
  try {
    const home = join(base, "home"), sess = "923967cc-feeb-42f0-9712-cdf154fb5361";
    const folder = join(home, ".claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-"), sess, "tool-results");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "mcp-ccd_session_mgmt-list_sessions-1793052036442.txt");
    writeFileSync(file, JSON.stringify([row("local_c", "Checker", NOW - 1e3)], null, 2));
    const saved = (p) => `Error: result (81,024 characters across 2,237 lines) exceeds maximum allowed tokens. Output has been saved to ${p}.\nFormat: Plain text\n- For targeted searches (find a line, locate a string): use grep on the file directly.\n`;
    const list = (resp, over = {}) => { tap(hook(dir, "mcp__ccd_session_mgmt__list_sessions", { limit: 200 }, resp, { session_id: sess, ...over }), { dir, now: NOW, homeDir: home }); return JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")).rows.map((r) => r.id); };
    assert.deepEqual(list(saved(file)), ["local_c"]);
    assert.deepEqual(list([{ type: "text", text: saved(file) }]), ["local_c"], "as text blocks too");
    // Anything but this run's own saved list is never read.
    const other = join(home, ".claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-"), "another-session", "tool-results");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "mcp-ccd_session_mgmt-list_sessions-1.txt"), readFileSync(file));
    assert.deepEqual(list(saved(join(other, "mcp-ccd_session_mgmt-list_sessions-1.txt"))), [], "another session's file");
    writeFileSync(join(folder, "mcp-ccd_session_mgmt-get_usage-1.txt"), readFileSync(file));
    assert.deepEqual(list(saved(join(folder, "mcp-ccd_session_mgmt-get_usage-1.txt"))), [], "another tool's file");
    assert.deepEqual(list(saved(`${folder}/../tool-results/mcp-ccd_session_mgmt-list_sessions-1793052036442.txt`)), [], "a path with ..");
    assert.deepEqual(list(saved(file), { session_id: "../x" }), [], "a bad session id");
    symlinkSync(file, join(folder, "mcp-ccd_session_mgmt-list_sessions-7.txt"));
    assert.deepEqual(list(saved(join(folder, "mcp-ccd_session_mgmt-list_sessions-7.txt"))), [], "a link");
    writeFileSync(join(base, "elsewhere.txt"), readFileSync(file));
    assert.deepEqual(list(saved(join(base, "elsewhere.txt"))), [], "a file elsewhere");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("--prepare's plan: from this run's session list only, and the last run's readings go", () => {
  const { base, dir } = setup();
  try {
    const config = fullConfig({ collector: { contextRoles: roles } });
    mkdirSync(join(dir, "usage"));
    writeFileSync(join(dir, "usage", "local_old.json"), "{}");
    assert.match(planReadings(dir, config, NOW).join("\n"), /no session list from this run/);
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({ at: NOW - 16 * 60e3, rows: [{ id: "local_c", title: "Checker", at: NOW }] }));
    assert.match(planReadings(dir, config, NOW).join("\n"), /no session list from this run/, "a list older than 15 min is another run's");
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({ at: NOW - 60e3, rows: [{ id: "local_c", title: "Checker", at: NOW }, { id: "local_m", title: "Manager", at: NOW }] }));
    const lines = planReadings(dir, config, NOW);
    assert.deepEqual(lines.filter((l) => l.startsWith("Read memory:")), ["Read memory: get_usage session_id local_c (Checker)", "Read memory: get_usage session_id local_m (Manager)"]);
    assert.deepEqual(readPlan(dir), { at: NOW, roles: { Checker: "local_c", Manager: "local_m" } });
    assert.equal(existsSync(join(dir, "usage", "local_old.json")), false);
    assert.deepEqual(planReadings(dir, fullConfig({}), NOW), [], "no roles configured: no plan, no lines");
    assert.equal(readPlan(dir), null);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("step 2 writes one ctx file per fresh reading and one meta/context file; an unavailable session keeps its last reading", () => {
  const { base, dir, out } = setup();
  try {
    const config = fullConfig({ collector: { contextRoles: roles } });
    writeFileSync(join(dir, "usage-plan.json"), JSON.stringify({ at: NOW, roles: { Checker: "local_c", Manager: "local_m", Security: "local_s" } }));
    mkdirSync(join(dir, "usage"));
    writeFileSync(join(dir, "usage", "local_c.json"), JSON.stringify({ status: "ok", pct: 41, at: NOW + 5 }));
    writeFileSync(join(dir, "usage", "local_m.json"), JSON.stringify({ status: "unavailable", pct: null, at: NOW + 6 }));
    writeFileSync(join(dir, "usage", "local_s.json"), JSON.stringify({ status: "ok", pct: 12, at: NOW - 1 }), "utf8"); // before the plan: another run's
    mkdirSync(out);
    writeFileSync(join(out, "ctx-Security.json"), "{}"); // last run's
    const lines = writeContext(dir, out, config, NOW + 10);
    assert.deepEqual(JSON.parse(readFileSync(join(out, "ctx-Checker.json"), "utf8")), { pct: 41, at: NOW + 5 });
    assert.deepEqual(JSON.parse(readFileSync(join(out, "meta-context.json"), "utf8")), { agents: { Checker: { pct: 41, at: NOW + 5 } } });
    assert.equal(existsSync(join(out, "ctx-Security.json")), false);
    assert.equal(existsSync(join(out, "ctx-Manager.json")), false);
    assert.deepEqual(lines, [
      `MEMORY set ctx/Checker from ${join(out, "ctx-Checker.json")}`,
      `MEMORY update meta/context from ${join(out, "meta-context.json")}`,
      "MEMORY kept (no reading this run): Manager, Security",
    ]);
    rmSync(join(dir, "usage"), { recursive: true });
    assert.deepEqual(writeContext(dir, out, config, NOW + 10), ["MEMORY kept (no reading this run): Checker, Manager, Security"]);
    assert.equal(existsSync(join(out, "meta-context.json")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("shapes: a tile is exactly {pct, at}; meta/context only agents.<Role> {pct, at} for the configured roles", () => {
  assert.deepEqual(ctxDocErrors({ pct: 41, at: NOW }, NOW), []);
  for (const bad of [{ pct: 41 }, { pct: 41, at: NOW, saved: true }, { pct: 101, at: NOW }, { pct: 4.5, at: NOW }, { pct: 41, at: NOW + 120e3 }, { pct: 41, at: NOW - CTX_MAX_AGE - 1 }, null, []])
    assert.notDeepEqual(ctxDocErrors(bad, NOW), [], JSON.stringify(bad));
  assert.deepEqual(contextUpdateErrors({ agents: { Checker: { pct: 41, at: NOW } } }, roles, NOW), []);
  for (const bad of [{ agents: { Builder: { pct: 1, at: NOW } } }, { agents: { Checker: { pct: 1, at: NOW, saved: true } } }, { agents: { Checker: { pct: 1, at: NOW } }, at: NOW }, { agents: {} }, { agents: [] }, {}])
    assert.notDeepEqual(contextUpdateErrors(bad, roles, NOW), [], JSON.stringify(bad));
});

test("the hook's command line: a failure never blocks the run's tool (exit 0), and it saves nothing outside its folder", () => {
  const { base, dir } = setup();
  try {
    const cfg = join(base, "board.config.json");
    writeFileSync(cfg, JSON.stringify({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", gate: { stateDir: join(base, "state") }, collector: { outDir: join(base, "out"), contextRoles: roles } }));
    const run = (input) => spawnSync(process.execPath, [new URL("../collector/context.mjs", import.meta.url).pathname, "--config", cfg], { input, encoding: "utf8" });
    const ok = run(JSON.stringify(hook(dir, "mcp__ccd_session_mgmt__list_sessions", {}, text([row("local_c", "Checker", NOW)]))));
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(existsSync(join(dir, "sessions.json")));
    for (const input of ["not json", JSON.stringify(hook(join(base, "x"), "mcp__ccd_session_mgmt__list_sessions", {}, text([])))]) assert.equal(run(input).status, 0);
    assert.equal(existsSync(join(base, "x")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
