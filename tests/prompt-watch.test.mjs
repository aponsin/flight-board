// The watchdog reads the probe's stop, not the transcript cursor (#C529: "not stuck" 20 times overnight while a role sat on
// a site approval, since the app's notices kept moving the cursor). The probe names the prompt's tool class; the watchdog's
// script pushes once per stop past 30 min, by day; the Collector's NUDGE names the prompt too. Fictional roles and board.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, utimesSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { promptTool, activity, agentStates } from "../collector/state.mjs";
import { promptAlarm, promptName } from "../collector/prompt-alarm.mjs";
import { promptWatch, STUCK_MS, MAX_LINE } from "../scripts/prompt-watch.mjs";
import { fullConfig } from "../scripts/config.mjs";

const T = Date.parse("2026-10-31T11:50:58Z"), MIN = 60e3;
const at = (t) => new Date(t).toISOString();
const prompt = (t) => ({ type: "user", timestamp: at(t), message: { content: "go on" } });
const call = (t, id, name) => ({ type: "assistant", timestamp: at(t), message: { stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input: { url: "https://example.test/secret" } }] } });
const result = (t, id) => ({ type: "user", timestamp: at(t), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
// The night's shape. While the call waited, the app wrote only a queued-notice line (a real 599-min wait: one
// queue-operation and nothing else): it moves the cursor, not the stop.
const queued = (t) => ({ type: "queue-operation", operation: "enqueue", timestamp: at(t), content: "<system-reminder>Linked sessions now …</system-reminder>" });
const night = [prompt(T - 5 * MIN), call(T - 2 * MIN, "a", "Bash"), result(T - MIN, "a"), call(T, "b", "mcp__Claude_Browser__navigate"), queued(T + 10 * MIN)];

test("promptTool: the waiting call's class from the enum, never its input; null when nothing waits", () => {
  const opts = { mtimeMs: T, now: T + 20 * MIN };
  assert.equal(promptTool(night.slice(0, 4), opts), "mcp");
  assert.equal(promptTool([prompt(T - MIN), call(T, "q", "AskUserQuestion")], opts), "AskUserQuestion");
  assert.equal(promptTool([prompt(T - MIN), call(T, "q", "Bash")], opts), "Bash");
  assert.equal(promptTool([prompt(T - MIN), call(T, "q", "SomeNewTool")], opts), "other");
  assert.equal(promptTool([prompt(T - MIN), call(T, "q", "Bash"), result(T + 1000, "q")], opts), null, "answered");
  assert.equal(promptTool([prompt(T - MIN), call(T, "q", "Bash")], { mtimeMs: T, now: T + 15 * MIN }), null, "still working");
  assert.equal(promptTool([prompt(T - MIN), call(T, "q", "Agent")], opts), null, "a subagent");
  const a = activity(night.slice(0, 4), { mtimeMs: T, now: T + 20 * MIN, ids: new Set(), nums: new Map() });
  assert.equal(a.promptTool, "mcp");
  assert.ok(!JSON.stringify(a).includes("secret"), "the call's input never comes along");
});

test("agentStates: tools gets each stopped role's prompt class beside prompts; the agent record doesn't", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "watch-home-")), cwd = "/Users/x/Code/teamrepo";
  const proj = join(homeDir, ".claude", "projects", "-Users-x-Code-teamrepo");
  mkdirSync(proj, { recursive: true });
  const id = "00000000-0000-4000-8000-000000000003";
  writeFileSync(join(proj, `${id}.jsonl`), night.map((e) => JSON.stringify(e)).join("\n") + "\n");
  utimesSync(join(proj, `${id}.jsonl`), new Date(T + 10 * MIN), new Date(T + 10 * MIN));
  const prompts = {}, tools = {};
  const agents = agentStates({ roles: ["Mainsite"], sessions: [{ title: "Mainsite", transcript: id, cwd, at: T }], homeDir, now: T + 60 * MIN, ids: new Set(), nums: new Map(), prompts, tools });
  assert.deepEqual(prompts, { Mainsite: T });
  assert.deepEqual(tools, { Mainsite: "mcp" });
  assert.deepEqual(Object.keys(agents.Mainsite).sort(), ["by", "card", "lastActivityAt", "since", "state", "tool"]);
});

