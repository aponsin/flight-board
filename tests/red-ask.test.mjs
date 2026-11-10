// The red-ask Stop hook (hooks/red-ask-board.py, the owner's install copies it to ~/.claude/hooks): run on made-up
// transcripts. The answer rule's checks are the ones its own test_red_ask.py held before it came here (#C329).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig } from "../scripts/config.mjs";

const HOOK = fileURLToPath(new URL("../hooks/red-ask-board.py", import.meta.url));
// The hook's verdict on a turn: "" when it lets the turn end, else its reason.
// HOME is a fresh folder unless a test passes one (#C392: the hook reads ~/.flight-board), so the machine's own board
// never leaks in.
export function hook(lines, home = null, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fb-redask-"));
  try {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = spawnSync("python3", [HOOK], { input: JSON.stringify({ transcript_path: path }), encoding: "utf8", env: { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "", ...env, HOME: home ?? dir } });
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
  // #C434 (Manager handed off and kept working, clearing 140k past the line): the cue names the clear as the turn's last act.
  assert.match(cue, /after the handoff note, call mcp__ccd_session_mgmt__clear_session with session_id "self" as the last action of the turn \(nothing after it\)\./);
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

// #C498 (the owner's pick A): Manager cleared itself at 02:52Z and sat idle with Remote Control off until Director sent
// /pickup by hand; the keeper runs hourly. Manager's cue has it ask Steward to watch, before the clear.
test("Manager's reset cue asks Steward to pick it up, before the clear; nobody else's does", () => {
  const order = /send the session titled "Steward" exactly "PICKUP WATCH Manager" \(SendMessage, nothing else in it\), so it picks you up once you're idle; then call mcp__ccd_session_mgmt__clear_session with session_id "self" as the last action of the turn \(nothing after it\)\./;
  const cue = hook(big(turn([], { title: "Manager", text: "go on" })));
  assert.match(cue, /^Context reset cue: this session's context is at 450k tokens/);
  assert.match(cue, order);
  const deferred = turn([], { title: "Manager", text: "go on" });
  deferred.splice(1, 0, { type: "user", timestamp: new Date().toISOString(), message: { content: [{ type: "text", text: "[Artifact comment sent to Claude]\n> do the thing" }] } });
  const later = hook(big(deferred));
  assert.match(later, /deferred one turn/);
  assert.match(later, order, "a deferred cue names it too");
  for (const title of ["Boardsmith", "Steward", "Checker"]) assert.doesNotMatch(hook(big(turn([], { title, text: "go on" }))), /PICKUP WATCH/, `${title}: the keeper picks it up, as before`);
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

// #C825 (the board on the store): the memory tile cue left this hook (the probe keeps the store's ctx evidence), whatever the tile says.
test("no memory tile cue, however stale the tile or far the context has moved", () => {
  const home = mkdtempSync(join(tmpdir(), "fb-tile-"));
  try {
    mkdirSync(join(home, ".flight-board", "BOARD", "mirror", "ctx"), { recursive: true });
    writeFileSync(join(home, ".flight-board", "BOARD", "mirror", "ctx", "Manager.json"), JSON.stringify({ pct: 29, tokens: 290000, at: Date.now() - 18 * 60000 }));
    const l = turn([], { title: "Manager", text: "status" });
    l[2].message.usage = { input_tokens: 390000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    assert.equal(hook(l, home), "");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// The store's tools (#C825): its ask is a waiting item, its post a message in a thread; a red ask on the store was refused once for want of
// an ArtifactData write.
const STORE = "mcp__ef1fd144-2d48-4acf-b314-24af223499c0__";
const storeTurn = (name, { text = "Is the gate live?", title = "Manager", reply = "Not yet." } = {}) => [
  { type: "custom-title", customTitle: title },
  { type: "user", message: { content: [{ type: "text", text }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t0", name, input: {} }] } },
  { type: "assistant", message: { content: [{ type: "text", text: reply }] } },
];
test("the store's ask is the board write a red ask needs; its post answers a question; other store tools do not", () => {
  const red = "\u{1F534} Owner: approve the pack?";
  assert.equal(hook(storeTurn(STORE + "ask", { text: "status", reply: red })), "", "ask is the waiting write");
  assert.match(hook(storeTurn(STORE + "post", { text: "status", reply: red })), /red ask/, "a post is a message, not a waiting item");
  assert.match(hook(storeTurn(STORE + "card_update", { text: "status", reply: red })), /red ask/);
  assert.match(hook(storeTurn("mcp__ef1fd144-2d48-4acf-b314-24af223499c0__ask_close",{ text: "status", reply: red })), /red ask/, "a name that only ends like ask is not the store's");
  assert.match(hook(storeTurn(STORE + "ask_close")), /asked a question this turn/, "ask_close is no answer");
  assert.equal(hook(storeTurn(STORE + "post")), "", "a question answered by a post");
  assert.equal(hook(storeTurn(STORE + "ask")), "", "or by an Answer ask");
  assert.match(hook(storeTurn(STORE + "card_update")), /asked a question this turn/);
  assert.match(hook(storeTurn(STORE + "ask", { text: "Is it?", title: "Manager", reply: red })), /^$/, "ask wrote the waiting item");
});
test("the hook's reasons name the store's tools, and never tell a role to call read_inbox (the lead's door only)", () => {
  const src = readFileSync(HOOK, "utf8");
  assert.doesNotMatch(src, /read_inbox|db_write update|db_get/);
  assert.match(hook(storeTurn("Bash", { text: "status", reply: "\u{1F534} Owner: approve the pack?" })), /store's ask tool/);
  assert.match(hook(storeTurn("Bash")), /store's post tool/);
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
  assert.match(cue, /call mcp__ccd_session_mgmt__clear_session with session_id "self" as the last action of the turn/, "#C434: the deferred cue names the clear too");

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

// #C652: the app replaced ArtifactData with the claude-artifacts server's db_write; a waiting item written with it counts.
test("a db_write to waiting/<id> is the board write a red ask needs; a write elsewhere is not", () => {
  const red = (inputs) => [
    { type: "custom-title", customTitle: "Manager" },
    { type: "user", message: { content: [{ type: "text", text: "go on" }] } },
    { type: "assistant", message: { content: inputs.map((input, n) => ({ type: "tool_use", id: `t${n}`, name: "mcp__claude-artifacts__db_write", input })) } },
    { type: "assistant", message: { content: [{ type: "text", text: "🔴 Pick one: A or B?" }] } },
  ];
  assert.match(hook(red([])), /wrote nothing to the flight board's 'waiting' collection/);
  assert.doesNotMatch(hook(red([{ slug: "x", ops: [{ op: "set", path: "waiting/pick", data: { text: "Pick", done: false } }] }])), /wrote nothing/);
  assert.match(hook(red([{ slug: "x", ops: [{ op: "set", path: "steps/s", data: { at: 1 } }] }])), /wrote nothing/, "a write elsewhere is not the waiting item");
  assert.match(hook(red([{ slug: "x", ops: [{ op: "delete", path: "waiting/pick" }] }])), /wrote nothing/, "a delete is not a write of the item");
});
