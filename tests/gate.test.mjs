// The write gate (gate/): the board's rules on every write, the roles' own tiles, passing states, the stuck line, the
// hand-off and the Stop hook. Fictional board and roles; the cases are the week's misses that each rule answers.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullConfig, checkConfig, boardId } from "../scripts/config.mjs";
import { checkWrites, writeErrors, refusalText } from "../gate/rules.mjs";
import { run, handOff, checkHandOff, readMirror, writesOf } from "../gate/gate.mjs";
import { sessionRole, currentTurn } from "../gate/session.mjs";
import { stopCheck } from "../gate/stop.mjs";

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const config = fullConfig({ artifactUrl: URL_, gate: { transientPrefixes: ["needs-user-"] } });
const now = Date.now() - 1234;
const lead = { role: "Manager", manager: true };
const one = (w, who = lead, state = {}) => checkWrites([w], { config, who, now, state }).errors;
const ok = (errs) => assert.deepEqual(errs, []);
const has = (errs, part) => assert.ok(errs.some((e) => e.includes(part)), `"${part}" in: ${errs.join(" | ")}`);
const ask = (data) => ({ op: "set", collection: "waiting", doc_id: "w", data: { since: now, done: false, text: "Pick one", ...data } });
const two = [{ key: "A", label: "one" }, { key: "B", label: "two" }];

test("the gate's config: known gate fields; the board id comes from its link", () => {
  assert.deepEqual(checkConfig({ gate: { managerRole: "Lead", transientPrefixes: ["x-"], mirrorMaxAgeMin: 30 } }), []);
  assert.ok(checkConfig({ gate: { colour: 1 } }).some((p) => p.includes('unknown field "colour"')));
  assert.ok(checkConfig({ gate: { mirrorMaxAgeMin: 0.5 } }).some((p) => p.startsWith("gate.mirrorMaxAgeMin")));
  assert.equal(boardId(config), "TestBoard01");
  assert.equal(fullConfig({ gate: { managerRole: "Lead" } }).gate.verdictWords.length > 0, true, "defaults kept under a partial gate");
});

// ---- Carried over from the first gate ----

test("an item needs ETA, next step, level and planned version; a complete one passes", () => {
  const e = one({ op: "set", collection: "initiatives", doc_id: "x", data: { name: "X", size: "S", status: "active" } });
  for (const r of ["no ETA", "no next step", "no review level"]) has(e, r);
  ok(one({ op: "set", collection: "initiatives", doc_id: "x", data: { name: "X", size: "S", status: "active", level: "Quick", plannedVersion: "1.0.0", etaLive: Date.now() + 6e5, nextNote: "n", nextNoteAt: now } }));
});

test("times are read from the clock: never in the future, never rounded; a next step carries its time", () => {
  has(one({ op: "update", collection: "initiatives", doc_id: "x", data: { nextNote: "n", nextNoteAt: Date.now() + 10 * 60e3 } }), "future");
  has(one({ op: "set", collection: "steps", doc_id: "s", data: { init: "x", phase: "build", who: "A", kind: "start", at: Math.floor(now / 1e5) * 1e5 } }), "rounded");
  has(one({ op: "update", collection: "initiatives", doc_id: "x", data: { nextNote: "n" } }), "nextNoteAt");
  has(one({ op: "update", collection: "initiatives", doc_id: "x", data: { etaLive: Date.now() - 6e4 } }), "ETA");
});

test("asks: steps for a click, a question for an answer, since on every one, kinds the board draws", () => {
  has(one(ask({ kind: "action", text: "Do it" })), "no steps");
  has(one(ask({ kind: "answer", text: "x" })), "no question");
  has(one({ op: "set", collection: "waiting", doc_id: "w", data: { kind: "answer", text: "x", question: "q", done: false } }), "since");
  ok(one(ask({ kind: "answer", text: "x", question: "q" })));
  has(one({ op: "update", collection: "waiting", doc_id: "w", data: { kind: "look" } }), "not drawn");
  has(one(ask({ kind: "action", steps: ["x"], options: two })), "only on kind");
});

test("steps: a phase from the config, start or end, with who and when", () => {
  has(one({ op: "set", collection: "steps", doc_id: "s", data: { init: "x", phase: "building", who: "A", kind: "start", at: now } }), "phase");
  ok(one({ op: "set", collection: "steps", doc_id: "s", data: { init: "x", phase: "test", who: "A", kind: "end", at: now } }));
  const own = fullConfig({ artifactUrl: URL_, phases: [["make", "Make"], ["done", "Done"]] });
  assert.deepEqual(checkWrites([{ op: "set", collection: "steps", doc_id: "s", data: { init: "x", phase: "make", who: "A", kind: "end", at: now } }], { config: own, who: lead, now, state: {} }).errors, []);
});