test("promptName: a few fixed words per class; anything else is just 'a prompt'", () => {
  assert.equal(promptName("mcp"), "an app or site approval");
  assert.equal(promptName("Bash"), "a command approval");
  assert.equal(promptName("AskUserQuestion"), "a question");
  assert.equal(promptName("Write"), "a file-edit approval");
  assert.equal(promptName("Read"), "a Read approval");
  for (const bad of [null, undefined, "other", "Agent", "a\nb", "toString", "__proto__", 7]) assert.equal(promptName(bad), "a prompt", String(bad));
});

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", roster: ["Manager", "Mainsite", "Builder", "Checker"] });
const reading = (now, roles, tools = {}) => ({ at: now - 30e3, roles, tools });

test("the Collector's NUDGE names the prompt from the reading's tools", () => {
  const now = T + 20 * MIN;
  const r = promptAlarm({ config, reading: reading(now, { Mainsite: T }, { Mainsite: "mcp" }), now, state: {} });
  assert.match(r.lines[0], /^NUDGE Mainsite is waiting on an app or site approval in its session since 11:50Z \(20 min\): .*text "Mainsite is waiting on an app or site approval in its session: open it in the Claude app and answer it"\) unless it is open, and push the owner once, naming an app or site approval\.$/);
  const old = promptAlarm({ config, reading: { at: now - 30e3, roles: { Mainsite: T } }, now, state: {} });
  assert.match(old.lines[0], /waiting on a prompt in its session/, "a reading from before #C529 (no tools): 'a prompt'");
});

const roster = config.roster, day = 12, night0 = 3;

test("the watchdog: once a stop is 30 min old, one line naming the role, the minutes and the prompt; no repeat", () => {
  let now = T + 29 * MIN, r = promptWatch({ roster, reading: reading(now, { Mainsite: T }, { Mainsite: "mcp" }), now, hour: day });
  assert.equal(r.line, null, "29 min: not yet");
  assert.deepEqual(r.state, {});
  now = T + STUCK_MS; r = promptWatch({ roster, reading: reading(now, { Mainsite: T }, { Mainsite: "mcp" }), now, hour: day, state: r.state });
  assert.equal(r.line, "Mainsite (30 min, an app or site approval) is waiting on a prompt in its session: open it in the Claude app and answer it.");
  assert.deepEqual(r.state, { Mainsite: T });
  for (const m of [60, 120, 600]) { now = T + m * MIN; r = promptWatch({ roster, reading: reading(now, { Mainsite: T }, { Mainsite: "mcp" }), now, hour: day, state: r.state }); assert.equal(r.line, null, `${m} min: no repeat`); }
  now = T + 601 * MIN; r = promptWatch({ roster, reading: reading(now, {}), now, hour: day, state: r.state });
  assert.equal(r.line, null);
  assert.deepEqual(r.state, {}, "moved on: forgotten");
  now = T + 700 * MIN; r = promptWatch({ roster, reading: reading(now, { Mainsite: T + 650 * MIN }), now, hour: day, state: r.state });
  assert.match(r.line, /^Mainsite \(50 min, a prompt\) is waiting/, "a new stop is a new push");
});

test("the watchdog: at night it holds the push (and records nothing), then pushes at the first run by day", () => {
  let now = T + 60 * MIN, r = promptWatch({ roster, reading: reading(now, { Builder: T }, { Builder: "Bash" }), now, hour: night0 });
  assert.equal(r.line, null);
  assert.deepEqual(r.state, {});
  r = promptWatch({ roster, reading: reading(now, { Builder: T }, { Builder: "Bash" }), now, hour: 22, state: r.state });
  assert.equal(r.line, null, "22:00 is night");
  now = T + 240 * MIN; r = promptWatch({ roster, reading: reading(now, { Builder: T }, { Builder: "Bash" }), now, hour: 7, state: r.state });
  assert.match(r.line, /^Builder \(240 min, a command approval\)/);
});

