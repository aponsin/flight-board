// A card's status is derived from the live state, never typed (#C449, derived-status): while the reading is fresh, a card
// whose branch has a commit beyond main, or whose agent is working on it, is building (badge, tile, the queued line and
// "never started" all follow); the typed status counts only when the reading is stale. The gate refuses status
// "queued" on a card the live state shows building. Fictional board.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullConfig } from "../scripts/config.mjs";
import { checkWrites } from "../gate/rules.mjs";
import { run } from "../gate/gate.mjs";
import { buildingNow, liveFresh } from "../collector/state-schema.mjs";
import { readLiveState } from "../collector/collect.mjs";
import { loadNames } from "./harness.mjs";

const NOW = Date.now(), MIN = 60e3, ID = "our-work-editor";
const reading = (at, { card = {}, agent = {} } = {}) => ({
  v: 1, board: { boardId: "TestBoard42xyz", at, probe: null, pageVersion: null },
  cards: { [ID]: { num: 48, phase: "build", headSha12: "a1b2c3d4e5f6", signed: [], onMain: false, ci: "passed", ciMin: 4, liveVersion: null, at, ...card } },
  agents: { Builder: { state: "working", lastActivityAt: at, tool: "Bash", card: ID, since: at - 11 * MIN, ...agent } },
});
// the owner's 21:32Z case: the db says queued, created 26 min ago, no step logged; the live state has the branch and Builder on it.
const typed = { id: ID, num: 48, name: "Our work editor", status: "queued", phase: "build", size: "S", who: "Builder", createdAt: NOW - 26 * MIN, level: "Quick", nextNote: "build", nextNoteAt: NOW - 20 * MIN, etaLive: NOW + 3 * 3600e3 };
function board(live) {
  const b = loadNames(["enrich", "initRow", "probeEvent", "renderCrew", "liveBuilding"]);
  Object.assign(b.state, { initRaw: [typed], steps: [], waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [], derived: [{ id: "all", at: NOW - 40 * MIN, cards: {} }] });
  if (live) b.probeEvent({ type: "data", result: { payload: live } }, {});
  b.state.initiatives = b.state.initRaw.map(b.enrich);
  return b;
}
const badge = (html) => /<span class="state [^"]*">([^<]*)<\/span>/.exec(html)[1];

test("the owner's case: queued in the db, a branch with commits and Builder on it: Building, no queued line, no 'never started'", () => {
  const b = board(reading(NOW - 30e3));
  const i = b.state.initiatives[0], html = b.initRow(i);
  assert.equal(i.status, "active");
  assert.equal(badge(html), "Building");
  assert.doesNotMatch(html, /Queued \d|never started|queued · Builder/);
  b.renderCrew();
  assert.match(b.els.crew.innerHTML, /<span class="ci active">Our work editor<\/span>/, "the tile: no ⧗");
});

test("either sign alone is enough: the branch, or the agent", () => {
  const branchOnly = board(reading(NOW - 30e3, { agent: { state: "idle", card: null } }));
  assert.equal(badge(branchOnly.initRow(branchOnly.state.initiatives[0])), "Building", "the branch alone");
  const agentOnly = board(reading(NOW - 30e3, { card: { headSha12: null } }));
  assert.equal(badge(agentOnly.initRow(agentOnly.state.initiatives[0])), "Building", "the agent alone");
});

test("no branch beyond main and no agent on it: queued as typed; a stale reading falls back to the typed status", () => {
  for (const [why, live] of [
    ["neither", reading(NOW - 30e3, { card: { headSha12: null }, agent: { card: "other-card" } })],
    ["on main, agent idle", reading(NOW - 30e3, { card: { onMain: true }, agent: { state: "idle" } })],
    ["stale", reading(NOW - 4 * MIN)],
    ["no reading", null],
  ]) {
    const b = board(live), html = b.initRow(b.state.initiatives[0]);
    assert.equal(b.state.initiatives[0].status, "queued", why);
    assert.equal(badge(html), "Queued", why);
    assert.match(html, /Queued 26 min/, why);
    assert.match(html, /never started/, why);
  }
});

