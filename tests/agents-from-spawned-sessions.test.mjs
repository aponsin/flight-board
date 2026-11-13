// #C970 (the owner, 11-12: the agent tiles did not show Checker 2): the roster is not only the config's list. Every open session the lead started
// (spawnedFrom.sessionId in the app's session file) is an agent too, under its title with anything but letters and digits dropped, so a new role
// shows up by itself; the probe reads it, the state carries it (by: "spawn") and the Crew tiles draw it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStates, appSessions } from "../collector/state.mjs";
import { stateErrors, STATE_VERSION } from "../collector/state-schema.mjs";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const LEAD = "local_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", OTHER = "local_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const sid = (n) => `local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}`;
const tid = (n) => `cccccccc-cccc-4ccc-8ccc-ccccccccccc${n}`;

function home() {
  const h = mkdtempSync(join(tmpdir(), "spawn-")), cwd = "/Users/x/Code/teamrepo";
  const proj = join(h, ".claude", "projects", "-Users-x-Code-teamrepo");
  mkdirSync(proj, { recursive: true });
  for (const n of [1, 2, 3, 4, 5]) writeFileSync(join(proj, `${tid(n)}.jsonl`), "");
  return { h, cwd };
}
const row = (n, title, extra = {}) => ({ id: sid(n), title, transcript: tid(n), cwd: "/Users/x/Code/teamrepo", at: T - n * MIN, from: null, ...extra });
const run = (sessions, extra = {}) => agentStates({ roles: ["Manager", "Checker"], sessions, homeDir: home().h, now: T, ids: new Set(), nums: new Map(), spawnedBy: LEAD, ...extra });

test("a session the lead started, not on the roster, is an agent under its title with spaces dropped, marked by: spawn", () => {
  const a = run([row(1, "Checker 2", { from: LEAD })]);
  assert.deepEqual(Object.keys(a), ["Checker2"]);
  assert.equal(a.Checker2.by, "spawn");
  assert.equal(a.Checker2.lastActivityAt, T - MIN);
});

test("a session another session started, one nobody started, and the lead's own are not added; with no lead named, none is", () => {
  const sessions = [row(1, "Checker 2", { from: OTHER }), row(2, "Plain", { from: null }), row(3, "Reviewer", { from: LEAD })];
  assert.deepEqual(Object.keys(run(sessions)), ["Reviewer"]);
  assert.deepEqual(Object.keys(run(sessions, { spawnedBy: null })), []);
});

test("a roster role keeps its own rule: a spawned session titled like one is not a second agent, and the roster's agent is the one found as before", () => {
  const a = run([row(1, "Checker", { from: LEAD }), row(2, "Checker 2", { from: LEAD })]);
  assert.deepEqual(Object.keys(a).sort(), ["Checker", "Checker2"]);
  assert.equal(a.Checker.by, "title", "found by title, as a roster role is");
  assert.equal(a.Checker2.by, "spawn");
});

test("two spawned sessions with the same name give the newest; a title that is no role name is left out", () => {
  const a = run([row(1, "Checker 2", { from: LEAD, at: T - 9 * MIN }), row(2, "Checker2", { from: LEAD, at: T - MIN }), row(3, "?", { from: LEAD }), row(4, "A", { from: LEAD })]);
  assert.deepEqual(Object.keys(a), ["Checker2"]);
  assert.equal(a.Checker2.lastActivityAt, T - MIN);
});

test("the probe reads from out of the app's session file: only a session id is kept, and nothing else of spawnedFrom", () => {
  const root = mkdtempSync(join(tmpdir(), "sessions-")), org = join(root, tid(8), tid(9));
  mkdirSync(org, { recursive: true });
  const file = (n, spawnedFrom) => writeFileSync(join(org, `${sid(n)}.json`), JSON.stringify({ title: `S${n}`, cliSessionId: tid(n), cwd: "/Users/x/Code/teamrepo", lastActivityAt: T, spawnedFrom }));
  file(1, { sessionId: LEAD, title: "Manager", taskId: "task_1", name: "m" });
  file(2, { sessionId: "not a session id" });
  file(3, null);
  file(4, undefined);
  const by = Object.fromEntries(appSessions(root).map((s) => [s.title, s.from]));
  assert.deepEqual(by, { S1: LEAD, S2: null, S3: null, S4: null });
  assert.deepEqual(Object.keys(appSessions(root)[0]).sort(), ["at", "cwd", "from", "id", "title", "transcript"]);
});

test("the state accepts by: spawn and still refuses any other word", () => {
  const card = { state: "idle", lastActivityAt: T, tool: null, card: null, since: null };
  const s = (agent) => ({ v: STATE_VERSION, board: { boardId: "x".repeat(22), at: T, probe: "a".repeat(40), pageVersion: null }, cards: {}, agents: { Checker2: agent } });
  assert.deepEqual(stateErrors(s({ ...card, by: "spawn" })).filter((e) => /by/.test(e)), []);
  assert.ok(stateErrors(s({ ...card, by: "other" })).some((e) => /by/.test(e)));
});

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
test("the Crew tiles draw an agent the probe reads that is not on the roster, with no config edit; a stale reading draws none", () => {
  const b = loadNames(["liveAgent", "probeEvent", "crewBy", "crewHtml"], { Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(T); } static now() { return T; } } });
  Object.assign(b.state, { initRaw: [], steps: [], waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [], derived: [], initiatives: [] });
  const live = (at) => ({ v: 1, board: { boardId: "TestBoard42xyz", at, probe: null, pageVersion: null }, cards: {}, agents: { Checker: { state: "idle", lastActivityAt: at, tool: null, card: null, since: null }, Checker2: { state: "idle", lastActivityAt: at, tool: null, card: null, since: null, by: "spawn" } } });
  b.probeEvent({ type: "data", result: { payload: live(T - 40e3) } }, {});
  assert.deepEqual([...b.crewBy().names], ["Manager", "Builder", "Checker", "Security", "Release", "Checker2"]);
  assert.match(b.crewHtml(), /data-agent="Checker2"/);
  assert.doesNotMatch(b.crewHtml().split('data-agent="Checker2"')[1], /found by title/, "a spawned agent is not 'found by title': that note is for a roster role with no session id");
  b.probeEvent({ type: "data", result: { payload: live(T - 10 * MIN) } }, {});
  assert.deepEqual([...b.crewBy().names], ["Manager", "Builder", "Checker", "Security", "Release"], "no live reading, no extra tile");
  assert.match(html, /const live=probe&&probe\.agents/, "crewBy reads the probe's agents");
});