test("the watchdog: several due at once go in one line, in role order, kept under 200 characters", () => {
  const now = T + 45 * MIN;
  let r = promptWatch({ roster, reading: reading(now, { Mainsite: T, Builder: T + MIN }, { Mainsite: "mcp", Builder: "AskUserQuestion" }), now, hour: day });
  assert.equal(r.line, "Builder (44 min, a question), Mainsite (45 min, an app or site approval) are waiting on a prompt in their sessions: open each in the Claude app and answer it.");
  r = promptWatch({ roster, reading: reading(now, { Mainsite: T, Builder: T, Checker: T, Manager: T }, { Mainsite: "mcp", Builder: "mcp", Checker: "mcp", Manager: "mcp" }), now, hour: day });
  assert.ok(r.line.length <= MAX_LINE, r.line);
  assert.match(r.line, /^Builder \(45 min, an app or site approval\), Checker \(45 min, an app or site approval\) and 2 more are waiting/);
  assert.deepEqual(Object.keys(r.state).sort(), ["Builder", "Checker", "Mainsite", "Manager"], "all four are pushed, shown or not");
});

test("the watchdog: a missing, stale, future or broken reading says nothing and keeps its state; off-roster and bad entries never show", () => {
  const now = T + 60 * MIN, state = { Mainsite: T };
  for (const bad of [null, { at: now - 4 * MIN, roles: { Builder: T } }, { at: now + 2 * MIN, roles: { Builder: T } }, { at: now, roles: [] }, { at: "x", roles: {} }]) {
    assert.deepEqual(promptWatch({ roster, reading: bad, now, hour: day, state }), { line: null, state }, JSON.stringify(bad));
  }
  const r = promptWatch({ roster, reading: reading(now, { Stranger: T, "Main site": T, Builder: "soon", Checker: now + MIN }, { Checker: "Bash\u001b[2J" }), now, hour: day });
  assert.equal(r.line, null);
  const odd = promptWatch({ roster, reading: reading(now, { Checker: T }, { Checker: "Bash\u001b[2J" }), now, hour: day });
  assert.match(odd.line, /^Checker \(60 min, a prompt\)/, "a class the enum doesn't know is never printed");
});

test("the script: reads the probe's file under stateDir, writes its state 0600, pushes once; no file or no config: silent", () => {
  const home = mkdtempSync(join(tmpdir(), "watch-cli-")), stateDir = join(home, "fb"), board = "TestBoard01";
  mkdirSync(join(stateDir, board), { recursive: true });
  const cfg = join(home, "board.config.json");
  writeFileSync(cfg, JSON.stringify({ artifactUrl: "https://claude.ai/" + `artifact/${board}`, roster: ["Mainsite"], gate: { stateDir } }));
  const script = new URL("../scripts/prompt-watch.mjs", import.meta.url).pathname;
  const run = (args) => execFileSync("node", [script, ...args], { encoding: "utf8", env: { ...process.env, TZ: "UTC" } });
  assert.equal(run(["--config", cfg]), "", "no reading yet");
  assert.ok(!existsSync(join(stateDir, board, "prompt-watch.json")), "nothing to record: no write");
  const now = Date.now(), hour = new Date(now).getUTCHours();
  writeFileSync(join(stateDir, board, "waiting-prompt.json"), JSON.stringify({ at: now - 10e3, roles: { Mainsite: now - 40 * MIN }, tools: { Mainsite: "Bash" } }));
  const out = run(["--config", cfg]);
  if (hour >= 7 && hour < 22) {
    assert.match(out, /^Mainsite \(40 min, a command approval\) is waiting on a prompt in its session/);
    assert.equal(statSync(join(stateDir, board, "prompt-watch.json")).mode & 0o777, 0o600);
    assert.equal(run(["--config", cfg]), "", "the next run: no repeat");
  } else assert.equal(out, "", "night (UTC here): held");
  assert.match(readFileSync(new URL("../scripts/prompt-watch.mjs", import.meta.url), "utf8"), /flag: "wx"/, "the tmp file is created, never opened through a link (Security)");
  assert.equal(run(["--config", join(home, "missing.json")]), "");
  assert.equal(run([]), "");
});
