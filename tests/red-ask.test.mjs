// The red-ask Stop hook (hooks/red-ask-board.py, the owner's install copies it to ~/.claude/hooks): run on made-up
// transcripts. The answer rule's checks are the ones its own test_red_ask.py held before it came here (#C329).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig } from "../scripts/config.mjs";

const HOOK = fileURLToPath(new URL("../hooks/red-ask-board.py", import.meta.url));
// The hook's verdict on a turn: "" when it lets the turn end, else its reason.
// HOME is a fresh folder unless a test passes one (#C392: the hook reads ~/.flight-board), so the machine's own board
// never leaks in.
export function hook(lines, home = null) {
  const dir = mkdtempSync(join(tmpdir(), "fb-redask-"));
  try {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = spawnSync("python3", [HOOK], { input: JSON.stringify({ transcript_path: path }), encoding: "utf8", env: { ...process.env, HOME: home ?? dir } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).reason : "";
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const turn = (calls, { text = "Is the gate live?", title = "Manager", results = [] } = {}) => [
  { type: "custom-title", customTitle: title },
  { type: "user", message: { content: [{ type: "text", text }] } },
  { type: "assistant", message: { content: calls.map((input, n) => ({ type: "tool_use", id: `t${n}`, name: "ArtifactData", input })) } },
  ...results.map(([n, content]) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${n}`, content }] } })),
  { type: "assistant", message: { content: [{ type: "text", text: "Not yet." }] } },
];

// #C334: the waiting read and the memory tile left this hook (the Stop gate sees open asks itself; the Collector
// writes the tile). A Manager turn with no question, no red ask, no read: nothing to say.
test("no read and no tile are asked of Manager any more", () => {
  const lines = turn([], { text: "status" });
  lines[2].message.usage = { input_tokens: 90000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  assert.equal(hook(lines), "");
  lines[2].message.usage.input_tokens = 900000;
  assert.doesNotMatch(hook(lines), /memory tile/, "a large context is the reset cue's (#C350), never the old tile rule");
});

// #C350: the reset cue. A titled session whose context (its latest call's input, cache read and cache written tokens)
// is over 400k (#C384: the owner raised the limit from 200k) is told to hand off once its work is safe, unless this turn
// already reset it.
const big = (lines, { input = 1000, read = 449000, made = 0 } = {}) => {
  lines.filter((l) => l.type === "assistant").forEach((l) => { l.message.usage = { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: made }; });
  return lines;
};
test("the reset cue: over 400k tokens a titled session is told to hand off; at 400k or under, nothing", () => {
  const cue = hook(big(turn([], { title: "Boardsmith", text: "go on" })));
  assert.match(cue, /^Context reset cue: this session's context is at 450k tokens, over 400k\. /);
  assert.match(cue, /\/handoff/);
  assert.equal(hook(big(turn([], { title: "Boardsmith", text: "go on" }), { input: 0, read: 400000 })), "", "400k is not over");
  assert.equal(hook(big(turn([], { title: "Boardsmith", text: "go on" }), { input: 1000, read: 310000 })), "", "311k: tonight's false cue, gone");
  assert.match(hook(big(turn([], { title: "Boardsmith", text: "go on" }), { input: 1000, read: 350000, made: 60000 })), /at 411k tokens/, "the three counts together");
  assert.equal(hook(big(turn([], { title: "", text: "go on" }))), "", "an untitled session (not an agent) gets no cue");
  const lines = big(turn([], { title: "Boardsmith", text: "go on" }));
  lines.push({ type: "assistant", message: { content: [{ type: "text", text: "and a later call" }], usage: { input_tokens: 5000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  assert.equal(hook(lines), "", "the latest call counts, not the largest");
  const side = turn([], { title: "Boardsmith", text: "go on" });
  side.push({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "a subagent" }], usage: { input_tokens: 5000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  side[2].message.usage = { input_tokens: 450000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  assert.match(hook(side), /at 450k tokens/, "a subagent's call is not this session's context");
});

test("the reset cue's guard: a turn that already handed off, cleared or compacted passes", () => {
  const t = (text) => hook(big(turn([], { title: "Boardsmith", text })));
  assert.equal(t("<command-name>/handoff</command-name>"), "", "the owner typed /handoff");
  assert.equal(t("<command-name>/clear</command-name>"), "");
  assert.equal(t("<command-name>/compact</command-name>"), "");
  assert.equal(t("Another Claude session sent a message: CONTEXT RESET"), "", "the keeper's cue: this turn is the reset");
  const skill = big(turn([], { title: "Boardsmith", text: "go on" }));
  skill.splice(3, 0, { type: "assistant", message: { content: [{ type: "tool_use", id: "s1", name: "Skill", input: { skill: "handoff" } }] } });
  big(skill);
  assert.equal(hook(skill), "", "the agent ran the handoff skill this turn");
  const cleared = big(turn([], { title: "Boardsmith", text: "go on" }));
  cleared.splice(3, 0, { type: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "mcp__ccd_session_mgmt__clear_session", input: {} }] } });
  big(cleared);
  assert.equal(hook(cleared), "", "it asked the app to clear it");
  // Checker's LOW on bcadb2a: clearing another session isn't this session's reset.
  const other = big(turn([], { title: "Manager", text: "go on" }));
  other.splice(3, 0, { type: "assistant", message: { content: [{ type: "tool_use", id: "c2", name: "mcp__ccd_session_mgmt__clear_session", input: { session_id: "local_0b7edc70" } }] } });
  big(other);
  assert.match(hook(other), /reset cue/, "another session cleared: this one's cue stays");
  const self = big(turn([], { title: "Manager", text: "go on" }));
  self.splice(3, 0, { type: "assistant", message: { content: [{ type: "tool_use", id: "c3", name: "mcp__ccd_session_mgmt__clear_session", input: { session_id: "self" } }] } });
  big(self);
  assert.equal(hook(self), "", "session_id self: this one");
  const compacted = big(turn([], { title: "Boardsmith", text: "go on" }));
  compacted.push({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" });
  assert.equal(hook(compacted), "", "a compaction after the last call: the old count is gone");
  assert.match(hook(big(turn([], { title: "Boardsmith", text: "/handoff later, please" }))), /reset cue/, "only the command itself, not the word");
  assert.match(hook(big(turn([], { title: "Boardsmith", text: "CONTEXT RESET is what the keeper sends" }))), /reset cue/, "only the keeper's cue by itself");
});

test("the reset cue rides with the red-ask and answer rules: one reason line each", () => {
  const lines = big(turn([], { title: "Manager" }));
  const r = hook(lines);
  assert.match(r, /asked a question this turn/);
  assert.match(r, /Context reset cue: /);
});

test("the answer rule: the owner's question needs a board answer, in a thread or an ans- item; Manager is the title", () => {
  assert.match(hook(turn([])), /asked a question this turn/);
  assert.doesNotMatch(hook(turn([{ action: "set", collection: "messages", doc_id: "m1", data: { thread: "w1", from: "Manager", text: "Not yet.", at: 1 } }])), /asked a question/);
  assert.doesNotMatch(hook(turn([{ action: "batch", writes: [{ op: "set", collection: "messages", doc_id: "m1", data: { thread: "w1" } }] }])), /asked a question/);
  assert.doesNotMatch(hook(turn([{ action: "set", collection: "waiting", doc_id: "ans-gate", data: { kind: "answer" } }])), /asked a question/);
  assert.match(hook(turn([{ action: "list", collection: "messages" }])), /asked a question this turn/, "a read of messages isn't an answer");
  const builder = hook(turn([], { title: "Builder", text: "/pickup Manager quoted in a test? <command-name>/pickup</command-name><command-args>Manager</command-args>" }));
  assert.doesNotMatch(builder, /asked a question|memory tile/, "Builder isn't Manager");
});

// #C399 (the owner's 600k in #T1038): the limit is the board config's resetAt, the config the board's Stop gate is
// registered with in ~/.claude/settings.json; none, or a bad value, is 400k as before.
const configHome = (resetAt, raw) => {
  const home = mkdtempSync(join(tmpdir(), "fb-cfg-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const cfg = join(home, "board.config.json");
  writeFileSync(cfg, raw ?? JSON.stringify({ owner: "Owner", ...(resetAt === undefined ? {} : { resetAt }) }));
  const stop = `'/n/node' '${home}/.flight-board/install/${"a".repeat(40)}/gate/stop.mjs' --config '${cfg}'`;
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "python3 ~/.claude/hooks/red-ask-board.py" }, { type: "command", command: stop }] }] } }));
  return home;
};
test("resetAt: a config value, checked", () => {
  assert.deepEqual(checkConfig({ resetAt: 600000 }), []);
  for (const bad of [50000, 600000.5, "600000", 3000000]) assert.deepEqual(checkConfig({ resetAt: bad }), ["resetAt: whole tokens, 100,000 to 2,000,000"], String(bad));
  assert.equal(fullConfig({}).resetAt, 400000);
});
test("the reset limit is the board config's resetAt: 600k cues over 600k, not at 450k; no config or a bad value, 400k", () => {
  const t = (read) => big(turn([], { title: "Boardsmith", text: "go on" }), { input: 1000, read });
  const six = configHome(600000);
  try {
    assert.equal(hook(t(449000), six), "", "450k: under the owner's 600k");
    assert.match(hook(t(609000), six), /^Context reset cue: this session's context is at 610k tokens, over 600k\. /);
    assert.equal(hook(t(599000), six), "", "600k is not over");
  } finally { rmSync(six, { recursive: true, force: true }); }
  for (const bad of [undefined, "600000", 50000, 600000.5, true]) {
    const h = configHome(bad);
    try { assert.match(hook(t(449000), h), /over 400k/, `resetAt ${JSON.stringify(bad)}: 400k`); } finally { rmSync(h, { recursive: true, force: true }); }
  }
});
// Security's LOW on 5b07a2c: checkConfig takes 600000.0 and 6e5 (whole numbers in JSON), but Python's json.load reads
// them as floats; the hook took only ints, so the config said 600k and the hook cued at 400k.
test("a whole resetAt written as 600000.0 or 6e5 is 600k to the hook too, as it is to checkConfig", () => {
  const t = (read) => big(turn([], { title: "Boardsmith", text: "go on" }), { input: 1000, read });
  for (const text of ["600000.0", "6e5", "6.0e5"]) {
    assert.deepEqual(checkConfig(JSON.parse(`{"resetAt": ${text}}`)), [], text);
    const h = configHome(undefined, `{"owner": "Owner", "resetAt": ${text}}`);
    try {
      assert.equal(hook(t(449000), h), "", `${text}: not cued at 450k`);
      assert.match(hook(t(609000), h), /over 600k\. /, text);
    } finally { rmSync(h, { recursive: true, force: true }); }
  }
  const h = configHome(undefined, `{"owner": "Owner", "resetAt": 6.000005e5}`);
  try { assert.match(hook(t(449000), h), /over 400k/, "600000.5 stays refused"); } finally { rmSync(h, { recursive: true, force: true }); }
});

// #C392 (b), Manager's pick A: the live memory tile. The hook asks the agent to write ctx/<Role> when the board's tile is
// 30+ min old or 5+ points off; the window comes from the Collector's reading on this machine (tokens over pct).
const tileHome = (role, reading) => {
  const home = mkdtempSync(join(tmpdir(), "fb-home-"));
  const d = join(home, ".flight-board", "Board1", "mirror", "ctx");
  mkdirSync(d, { recursive: true });
  if (reading) writeFileSync(join(d, `${role}.json`), JSON.stringify(reading));
  return home;
};
const at1 = (tokens, title = "Manager") => { const l = turn([], { title, text: "status" }); l[2].message.usage = { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }; return l; };
test("the live tile: asked when the board's tile is 5+ points off or 30+ min old, once, on the Collector's window", () => {
  const now = Date.now();
  const home = tileHome("Manager", { pct: 34, tokens: 340000, at: now - 18 * 60e3 });
  try {
    const r = hook(at1(390000), home);
    assert.match(r, /^Memory tile: your context is 39% of its window \(390k tokens\); the board's tile says 34%, 18 min old\. /);
    assert.match(r, /ArtifactData get ctx\/Manager for its version, then set ctx\/Manager \{"pct": 39, "tokens": 390000, "at": \d{13}\}/);
    assert.equal(hook(at1(391000), home), "", "asked already: the next turn, still 39%, says nothing");
    assert.equal(hook(at1(420000), home).includes("Memory tile"), false, "3 points on from what it last asked: nothing");
    assert.match(hook(at1(440000), home), /Memory tile: your context is 44%/, "5 points on from what it last asked");
  } finally { rmSync(home, { recursive: true, force: true }); }
  const fresh = tileHome("Manager", { pct: 42, tokens: 420000, at: now - 10 * 60e3 });
  try { assert.equal(hook(at1(400000), fresh), "", "2 points off, 10 min old: nothing"); } finally { rmSync(fresh, { recursive: true, force: true }); }
  const old = tileHome("Manager", { pct: 43, tokens: 430000, at: now - 31 * 60e3 });
  try { assert.match(hook(at1(430000), old), /says 43%, 31 min old/, "the same number, but 31 min old"); } finally { rmSync(old, { recursive: true, force: true }); }
  const small = tileHome("Builder", { pct: 50, tokens: 100000, at: now - 40 * 60e3 });
  try { assert.match(hook(at1(120000, "Builder"), small), /your context is 60% of its window/, "a 200k window, from 100k at 50%"); } finally { rmSync(small, { recursive: true, force: true }); }
  const none = tileHome("Manager", null);
  try { assert.doesNotMatch(hook(at1(430000, "Collector"), none), /Memory tile/, "no tile for the role on this machine: never asked"); } finally { rmSync(none, { recursive: true, force: true }); }
});

// #C392: the cue waits one turn while the owner is in the middle of something. Manager's 06:31Z reset threw away the
// board auto-replies the owner had turned on at 06:30Z. Times are the transcript's own ("now" is its newest entry).
const at = (iso, lines) => { lines.forEach((l) => { if (l.type !== "custom-title") l.timestamp = iso; }); return lines; };
const fb = (text, ts) => ({ type: "user", isMeta: true, timestamp: ts, message: { role: "user", content: `Stop hook feedback:\n${text}` } });
test("the reset cue defers one turn while the owner wrote under 10 minutes ago, or an ask of theirs is open", () => {
  const owner = at("2026-10-28T06:30:00.000Z", turn([], { title: "Manager", text: "Turn the board's comment auto-replies back on." }));
  owner.at(-1).timestamp = "2026-10-28T06:31:00.000Z";
  const cue = hook(big(owner));
  assert.match(cue, /^Context reset cue: deferred one turn\. This session's context is at 450k tokens, over 400k, but the owner wrote 1 min ago/);
  assert.match(cue, /"resetting after this" on the board/);
  assert.match(cue, /reset with \/handoff at the end of the next one/);

  const later = at("2026-10-28T06:30:00.000Z", turn([], { title: "Manager", text: "Turn the board's comment auto-replies back on." }));
  later.at(-1).timestamp = "2026-10-28T06:41:00.000Z";
  assert.match(hook(big(later)), /^Context reset cue: this session's context/, "11 minutes on: the cue as before");

  const noTimes = big(turn([], { title: "Boardsmith", text: "go on" }));
  assert.match(hook(noTimes), /^Context reset cue: this session's context/, "no times in the transcript: as before");

  const asked = at("2026-10-28T05:00:00.000Z", turn([], { title: "Builder", text: "go on" }));
  asked.at(-1).message.content = [{ type: "text", text: "🔴 Which colour?" }];
  asked.at(-1).timestamp = "2026-10-28T06:00:00.000Z";
  assert.match(hook(big(asked)), /deferred one turn.*an ask of the owner's is open/, "a red ask this turn waits on the owner");

  const other = at("2026-10-28T06:30:00.000Z", [{ type: "custom-title", customTitle: "Boardsmith" },
    { type: "user", message: { content: "<cross-session-message from=\"x\">go on</cross-session-message>" } },
    { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }]);
  assert.match(hook(big(other)), /^Context reset cue: this session's context/, "another session's message isn't the owner's");
});

test("the deferral is one turn: a deferred cue since the last reset means this one resets", () => {
  const lines = [
    { type: "custom-title", customTitle: "Manager" },
    { type: "user", timestamp: "2026-10-28T06:30:00.000Z", message: { content: "Turn the board's comment auto-replies back on." } },
    { type: "assistant", timestamp: "2026-10-28T06:30:30.000Z", message: { content: [{ type: "text", text: "Done." }] } },
    fb("Context reset cue: deferred one turn. This session's context is at 410k tokens…", "2026-10-28T06:30:31.000Z"),
    { type: "assistant", timestamp: "2026-10-28T06:30:40.000Z", message: { content: [{ type: "text", text: "Wrote it." }] } },
    { type: "user", timestamp: "2026-10-28T06:32:00.000Z", message: { content: "and the tiles" } },
    { type: "assistant", timestamp: "2026-10-28T06:32:30.000Z", message: { content: [{ type: "text", text: "Here." }] } },
  ];
  assert.match(hook(big(lines)), /^Context reset cue: this session's context is at 450k/);
  const reset = [...lines.slice(0, 5), { type: "user", timestamp: "2026-10-28T06:31:00.000Z", message: { content: "<command-name>/compact</command-name>" } }, ...lines.slice(5)];
  assert.match(hook(big(reset)), /deferred one turn/, "a reset since: the next cue may wait again");
});
