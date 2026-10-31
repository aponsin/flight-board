// A role stopped on a prompt in its session (#C526): the probe reads it from the transcript (promptSince), and the
// Collector's alarm sends the lead one NUDGE per stop, then one when it moves on. Fixtures shaped like the transcript of
// the night it happened: a site approval at 05:50Z whose result came at 15:49Z. Fictional roles and board.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, utimesSync } from "node:fs";
import { promptSince, activity, agentStates } from "../collector/state.mjs";
import { promptAlarm, runPromptAlarm, NEEDS_USER_MS, askId } from "../collector/prompt-alarm.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { stateErrors } from "../collector/state-schema.mjs";

const T = Date.parse("2026-10-31T05:50:58Z"), MIN = 60e3;
const at = (t) => new Date(t).toISOString();
const prompt = (t) => ({ type: "user", timestamp: at(t), message: { content: "go on" } });
const call = (t, id, name, stop = "tool_use") => ({ type: "assistant", timestamp: at(t), message: { stop_reason: stop, content: [{ type: "tool_use", id, name, input: {} }] } });
const result = (t, id) => ({ type: "user", timestamp: at(t), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const done = (t) => ({ type: "assistant", timestamp: at(t), message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } });
// The night's shape: a prompt, a Bash call answered, then a browser call waiting on the site approval.
const night = [prompt(T - 5 * MIN), call(T - 2 * MIN, "a", "Bash"), result(T - MIN, "a"), call(T, "b", "mcp__Claude_Browser__preview_start")];

test("promptSince: a call with no result, quiet over 15 min, is a stop on a prompt since the call", () => {
  assert.equal(promptSince(night, { mtimeMs: T, now: T + 16 * MIN }), T);
  assert.equal(promptSince(night, { mtimeMs: T, now: T + 15 * MIN }), null, "15 min quiet exactly: still working");
  assert.equal(promptSince(night, { mtimeMs: T, now: T + 600 * MIN }), T, "ten hours on: still stopped");
});

test("promptSince: an answered call, an ended turn, a subagent, or a stop from before the last prompt is not a prompt", () => {
  const now = T + 60 * MIN;
  assert.equal(promptSince([...night, result(T + MIN, "b")], { mtimeMs: T + MIN, now }), null, "the result came: mid-turn, but nothing waits");
  assert.equal(promptSince([...night, result(T + MIN, "b"), done(T + 2 * MIN)], { mtimeMs: T + 2 * MIN, now }), null, "the turn ended");
  assert.equal(promptSince([prompt(T - MIN), call(T, "s", "Agent")], { mtimeMs: T, now }), null, "a subagent may run long on its own");
  assert.equal(promptSince([call(T - 9 * MIN, "x", "Bash"), prompt(T - 8 * MIN), call(T - 7 * MIN, "y", "Read"), result(T - 6 * MIN, "y"), done(T - 5 * MIN)], { mtimeMs: T, now }), null, "an interrupted call before the prompt");
  assert.equal(promptSince([], { mtimeMs: T, now }), null);
  assert.equal(promptSince([prompt(T - 2 * MIN), call(T - MIN, "z", "Bash"), done(T)], { mtimeMs: T, now }), null, "a call left unanswered in a turn that ended");
  assert.equal(promptSince([call(T - 9 * MIN, "x", "Bash"), prompt(T - 8 * MIN), call(T - 7 * MIN, "y", "Read"), result(T - 6 * MIN, "y")], { mtimeMs: T - 6 * MIN, now }), null, "mid-turn, everything since the prompt answered: an older call doesn't count");
});

test("promptSince: two calls at once, one answered and one waiting: the waiting one's time", () => {
  const two = [prompt(T - MIN), call(T, "p", "Bash"), call(T + 1000, "q", "mcp__Claude_Browser__navigate"), result(T + 2000, "p")];
  assert.equal(promptSince(two, { mtimeMs: T + 2000, now: T + 30 * MIN }), T + 1000);
  const both = [prompt(T - MIN), call(T, "p", "Bash"), call(T + 1000, "q", "mcp__Claude_Browser__navigate")];
  assert.equal(promptSince(both, { mtimeMs: T + 1000, now: T + 30 * MIN }), T, "two waiting: since the first");
});

test("activity carries prompt beside the state; the state that leaves never does", () => {
  const a = activity(night, { mtimeMs: T, now: T + 20 * MIN, ids: new Set(), nums: new Map() });
  assert.equal(a.state, "idle");
  assert.equal(a.prompt, T);
  const agent = { state: a.state, lastActivityAt: T, tool: a.tool, card: a.card, since: a.since };
  assert.deepEqual(stateErrors({ v: 1, board: { boardId: "TestBoard01", at: T, probe: null, pageVersion: null }, cards: {}, agents: { Mainsite: agent } }), []);
  assert.ok(stateErrors({ v: 1, board: { boardId: "TestBoard01", at: T, probe: null, pageVersion: null }, cards: {}, agents: { Mainsite: { ...agent, prompt: T } } }).length, "a prompt key would be refused by the schema: it stays local");
});

test("agentStates: a stopped role goes into prompts (role and time only); one at work, or with no prompts asked, doesn't", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "prompt-home-")), cwd = "/Users/x/Code/teamrepo";
  const proj = join(homeDir, ".claude", "projects", "-Users-x-Code-teamrepo");
  mkdirSync(proj, { recursive: true });
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
  writeFileSync(join(proj, `${ids[0]}.jsonl`), night.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(proj, `${ids[1]}.jsonl`), [prompt(T - MIN), call(T, "c", "Bash")].map((e) => JSON.stringify(e)).join("\n") + "\n");
  utimesSync(join(proj, `${ids[0]}.jsonl`), new Date(T), new Date(T));
  utimesSync(join(proj, `${ids[1]}.jsonl`), new Date(T + 50 * MIN), new Date(T + 50 * MIN));
  const sessions = [{ title: "Mainsite", transcript: ids[0], cwd, at: T }, { title: "Builder", transcript: ids[1], cwd, at: T }];
  const prompts = {};
  const agents = agentStates({ roles: ["Mainsite", "Builder"], sessions, homeDir, now: T + 60 * MIN, ids: new Set(), nums: new Map(), prompts });
  assert.deepEqual(prompts, { Mainsite: T }, "Builder's call is 10 min quiet: still working");
  assert.equal(agents.Mainsite.state, "idle");
  assert.ok(!("prompt" in agents.Mainsite), "the agent record keeps its five fields");
  assert.doesNotThrow(() => agentStates({ roles: ["Mainsite"], sessions, homeDir, now: T + 60 * MIN, ids: new Set(), nums: new Map() }));
});

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", roster: ["Manager", "Mainsite", "Builder"] });
const reading = (now, roles) => ({ at: now - 30e3, roles });

