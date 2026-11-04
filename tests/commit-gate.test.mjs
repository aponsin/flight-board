// The commit gate and the READY check (#C649): a git commit tagged "#C<num>:" is refused until the committer has a PLAIN build
// start step on that card, a READY is refused until the builder's end step exists, and the hook on Bash fails OPEN on any
// error of its own. Fictional board and roles.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullConfig } from "../scripts/config.mjs";
import { commitCardNum, commitError, readyError, buildState, isReady, namedCards, startWrite, endWrite } from "../gate/build-steps.mjs";
import { run as commitRun } from "../gate/commit.mjs";
import { run as gateRun } from "../gate/gate.mjs";

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const NOW = 1_793_800_000_000;
const MAX = 40 * 60e3;
const card = { id: "menu-fix", num: 701 };
const step = (kind, at, over = {}) => ({ id: `menu-fix-build-${kind}-${at}`, init: "menu-fix", phase: "build", who: "Builder", kind, at, ...over });
const mirrorOf = (steps, at = NOW - 60e3, cards = [card]) => ({ docs: { initiatives: cards, steps }, at });

test("commitCardNum: only a git commit whose message STARTS with #C<num>: is tagged", () => {
  const yes = [
    'git commit -m "#C701: The menu opens"',
    "git commit -m '#C701: The menu opens'",
    'git commit -am "#C701: x"',
    'git commit --message="#C701: x"',
    'git -C /tmp/wt commit -m "#C701: x"',
    'git commit -m "$(cat <<\'EOF\'\n#C701: The menu opens\n\nBody\nEOF\n)"',
    'git add -A && git commit -m "#C701: x"',
  ];
  for (const c of yes) assert.equal(commitCardNum(c), 701, c);
  const no = [
    'git commit -m "The menu opens (#C701, Manager)"',
    'git commit -m "Fix #C701: later in the line"',
    'git log --grep "#C701:"',
    'echo "#C701: hello"',
    "git status",
    "ls",
    "",
    undefined,
    42,
    'git commit -m "no tag"',
  ];
  for (const c of no) assert.equal(commitCardNum(c), null, String(c));
});

test("buildState: only a PLAIN build start by the role on the card counts; an end counts only after it", () => {
  const s = (list) => buildState(mirrorOf(list), "Builder", "menu-fix");
  assert.deepEqual(s([]), { steps: false, started: null, ended: false });
  assert.equal(s([step("start", 1000, { wait: "busy" })]).started, null, "a busy start is not started");
  assert.equal(s([step("start", 1000, { wait: "gate" })]).started, null, "nor a gated one");
  assert.equal(s([step("start", 1000)]).started, 1000);
  assert.equal(s([step("start", 1000, { who: "Other" })]).started, null, "another role's start");
  assert.equal(s([step("start", 1000, { init: "other-card" })]).started, null, "another card's start");
  assert.equal(s([step("start", 1000, { phase: "checker" })]).started, null, "another phase");
  assert.equal(s([step("start", 1000), step("end", 900)]).ended, false, "an end before the start");
  assert.equal(s([step("start", 1000), step("end", 2000)]).ended, true);
  assert.equal(s([step("start", 1000), step("end", 2000), step("start", 3000)]).ended, false, "a newer start reopens it");
  assert.equal(s([step("end", 2000)]).ended, false, "an end with no start");
});