test("a batch is checked write by write; one bad write refuses it; closing an ask or deleting is never blocked", () => {
  const e = checkWrites([{ op: "update", collection: "initiatives", doc_id: "a", data: { nextNote: "n", nextNoteAt: now } }, ask({ kind: "action", text: "Do" })], { config, who: lead, now, state: {} }).errors;
  assert.equal(e.length, 1);
  assert.match(e[0], /^waiting\/w: .*no steps/);
  ok(one({ op: "update", collection: "waiting", doc_id: "w", data: { done: true } }));
  ok(one({ op: "delete", collection: "steps", doc_id: "s" }));
});

// ---- Rule 1: decisions and commands ----

test("rule 1: a decision has two options or more, its context, and for a look a screenshot per option", () => {
  has(one(ask({ kind: "decision", options: [{ key: "A", label: "yes" }] })), "at least two options");
  has(one(ask({ kind: "decision", options: two, text: " " })), "context");
  has(one(ask({ kind: "decision", options: two, look: true, images: [{ url: "/_blob/abcdefgh", option: "A" }] })), "missing: B");
  ok(one(ask({ kind: "decision", options: two, look: true, images: [{ url: "/_blob/abcdefgh", option: "A" }, { url: "/_blob/ijklmnop", option: "B" }] })));
  ok(one(ask({ kind: "decision", text: "Should every READY carry a screenshot?", options: two })), "mentioning a screenshot isn't a look question");
});

test("rule 1: a step that holds a command is written {text, cmd}, so the owner gets a Copy button", () => {
  has(one(ask({ kind: "action", steps: ["In a terminal, run npm run ship"] })), "steps[0] holds a command");
  has(one(ask({ kind: "action", steps: ["Open the folder", "Then `git pull`"] })), "steps[1]");
  ok(one(ask({ kind: "action", steps: ["Open Settings, then Domains", { text: "In a terminal:", cmd: "npm run ship" }] })));
});

// ---- Rule 6 (case 7): own tiles ----

test("rule 6, case 7: ctx/<Role> only from that role's session; meta/context agents.<Role> too, except the lead's keeper writes", () => {
  const release = { role: "Release", manager: false };
  ok(one({ op: "set", collection: "ctx", doc_id: "Release", data: { pct: 40, at: now } }, release));
  has(one({ op: "set", collection: "ctx", doc_id: "Manager", data: { pct: 40, at: now } }, release), "Manager's own tile");
  has(one({ op: "set", collection: "ctx", doc_id: "Release", data: { pct: 40, at: now } }, lead), "Release's own tile");
  has(one({ op: "set", collection: "ctx", doc_id: "Release", data: { pct: 40, at: now } }, { role: null, manager: false }), "no role");
  ok(one({ op: "update", collection: "meta", doc_id: "context", data: { agents: { Release: { pct: 41 } } } }, release));
  has(one({ op: "update", collection: "meta", doc_id: "context", data: { agents: { Manager: { pct: 41 } } } }, release), "only agents.Release");
  ok(one({ op: "update", collection: "meta", doc_id: "context", data: { at: now, agents: { Release: { saved: true }, Builder: { pct: 3 } } } }, lead));
});

test("the role is the session's title, never a /pickup in the talk; a title and FLIGHT_BOARD_ROLE that disagree refuse", () => {
  const lines = [{ type: "user", message: { content: "/pickup Manager" } }, { type: "custom-title", customTitle: "Release" }];
  assert.equal(sessionRole(lines).role, "Release");
  assert.equal(sessionRole([{ type: "custom-title", customTitle: "Old" }, { type: "custom-title", customTitle: "Builder" }]).role, "Builder", "the latest title");
  assert.equal(sessionRole([], "Builder").role, "Builder");
  assert.match(sessionRole(lines, "Manager").error, /title is "Release" but FLIGHT_BOARD_ROLE is "Manager"/);
  assert.equal(sessionRole([]).role, null);
});

// ---- Rule 7 (case 8): passing states ----