test("the alarm: one NUDGE once a role has been stopped 15 min, none again for the same stop, one when it moves on", () => {
  let now = T + 10 * MIN, r = promptAlarm({ config, reading: reading(now, { Mainsite: T }), now, state: {} });
  assert.deepEqual(r.lines, [], "10 min: not yet");
  now = T + NEEDS_USER_MS; r = promptAlarm({ config, reading: reading(now, { Mainsite: T }), now, state: r.state });
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /^NUDGE Mainsite is waiting on a prompt in its session since 05:50Z \(15 min\): raise waiting\/needs-user-mainsite \(kind "action", text "Mainsite is waiting on a prompt in its session: open it in the Claude app and answer it"\) unless it is open, and push the owner once\.$/);
  for (const m of [20, 60, 600]) { now = T + m * MIN; r = promptAlarm({ config, reading: reading(now, { Mainsite: T }), now, state: r.state }); assert.deepEqual(r.lines, [], `${m} min: no repeat`); }
  now = T + 601 * MIN; r = promptAlarm({ config, reading: reading(now, {}), now, state: r.state });
  assert.deepEqual(r.lines, ["NUDGE Mainsite is past its prompt: mark waiting/needs-user-mainsite done."]);
  assert.deepEqual(r.state, {});
});

test("the alarm: a new stop after one ended is a new alarm; the lead's own stop says who relays it", () => {
  const s = { Mainsite: T };
  const now = T + 100 * MIN, later = T + 80 * MIN;
  const r = promptAlarm({ config, reading: reading(now, { Mainsite: later, Manager: T }), now, state: s });
  assert.equal(r.lines[0], "NUDGE Mainsite is past its prompt: mark waiting/needs-user-mainsite done.");
  assert.match(r.lines[1], /^NUDGE Mainsite is waiting on a prompt in its session since 07:10Z \(20 min\)/, "alarms in role order");
  assert.match(r.lines[2], /^NUDGE Manager is waiting on a prompt.*\(It is Manager itself: the keeper or Steward relays this\.\)$/);
  assert.deepEqual(r.state, { Manager: T, Mainsite: later });
});

test("the alarm: a missing, stale, future or broken reading says nothing and keeps what was sent", () => {
  const now = T + 60 * MIN, state = { Mainsite: T };
  for (const bad of [null, { at: now - 4 * MIN, roles: {} }, { at: now + 2 * MIN, roles: {} }, { at: now, roles: [] }, { at: "x", roles: {} }]) {
    const r = promptAlarm({ config, reading: bad, now, state });
    assert.deepEqual(r, { lines: [], state }, JSON.stringify(bad));
  }
});

test("the alarm: roles off the roster, bad names and bad times are ignored; ask ids are lowercase", () => {
  const now = T + 60 * MIN;
  const r = promptAlarm({ config, reading: reading(now, { Stranger: T, "Main site": T, Builder: "soon", Mainsite: now + MIN }), now, state: {} });
  assert.deepEqual(r.lines, []);
  assert.equal(askId("Mainsite"), "needs-user-mainsite");
});

test("runPromptAlarm reads the probe's file and keeps its state beside the mirror", () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-alarm-"));
  const now = Date.now();
  writeFileSync(join(dir, "waiting-prompt.json"), JSON.stringify({ at: now - 10e3, roles: { Builder: now - 20 * MIN } }));
  assert.equal(runPromptAlarm(dir, config, now).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "prompt-alarm.json"), "utf8")), { Builder: now - 20 * MIN });
  assert.equal(runPromptAlarm(dir, config, now + 60e3).length, 0, "the next run: no repeat");
  assert.deepEqual(runPromptAlarm(mkdtempSync(join(tmpdir(), "prompt-alarm-")), config, now), [], "no file yet: nothing");
});