// The gate: the same rule, on the live state's file beside the mirror.
const config = fullConfig({ owner: "Sam", collector: { repoPath: "/x" } });
const lead = { role: "Manager", manager: true };
const upd = (data) => ({ op: "update", collection: "initiatives", doc_id: ID, data });
const refusal = (live, w = upd({ status: "queued" }), who = lead) => checkWrites([w], { config, who, now: NOW, state: {}, mirror: null, live }).errors.filter((e) => /queued/.test(e));

test("the gate refuses status queued on a card the live state shows building; else it goes", () => {
  assert.deepEqual(refusal(reading(NOW - 30e3)), [`initiatives/${ID}: status: the live state shows ${ID} building (its branch has commits beyond main, or an agent is on it); its status is derived, not queued`]);
  assert.equal(refusal(reading(NOW - 30e3), { op: "set", collection: "initiatives", doc_id: ID, data: { ...typed } }).length, 1, "a set too");
  assert.deepEqual(refusal(reading(NOW - 30e3), upd({ status: "active" })), []);
  assert.deepEqual(refusal(reading(NOW - 30e3, { card: { headSha12: null }, agent: { card: null } })), [], "nothing building");
  assert.deepEqual(refusal(null), [], "no fresh live state: the typed status");
});

test("the gate reads <stateDir>/<board>/state.json, only while fresh", () => {
  const root = mkdtempSync(join(tmpdir(), "fb-derived-status-"));
  try {
    const URL_ = "https://claude.ai/" + "artifact/TestBoard01", dir = join(root, "TestBoard01");
    const cfg = fullConfig({ artifactUrl: URL_, gate: { stateDir: root } });
    mkdirSync(dir, { recursive: true });
    const transcript = join(root, "t.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "custom-title", customTitle: "Manager" }) + "\n");
    const call = { tool_name: "ArtifactData", transcript_path: transcript, tool_input: { url: URL_, action: "update", collection: "initiatives", doc_id: ID, data: { status: "queued" } } };
    writeFileSync(join(dir, "state.json"), JSON.stringify(reading(NOW - 30e3)));
    assert.match(run(call, { config: cfg, env: {}, now: NOW }).block ?? "", /its status is derived, not queued/);
    writeFileSync(join(dir, "state.json"), JSON.stringify(reading(NOW - 4 * MIN)));
    assert.doesNotMatch(run(call, { config: cfg, env: {}, now: NOW }).block ?? "", /derived, not queued/, "a stale one counts as none");
    writeFileSync(join(dir, "state.json"), "{not json");
    assert.doesNotMatch(run(call, { config: cfg, env: {}, now: NOW }).block ?? "", /derived, not queued/, "an unreadable one counts as none");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the shared rule: buildingNow and liveFresh, and the collector's reader uses the same freshness", () => {
  const s = reading(NOW - 30e3);
  assert.equal(buildingNow(s, ID), true);
  assert.equal(buildingNow(reading(NOW, { agent: { card: null } }), ID), true, "the branch");
  assert.equal(buildingNow(reading(NOW, { card: { headSha12: null } }), ID), true, "the agent");
  assert.equal(buildingNow(reading(NOW, { card: { onMain: true }, agent: { state: "idle" } }), ID), false, "on main, nobody on it");
  assert.equal(buildingNow(s, "toString"), false, "an inherited key is no card");
  assert.equal(buildingNow(null, ID), false);
  assert.equal(liveFresh(s, NOW), true);
  assert.equal(liveFresh(reading(NOW - 3 * MIN), NOW), false, "3 min: stale");
  assert.equal(liveFresh(reading(NOW + 2 * MIN), NOW), false, "from the future");
  assert.equal(liveFresh({ ...s, extra: 1 }, NOW), false, "off the schema");
  const root = mkdtempSync(join(tmpdir(), "fb-live-read-"));
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify(reading(NOW - 4 * MIN)));
    assert.equal(readLiveState(root, NOW), null);
    writeFileSync(join(root, "state.json"), JSON.stringify(s));
    assert.deepEqual(readLiveState(root, NOW), s);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
