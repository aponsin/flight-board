// #C586: the lead's session id is one config field, gate.managerSession, next to managerRole. The Collector's fence sends only
// to it (--send-to is the fallback while the config has none), the release tool renders the Collector's prompt with it, and
// the config check knows the field (the fence was pinned before gate.keeperRole and refused the whole config). Fictional ids.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkConfig, fullConfig } from "../scripts/config.mjs";
import { leadOf, leadFromSettings } from "../scripts/board-release.mjs";

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const ID = "local_0a1b2c3d-1111-2222-3333-444455556666", OTHER = "local_ffffffff-1111-2222-3333-444455556666";
const base = { artifactUrl: URL_, collector: { repoPath: "/srv/repo", outDir: "/srv/fb/TestBoard01-out" } };

test("gate.managerSession is a session id or empty; the default is empty", () => {
  assert.equal(fullConfig(base).gate.managerSession, "");
  for (const ok of [ID, ""]) assert.deepEqual(checkConfig({ ...base, gate: { managerSession: ok } }), [], JSON.stringify(ok));
  for (const bad of ["local_049a77c5", "049a77c5-2ab6-4377-bc6b-c3765a7d768d", `${ID} x`, `${ID}\n`, "local_0A1B2C3D-1111-2222-3333-444455556666", 7, null, {}])
    assert.match(checkConfig({ ...base, gate: { managerSession: bad } }).join(";"), /gate\.managerSession/, JSON.stringify(bad));
});

test("the release tool's lead: the config's session first, the fence's --send-to only while the config has none", () => {
  const settings = `"command": "'node' '/i/collector/fence.mjs' --config '/c.json' --send-to ${OTHER} || exit 2"`;
  assert.equal(leadFromSettings(settings), OTHER);
  assert.equal(leadOf(fullConfig({ ...base, gate: { managerSession: ID } }), settings), ID, "the config wins");
  assert.equal(leadOf(fullConfig(base), settings), OTHER, "no config id: the settings' one");
  assert.equal(leadOf(fullConfig(base), ""), null);
});

test("the fence sends to the config's session; --send-to is the fallback; neither refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "fence-ms-"));
  try {
    const fence = new URL("../collector/fence.mjs", import.meta.url).pathname;
    const install = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const cfg = (gate) => { const p = join(dir, `c${Math.random()}.json`); writeFileSync(p, JSON.stringify({ ...base, gate: { stateDir: dir, ...gate } })); return p; };
    const send = (to) => ({ session_id: "sess-0001", cwd: join(dir, "TestBoard01"), tool_name: "mcp__ccd_session_mgmt__send_message", tool_input: { session_id: to, message: "NUDGE: x" } });
    const run = (config, to, extra = []) => spawnSync(process.execPath, [fence, "--config", config, ...extra], { input: JSON.stringify(send(to)), encoding: "utf8" });
    const withId = cfg({ managerSession: ID });
    assert.equal(run(withId, ID).status, 0, "no --send-to at all: the config's id");
    assert.equal(run(withId, ID, ["--send-to", OTHER]).status, 0, "a retired --send-to in the settings is ignored");
    assert.equal(run(withId, OTHER, ["--send-to", OTHER]).status, 2, "the retired id is no longer the lead's");
    const without = cfg({});
    assert.equal(run(without, OTHER, ["--send-to", OTHER]).status, 0, "no config id: --send-to, as before");
    assert.equal(run(without, OTHER).status, 2, "neither");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the fence accepts every field of today's config (it once refused gate.keeperRole)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fence-ms-"));
  try {
    const fence = new URL("../collector/fence.mjs", import.meta.url).pathname;
    const p = join(dir, "c.json");
    writeFileSync(p, JSON.stringify({ ...base, prAgent: "Agent X", gate: { stateDir: dir, keeperRole: "Keeper", reviewerRole: "Reviewer", releaseRole: "Release", managerSession: ID } }));
    const r = spawnSync(process.execPath, [fence, "--config", p], { input: JSON.stringify({ session_id: "s-1", cwd: join(dir, "TestBoard01"), tool_name: "ToolSearch", tool_input: { query: "x" } }), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