test("commitError: refused with the exact write when the committer has no plain start; every doubt passes", () => {
  const args = { num: 701, role: "Builder", now: NOW, maxAgeMs: MAX };
  const some = [step("start", NOW - 9e6, { who: "Other" })]; // steps are loaded, but not the committer's
  const e = commitError({ ...args, mirror: mirrorOf(some) });
  assert.match(e, /tagged #C701 \(card menu-fix\) but Builder has no plain build start step/);
  assert.match(e, /A start with a wait \(busy\) means not started/);
  assert.ok(e.includes(startWrite("menu-fix", "Builder", NOW)), "the exact write, with the clock");
  assert.match(commitError({ ...args, mirror: mirrorOf([step("start", NOW - 9e6, { wait: "busy" })]) }), /no plain build start/, "a busy start does not open it");
  assert.equal(commitError({ ...args, mirror: mirrorOf([step("start", NOW - 9e6)]) }), null, "a plain start opens it");
  assert.equal(commitError({ ...args, mirror: mirrorOf([step("start", NOW - 9e6), step("end", NOW - 8e6)]) }), null, "after the end: the commit is not this rule's");
  // Fail open: no role, no mirror, a stale mirror, an unknown card, no steps loaded.
  assert.equal(commitError({ ...args, role: null, mirror: mirrorOf(some) }), null);
  assert.equal(commitError({ ...args, mirror: null }), null);
  assert.equal(commitError({ ...args, mirror: mirrorOf(some, NOW - MAX - 1) }), null, "a stale mirror");
  assert.equal(commitError({ ...args, num: 999, mirror: mirrorOf(some) }), null, "no such card");
  assert.equal(commitError({ ...args, mirror: mirrorOf([]) }), null, "no steps at all: the mirror cannot say");
  assert.equal(commitError({ ...args, mirror: { docs: {}, at: NOW } }), null);
});

test("readyError: a READY for a card the sender started is refused until its end step exists; other messages and cards pass", () => {
  const args = { role: "Builder", now: NOW, maxAgeMs: MAX };
  const open = mirrorOf([step("start", NOW - 9e6)]);
  const e = readyError({ ...args, text: "READY #C701 build/menu-fix @ abc123: please review", mirror: open });
  assert.match(e, /READY for card menu-fix but Builder has no build end step after its start/);
  assert.ok(e.includes(endWrite("menu-fix", "Builder", NOW)));
  assert.match(readyError({ ...args, text: "READY, board id menu-fix", mirror: open }), /menu-fix/, "named by board id");
  assert.equal(readyError({ ...args, text: "READY #C701", mirror: mirrorOf([step("start", NOW - 9e6), step("end", NOW - 8e6)]) }), null, "the end exists");
  assert.equal(readyError({ ...args, text: "Ready to go? #C701", mirror: open }), null, "not a READY message");
  assert.equal(readyError({ ...args, text: "status: READY #C701", mirror: open }), null, "READY must start the message");
  assert.equal(readyError({ ...args, text: "READY #C701", mirror: mirrorOf([step("start", NOW - 9e6, { who: "Other" })]) }), null, "a card the sender never started is not its to end");
  assert.equal(readyError({ ...args, text: "READY #C701", mirror: mirrorOf([step("start", NOW - 9e6, { wait: "busy" })]) }), null, "a busy start is no start");
  assert.equal(readyError({ ...args, text: "READY #C555", mirror: open }), null, "an unknown card");
  assert.equal(readyError({ ...args, text: "READY", mirror: open }), null, "no card named");
  assert.equal(readyError({ ...args, text: "READY #C701", mirror: mirrorOf([step("start", NOW - 9e6)], NOW - MAX - 1) }), null, "a stale mirror");
  assert.equal(readyError({ ...args, text: "READY #C701", role: null, mirror: open }), null);
  assert.equal(isReady("  READY #C1"), true);
  assert.equal(isReady("ready #C1"), false, "the hand-off's word is READY");
  assert.deepEqual(namedCards("board id a-b and #C12"), [{ id: "a-b" }, { num: 12 }]);
});

// ---- the hook as the gate runs it, with a real state folder ----
function world({ steps = [], cards = [card], journal = [], age = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fb-commit-"));
  const stateDir = join(dir, "state");
  const board = join(stateDir, "TestBoard01");
  // A mirror is as old as its newest file: age sets every file's time back.
  const put = (c, id, doc) => { mkdirSync(join(board, "mirror", c), { recursive: true }); const p = join(board, "mirror", c, `${id}.json`); writeFileSync(p, JSON.stringify(doc)); const t = (Date.now() - age) / 1000; utimesSync(p, t, t); };
  for (const c of cards) put("initiatives", c.id, c);
  for (const s of steps) put("steps", s.id, s);
  writeFileSync(join(board, "gate.json"), JSON.stringify({ journal }));
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ customTitle: "Builder" })}\n`);
  const config = fullConfig({ artifactUrl: URL_, gate: { stateDir } });
  return { dir, config, transcript, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const bash = (command, transcript) => ({ tool_name: "Bash", tool_input: { command }, transcript_path: transcript });

test("the commit hook (run): refuses a tagged commit without a start, passes with one, counts a start the gate journaled", async () => {
  const now = Date.now();
  const w = world({ steps: [step("start", now - 9e6, { who: "Other" })] });
  try {
    const refused = await commitRun(bash('git commit -m "#C701: The menu opens"', w.transcript), { config: w.config, env: {}, now });
    assert.match(refused.block, /Flight board refused this commit/);
    assert.deepEqual(await commitRun(bash('git commit -m "No tag here"', w.transcript), { config: w.config, env: {}, now }), {}, "an untagged commit");
    assert.deepEqual(await commitRun(bash("git status", w.transcript), { config: w.config, env: {}, now }), {});
  } finally { w.done(); }
  const j = world({ steps: [step("start", now - 9e6, { who: "Other" })], journal: [{ op: "set", collection: "steps", doc_id: "menu-fix-build-start-1", data: step("start", now - 60e3), at: now - 60e3 }] });
  try {
    assert.deepEqual(await commitRun(bash('git commit -m "#C701: x"', j.transcript), { config: j.config, env: {}, now }), {}, "the start the gate let through a minute ago counts before the next export");
  } finally { j.done(); }
  const s = world({ steps: [step("start", now - 9e6, { who: "Other" })], age: 3 * 3600e3 });
  try {
    assert.deepEqual(await commitRun(bash('git commit -m "#C701: x"', s.transcript), { config: s.config, env: {}, now }), {}, "a stale mirror: open");
  } finally { s.done(); }
  const r = world({ steps: [step("start", now - 9e6, { who: "Other" })] });
  try {
    assert.deepEqual(await commitRun({ ...bash('git commit -m "#C701: x"', r.transcript) }, { config: r.config, env: { FLIGHT_BOARD_ROLE: "Someone" }, now }), {}, "the title and the environment disagree: no role, open");
    assert.deepEqual(await commitRun(bash('git commit -m "#C701: x"', join(r.dir, "missing.jsonl")), { config: r.config, env: {}, now }), {}, "no transcript, no role: open");
  } finally { r.done(); }
});

test("a command that is not a tagged commit never touches the config, the state or the transcript", async () => {
  // A config that would throw on any read, and no files: if the pass path read anything it would throw.
  const trap = new Proxy({}, { get() { throw new Error("read the config"); } });
  for (const c of ["ls", "git status", 'git commit -m "plain"', "node -e 1", "", undefined]) assert.deepEqual(await commitRun({ tool_name: "Bash", tool_input: { command: c }, transcript_path: "/nonexistent" }, { config: trap }), {}, String(c));
  assert.deepEqual(await commitRun({ tool_name: "Read", tool_input: { file_path: "/x" } }, { config: trap }), {});
  assert.deepEqual(await commitRun(null, { config: trap }), {});
});

test("the hook as a process fails open on every error of its own, and refuses only the clear case (exit 2)", () => {
  const w = world({ steps: [step("start", Date.now() - 9e6, { who: "Other" })] });
  try {
    const cfg = join(w.dir, "board.config.json");
    writeFileSync(cfg, JSON.stringify({ artifactUrl: URL_, gate: { stateDir: join(w.dir, "state") } }));
    const script = new URL("../gate/commit.mjs", import.meta.url).pathname;
    const go = (input, args = ["--config", cfg], env = {}) => spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8", env: { ...process.env, ...env }, timeout: 20000 });
    const tagged = JSON.stringify(bash('git commit -m "#C701: The menu opens"', w.transcript));
    const refused = go(tagged);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /no plain build start step/);
    // Every failure of its own is exit 0.
    assert.equal(go("not json").status, 0, "bad JSON on stdin");
    assert.equal(go("").status, 0, "empty stdin");
    assert.equal(go("[1,2]").status, 0, "JSON that is not a call");
    assert.equal(go(tagged, ["--config", join(w.dir, "missing.json")]).status, 0, "a config that is not there");
    writeFileSync(join(w.dir, "bad.json"), "{nope");
    assert.equal(go(tagged, ["--config", join(w.dir, "bad.json")]).status, 0, "a config that does not parse");
    assert.equal(go(tagged, []).status, 0, "no --config");
    writeFileSync(join(w.dir, "odd.json"), JSON.stringify({ artifactUrl: URL_, gate: { colour: 1 } }));
    assert.equal(go(tagged, ["--config", join(w.dir, "odd.json")]).status, 0, "a config the checker refuses");
    rmSync(join(w.dir, "state", "TestBoard01", "mirror"), { recursive: true, force: true });
    assert.equal(go(tagged).status, 0, "a missing mirror");
    // A mirror file that is garbage, a gate.json that is garbage: still open.
    mkdirSync(join(w.dir, "state", "TestBoard01", "mirror", "initiatives"), { recursive: true });
    writeFileSync(join(w.dir, "state", "TestBoard01", "mirror", "initiatives", "menu-fix.json"), "{half");
    writeFileSync(join(w.dir, "state", "TestBoard01", "gate.json"), "{half");
    assert.equal(go(tagged).status, 0, "half-written files");
    // A throw inside run (the lazy import fails): simulate with a transcript path that is a directory.
    assert.equal(go(JSON.stringify(bash('git commit -m "#C701: x"', w.dir))).status, 0, "a transcript that cannot be read");
    // Not a commit: exit 0 at once, whatever the config.
    assert.equal(go(JSON.stringify(bash("ls", w.transcript)), ["--config", join(w.dir, "missing.json")]).status, 0);
    // A hang: stdin never closes. The hook's own timeout ends it with exit 0.
    const hang = spawnSync(process.execPath, [script, "--config", cfg], { encoding: "utf8", env: { ...process.env, FLIGHT_BOARD_COMMIT_TIMEOUT_MS: "300" }, stdio: ["pipe", "pipe", "pipe"], timeout: 8000, input: undefined });
    assert.equal(hang.status, 0, `${hang.status} ${hang.signal} ${hang.stderr}`);
  } finally { w.done(); }
});

test("a READY message through the gate (gate.run): refused without the end step, named write; passes with it, and for other senders or messages", () => {
  const now = Date.now();
  const w = world({ steps: [step("start", now - 9e6)] });
  try {
    const send = (message, transcript = w.transcript) => gateRun({ tool_name: "SendMessage", tool_input: { to: "Checker", message }, transcript_path: transcript }, { config: w.config, env: {}, now });
    const blocked = send("READY #C701 build/menu-fix @ abc123");
    assert.match(blocked.block, /^Not sent\. This is READY for card menu-fix/);
    assert.match(blocked.block, /db_write set steps\/menu-fix-build-end-/);
    assert.deepEqual(send("Status: all fine, board id menu-fix"), {}, "not a READY");
    const other = join(w.dir, "other.jsonl");
    writeFileSync(other, `${JSON.stringify({ customTitle: "Reviewer" })}\n`);
    assert.deepEqual(send("READY #C701", other), {}, "a sender that never started the card");
  } finally { w.done(); }
  const e = world({ steps: [step("start", now - 9e6), step("end", now - 8e6)] });
  try {
    assert.deepEqual(gateRun({ tool_name: "SendMessage", tool_input: { to: "Checker", message: "READY #C701" }, transcript_path: e.transcript }, { config: e.config, env: {}, now }), {}, "the end exists");
  } finally { e.done(); }
  const j = world({ steps: [step("start", now - 9e6)], journal: [{ op: "set", collection: "steps", doc_id: "menu-fix-build-end-1", data: step("end", now - 60e3), at: now - 60e3 }] });
  try {
    assert.deepEqual(gateRun({ tool_name: "SendMessage", tool_input: { to: "Checker", message: "READY #C701" }, transcript_path: j.transcript }, { config: j.config, env: {}, now }), {}, "an end the gate let through a minute ago counts");
  } finally { j.done(); }
  const s = world({ steps: [step("start", now - 9e6)], age: 3 * 3600e3 });
  try {
    assert.deepEqual(gateRun({ tool_name: "SendMessage", tool_input: { to: "Checker", message: "READY #C701" }, transcript_path: s.transcript }, { config: s.config, env: {}, now }), {}, "a stale mirror: open");
  } finally { s.done(); }
});

test("the hook files are in the pinned set and the registered entries; nothing in the pass path imports at load but the pure module", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../gate/commit.mjs", import.meta.url), "utf8");
  const staticImports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(staticImports.sort(), ["./build-steps.mjs", "node:url"], "the pass path loads the pure module only");
  assert.equal(existsSync(new URL("../gate/build-steps.mjs", import.meta.url)), true);
  assert.doesNotMatch(readFileSync(new URL("../gate/build-steps.mjs", import.meta.url), "utf8"), /^import\b/m, "the step logic imports nothing");
});