test("rule 7, case 8: a passing agent state never becomes an item", () => {
  has(one(ask({ kind: "action", steps: ["x"] }) && { ...ask({ kind: "action", steps: ["x"] }), doc_id: "needs-user-1951" }), "passing agent state");
  ok(one({ ...ask({ kind: "action", steps: ["x"] }), doc_id: "release-key" }));
});

// ---- Rule 8: the stuck line ----

test("rule 8: three refusals in a row for one item ask for the stuck line; that write passes; the next good write must clear it", () => {
  const bad = ask({ kind: "action", text: "Do" });
  let state = {};
  let r;
  for (let n = 1; n <= 3; n++) { r = checkWrites([bad], { config, who: lead, now, state }); state = r.state; assert.equal(!!r.stuckNow, n === 3, `refusal ${n}`); }
  assert.deepEqual(r.stuckNow, { item: "waiting:w", reason: "no steps" });
  assert.match(refusalText(r.errors, r.stuckNow, now), /Third refusal in a row for waiting:w[\s\S]*update meta\/stuck \{"waiting:w": \{"reason": "no steps"/);
  r = checkWrites([{ op: "update", collection: "meta", doc_id: "stuck", data: { "waiting:w": { reason: "no steps", at: now } } }], { config, who: lead, now, state });
  assert.deepEqual(r.errors, []);
  state = r.state;
  const good = ask({ kind: "action", text: "Do", steps: ["Open it"] });
  r = checkWrites([good], { config, who: lead, now, state });
  has(r.errors, "clear it in the same batch");
  r = checkWrites([good, { op: "update", collection: "meta", doc_id: "stuck", data: { "waiting:w": { __delete__: true } } }], { config, who: lead, now, state });
  assert.deepEqual(r.errors, []);
  assert.deepEqual({ ...r.state.stuck }, {});
  assert.equal(r.state.refusals["waiting:w"], undefined, "the count starts again");
});

test("rule 8: a good write between refusals resets the count", () => {
  let state = {};
  const bad = ask({ kind: "action", text: "Do" });
  for (const w of [bad, bad, ask({ kind: "action", steps: ["ok"] }), bad, bad]) state = checkWrites([w], { config, who: lead, now, state }).state;
  assert.equal(state.refusals["waiting:w"], 2);
});

// ---- Rule 9 (cases 3, 4, 5): hooks on actions ----

test("rule 9, case 3: a hand-off names its card, and the card exists", () => {
  assert.deepEqual(handOff("Task own-switch-flake (XS): fix it. Board id own-switch-flake."), { ids: ["own-switch-flake"], work: true });
  assert.deepEqual(handOff("Thanks, all good."), { ids: [], work: false });
  assert.match(checkHandOff("New task: build the tabs", { known: new Set(), fresh: true }).errors[0], /names no card/);
  assert.match(checkHandOff("New task (board card demos-reports)", { known: new Set(), fresh: true }).errors[0], /no card demos-reports/);
  assert.deepEqual(checkHandOff("New task (board card demos-reports)", { known: new Set(["demos-reports"]), fresh: true }).errors, []);
  assert.match(checkHandOff("New task (board card demos-reports)", { known: new Set(), fresh: false }).note, /mirror is stale/);
});

const turn = (userText, calls = [], reply = "") => [
  { type: "custom-title", customTitle: "Manager" },
  { type: "user", message: { content: [{ type: "text", text: userText }] } },
  { type: "assistant", message: { content: calls.map((c) => ({ type: "tool_use", name: c.name, input: c.input })) } },
  { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: reply }] } },
];
const boardWrite = (data, collection = "events") => ({ name: "ArtifactData", input: { url: URL_, action: "set", collection, doc_id: "d", data } });

test("rule 9, case 4: a verdict in the lead's reply needs a board write in the same turn", () => {
  assert.match(stopCheck(turn("status?", [], "v1.2.0 shipped."), { config })[0], /says "shipped"/);
  assert.deepEqual(stopCheck(turn("status?", [boardWrite({ at: now, text: "v1.2.0" })], "v1.2.0 shipped."), { config }), []);
  assert.deepEqual(stopCheck(turn("status?", [], "Nothing new."), { config }), []);
  assert.deepEqual(stopCheck(turn("status?", [], "Unshipped yet."), { config }), [], "a word inside another isn't a verdict");
  const builder = turn("status?", [], "It shipped.");
  builder[0].customTitle = "Builder";
  assert.deepEqual(stopCheck(builder, { config }), [], "only the lead role");
});

