import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realSend, sendEnv, main, blockedInTests } from "../collector/probe-board.mjs";
import { classifySend } from "../worker/wake-rules.mjs";

// SAFETY RULE for this file (#C721: a test's nudge line reached Manager's live session when a reviewer's mutation made the send
// use the inherited PATH): NO test here can reach a real claude. Every claude below is a fake script in a temp folder, or a path
// that cannot exist, and the lines sent are marked TEST so a stray one is recognisable. realSend itself refuses any claude
// outside the temp folder when it runs under `node --test` (blockedInTests), whatever a test or a mutation does.
const LINE = "TEST ONLY, not a nudge: 1 for Manager, batch b-test";
// launchd starts a job with this PATH and nothing else; #C721: the first live wake failed because `claude` is not on it.
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const fakeClaude = (body = 'echo "fake claude: $@"\necho "PATH=$PATH"\n') => {
  const dir = mkdtempSync(join(tmpdir(), "wsp-"));
  const f = join(dir, "claude");
  writeFileSync(f, `#!/bin/sh\n${body}`);
  chmodSync(f, 0o755);
  return { dir, f };
};

test("the wake send runs claude by its FULL path under launchd's bare PATH, and the child sees claude's own folder on PATH (#C721)", async () => {
  const { dir, f } = fakeClaude();
  const r = await realSend(LINE, { claudePath: f, env: { PATH: LAUNCHD_PATH, NODE_TEST_CONTEXT: "child-v8" } });
  assert.equal(r.exit, 0);
  assert.match(r.text, /fake claude: -p .*TEST ONLY/);
  assert.ok(r.text.includes(`PATH=${dir}:${LAUNCHD_PATH}`), "claude's folder first, then the PATH it had");
});

test("a claude that is not there exits 1 as live did, and the store is told why in words (#C721)", async () => {
  const gone = join(mkdtempSync(join(tmpdir(), "wsp-")), "nope", "claude"); // inside the temp folder, so the guard lets it run; it cannot exist
  const r = await realSend(LINE, { claudePath: gone, env: { PATH: LAUNCHD_PATH } });
  assert.equal(r.exit, 1);
  const c = classifySend(r.exit, r.text);
  assert.equal(c.ok, false);
  assert.equal(c.reason, "claude-not-found");
  assert.match(c.fix, /--claude/);
  // the other reasons are unchanged
  assert.equal(classifySend(1, "something else broke").reason, "send-failed");
  assert.equal(classifySend(0, "ok").ok, true);
});

test("under a test run realSend never starts a claude outside the temp folder, even with the real PATH or a dropped env (#C721, Checker)", async () => {
  const inTest = { NODE_TEST_CONTEXT: "child-v8" };
  assert.equal(blockedInTests("claude", inTest), true, "a bare claude would be looked up on the real PATH");
  assert.equal(blockedInTests("/Users/someone/.local/bin/claude", inTest), true);
  assert.equal(blockedInTests(join(tmpdir(), "x", "claude"), inTest), false, "a fake in the temp folder is fine");
  assert.equal(blockedInTests("claude", {}), false, "outside a test run (the launchd job) nothing is blocked");
  // and the function itself, in this very test run: a bare claude is refused with a clear exit, without being spawned
  const r = await realSend(LINE, { claudePath: "claude", env: process.env });
  assert.deepEqual([r.exit, /blocked/.test(r.text)], [125, true]);
});

test("sendEnv puts claude's folder first, keeps the PATH it was given and the standard folders, with no repeats", () => {
  assert.equal(sendEnv("/Users/x/.local/bin/claude", { PATH: LAUNCHD_PATH, HOME: "/Users/x" }).PATH, `/Users/x/.local/bin:${LAUNCHD_PATH}:/usr/local/bin`);
  assert.equal(sendEnv("/Users/x/.local/bin/claude", { PATH: "/Users/x/.local/bin:/usr/bin" }).PATH, "/Users/x/.local/bin:/usr/bin:/usr/local/bin:/bin");
  assert.equal(sendEnv("/a/claude", { HOME: "/h" }).HOME, "/h", "the rest of the environment passes through");
  assert.ok(sendEnv("/a/claude", {}).PATH.startsWith("/a:"));
});

test("the ask job refuses a --claude that is not a full path, so the launchd mistake cannot come back quietly (#C721)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wsp-"));
  const envFile = join(dir, "board.env");
  writeFileSync(envFile, "BOARD_SERVICE_TOKEN_ID=a\nBOARD_SERVICE_TOKEN_SECRET=b\n");
  const codes = [];
  await main(["--job", "ask", "--env", envFile, "--base", "https://board.test", "--claude", "claude"], { exit: (c) => { codes.push(c); return c; } });
  assert.deepEqual(codes, [64]);
});

test("the ask job's send runs the claude given by --claude (the wiring this fix is about), and reports exit 0 to the store (Security)", async () => {
  const { dir, f } = fakeClaude('echo "$@" > "$(dirname "$0")/ran.txt"\necho sent\n');
  const envFile = join(dir, "board.env");
  writeFileSync(envFile, "BOARD_SERVICE_TOKEN_ID=a\nBOARD_SERVICE_TOKEN_SECRET=b\n");
  const posted = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/api/probe/wake")) return new Response(JSON.stringify({ send: true, line: LINE, batchId: "b-test", status: { state: "ok" } }), { status: 200 });
    posted.push([url, JSON.parse(init.body)]);
    return new Response("{}", { status: 200 });
  };
  const codes = [];
  await main(["--job", "ask", "--env", envFile, "--base", "https://board.test", "--claude", f], { fetchImpl, exit: (c) => { codes.push(c); return c; } });
  assert.deepEqual(codes, [0]);
  assert.ok(existsSync(join(dir, "ran.txt")), "the claude named by --claude was the one that ran");
  assert.match(readFileSync(join(dir, "ran.txt"), "utf8"), /TEST ONLY/);
  assert.equal(posted.length, 1);
  assert.match(posted[0][0], /\/api\/probe\/wake-result$/);
  assert.deepEqual([posted[0][1].batchId, posted[0][1].exit], ["b-test", 0]);
});