test("rule 9, case 5: the owner's thread message is answered in its thread, not only in chat", () => {
  const ping = "Board thread [w1]: Owner: Which button?";
  assert.match(stopCheck(turn(ping, [], "The green one."), { config })[0], /answer there/);
  assert.deepEqual(stopCheck(turn(ping, [boardWrite({ thread: "w1", from: "Manager", text: "The green one.", at: now }, "messages")], "Answered."), { config }), []);
  assert.match(stopCheck(turn(ping, [boardWrite({ thread: "w2", from: "Manager", text: "x", at: now }, "messages")], "Answered."), { config })[0], /thread w1/);
});

test("the turn starts at the last message a person sent, not at a tool result", () => {
  const lines = [{ type: "user", message: { content: "old" } }, { type: "assistant", message: { content: [] } }, { type: "user", message: { content: [{ type: "text", text: "new" }] } }, { type: "user", message: { content: [{ type: "tool_result" }] } }];
  assert.equal(currentTurn(lines).length, 2);
});

// ---- The hook end to end, with a state folder and a mirror ----

test("the hook: refuses with reasons, keeps its state, counts cards it let through, reads the mirror for a hand-off", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-gate-"));
  try {
    const cfg = fullConfig({ artifactUrl: URL_, gate: { stateDir: dir } });
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "custom-title", customTitle: "Manager" }) + "\n");
    const call = (tool_name, tool_input) => run({ tool_name, tool_input, transcript_path: transcript }, { config: cfg, env: {} });
    assert.match(call("ArtifactData", { url: URL_, action: "set", collection: "waiting", doc_id: "w", data: { kind: "action", text: "Do", since: now } }).block, /no steps/);
    assert.equal(JSON.parse(readFileSync(join(dir, "TestBoard01", "gate.json"), "utf8")).refusals["waiting:w"], 1);
    assert.deepEqual(call("ArtifactData", { url: "https://claude.ai/" + "artifact/Other01", action: "set", collection: "waiting", doc_id: "w", data: {} }), {}, "another board passes");
    assert.deepEqual(call("ArtifactData", { url: URL_, action: "get", collection: "waiting", doc_id: "w" }), {}, "reads pass");
    const card = { name: "X", size: "S", status: "active", level: "Quick", plannedVersion: "1.0.0", etaLive: Date.now() + 6e5, nextNote: "n", nextNoteAt: now };
    assert.deepEqual(call("ArtifactData", { url: URL_, action: "set", collection: "initiatives", doc_id: "tab-fix", data: card }), {});
    assert.deepEqual(call("SendMessage", { to: "builder", message: "New task, board id tab-fix" }), {}, "a card the gate let through");
    assert.match(call("SendMessage", { to: "builder", message: "New task, board id other-card" }).note, /stale/, "no mirror yet");
    mkdirSync(join(dir, "TestBoard01", "mirror", "initiatives"), { recursive: true });
    writeFileSync(join(dir, "TestBoard01", "mirror", "initiatives", "other-card.json"), "{}");
    assert.deepEqual(call("SendMessage", { to: "builder", message: "New task, board id other-card" }), {});
    assert.match(call("SendMessage", { to: "builder", message: "New task, board id third-card" }).block, /no card third-card/);
    const old = (Date.now() - 31 * 60e3) / 1000;
    utimesSync(join(dir, "TestBoard01", "mirror", "initiatives", "other-card.json"), old, old);
    assert.match(call("SendMessage", { to: "builder", message: "New task, board id third-card" }).note, /stale/);
    assert.equal(readMirror(join(dir, "TestBoard01", "mirror")).docs.initiatives[0].id, "other-card");
    writeFileSync(transcript, JSON.stringify({ type: "custom-title", customTitle: "Release" }) + "\n");
    assert.match(run({ tool_name: "ArtifactData", tool_input: { url: URL_, action: "set", collection: "ctx", doc_id: "Release", data: { pct: 1, at: now } }, transcript_path: transcript }, { config: cfg, env: { FLIGHT_BOARD_ROLE: "Manager" } }).block, /disagree|but FLIGHT_BOARD_ROLE/);
    const file = join(dir, "w.json");
    writeFileSync(file, JSON.stringify({ kind: "answer", text: "x", question: "q", since: now }));
    assert.deepEqual(writesOf({ action: "set", collection: "waiting", doc_id: "a", file_path: file })[0].data.question, "q", "data from file_path");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writeErrors is the per-write rule list the batch uses", () => {
  assert.deepEqual(writeErrors({ op: "update", collection: "waiting", doc_id: "w", data: { done: true } }, { config, who: lead, now }), []);
});

test("the hook entries: the gate on board writes and hand-offs, the Stop check; writing them keeps every other hook and replaces an older one", async () => {
  const { hookEntries, withHooks } = await import("../scripts/hooks.mjs");
  const e = hookEntries("/r/flight-board", "/cfg/board.config.json", "/bin/node");
  assert.equal(e.PreToolUse.matcher, "ArtifactData|SendMessage|mcp__ccd_session_mgmt__send_message");
  assert.equal(e.PreToolUse.hooks[0].command, '"/bin/node" "/r/flight-board/gate/gate.mjs" --config "/cfg/board.config.json"');
  assert.equal(e.Stop.hooks[0].command, '"/bin/node" "/r/flight-board/gate/stop.mjs" --config "/cfg/board.config.json"');
  assert.equal(hookEntries("/r/flight-board", "/Library/Application Support/x.json", "/bin/node").Stop.hooks[0].command, '"/bin/node" "/r/flight-board/gate/stop.mjs" --config "/Library/Application Support/x.json"', "a space stays inside its quotes");
  assert.match(hookEntries("/r/flight-board", '/tmp/a"; rm -rf ~; "b.json', "/bin/node").Stop.hooks[0].command, /--config "\/tmp\/a\\"; rm -rf ~; \\"b\.json"$/, "a quote in a name is escaped");
  const other = { matcher: "Bash", hooks: [{ type: "command", command: "lint.sh" }] };
  const old = { matcher: "ArtifactData", hooks: [{ type: "command", command: "node /old/flight-board/gate/gate.mjs --config x" }] };
  const s = withHooks({ model: "x", hooks: { PreToolUse: [other, old] } }, e);
  assert.equal(s.model, "x");
  assert.deepEqual(s.hooks.PreToolUse, [other, e.PreToolUse]);
  assert.deepEqual(s.hooks.Stop, [e.Stop]);
});

test("case 11: an existing id written with if_version passes the gate; the board's server refuses one without it", () => {
  const r = checkWrites([{ op: "set", collection: "waiting", doc_id: "ans-board-link", data: { kind: "answer", text: "x", question: "q", since: now, done: false } }], { config, who: lead, now, state: {} });
  assert.deepEqual(r.errors, []);
});

test("Checker: an edit in place (str_replace) can't slip a field past the rules; it is refused on the board", () => {
  const r = run({ tool_name: "ArtifactData", tool_input: { action: "str_replace", url: URL_, collection: "waiting", doc_id: "d1", field: "text", old_str: "x", new_str: "" } }, { config: fullConfig({ artifactUrl: URL_, gate: { stateDir: mkdtempSync(join(tmpdir(), "fb-sr-")) } }), env: {} });
  assert.match(r.block, /edit in place can't be checked/);
  has(one({ op: "str_replace", collection: "messages", doc_id: "m", data: { text: "y" } }), "edit in place");
});

test("Checker: only the lead may set or delete the whole of meta/context or meta/stuck; others update their entries", () => {
  const checker = { role: "Checker", manager: false };
  has(one({ op: "set", collection: "meta", doc_id: "context", data: { agents: { Checker: { pct: 10 } } } }, checker), "only Manager may set");
  has(one({ op: "delete", collection: "meta", doc_id: "context" }, checker), "only Manager may delete");
  ok(one({ op: "update", collection: "meta", doc_id: "context", data: { agents: { Checker: { pct: 10 } } } }, checker));
  ok(one({ op: "set", collection: "meta", doc_id: "context", data: { at: now, agents: {} } }, lead));
  has(checkWrites([{ op: "delete", collection: "meta", doc_id: "stuck" }], { config, who: checker, now, state: {} }).errors, "only Manager may delete the whole stuck line");
  has(checkWrites([{ op: "set", collection: "meta", doc_id: "stuck", data: {} }], { config, who: checker, now, state: {} }).errors, "only Manager may set");
  assert.deepEqual(checkWrites([{ op: "update", collection: "meta", doc_id: "stuck", data: { "waiting:w": { reason: "r", at: now } } }], { config, who: checker, now, state: {} }).errors, []);
  assert.deepEqual(checkWrites([{ op: "delete", collection: "meta", doc_id: "stuck" }], { config, who: lead, now, state: {} }).errors, []);
});
