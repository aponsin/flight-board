// #C731: the evidence job runs under launchd with PATH=/usr/bin:/bin:/usr/sbin:/sbin, where gh (Homebrew) is not found, so every gh call of
// the state build failed (the deploy run and the CI runs unread, the gh back-off at its 30-minute maximum) and the main repository's cards
// read shipped, not live (#C722 and #C724 showed "LIVE IN 9 min"). The state child gets gh's install folders on its PATH.
import test from "node:test";
import assert from "node:assert/strict";
import { childEnv, defaultBuild, defaultGhCheck, GH_DIRS, GH_MISSING, evidenceJob } from "../collector/probe-evidence.mjs";

test("the state child's environment has gh's folders on PATH, once, in front, and keeps everything else", () => {
  const e = childEnv({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/h", X: "1" });
  assert.equal(e.PATH, `${GH_DIRS.join(":")}:/usr/bin:/bin:/usr/sbin:/sbin`); assert.equal(e.HOME, "/h"); assert.equal(e.X, "1");
  assert.equal(childEnv({ PATH: "/opt/homebrew/bin:/usr/bin" }).PATH, "/usr/local/bin:/opt/homebrew/bin:/usr/bin", "a folder already there is not added twice");
  assert.equal(childEnv({}).PATH, GH_DIRS.join(":"), "no PATH at all");
  assert.equal(childEnv({ PATH: "/a::/b" }).PATH, `${GH_DIRS.join(":")}:/a:/b`, "empty entries are dropped");
});

test("the default build runs the state child with that environment and its time limit", () => {
  let seen;
  defaultBuild(["state.mjs"], 5000, (cmd, args, opts) => { seen = { cmd, args, opts }; return Promise.resolve(""); }, { PATH: "/usr/bin" });
  assert.equal(seen.cmd, process.execPath); assert.deepEqual(seen.args, ["state.mjs"]); assert.equal(seen.opts.timeoutMs, 5000); assert.equal(seen.opts.env.PATH, "/usr/bin");
});

test("a build can still be passed to the evidence job (the tests' seam)", async () => {
  const calls = [];
  const state = JSON.stringify({ v: 1, board: { boardId: "b", at: 1 }, cards: {}, agents: {} });
  await evidenceJob({ job: "usage", base: "https://x.example", headers: {}, configPath: "c", stateFile: "s", build: (args, ms) => { calls.push([args, ms]); }, read: () => state, fetchImpl: async () => ({ ok: true }), log: () => {} });
  assert.equal(calls.length, 1); assert.ok(calls[0][0].includes("--no-post"));
});

// Checker on 1423794: the wiring that is the fix. The job's own build (no build passed) must hand the state child the environment with gh's
// folders, from a launchd-like PATH, and the gh check must ask about that same environment.
test("the job's default build runs the state child with gh's folders on a launchd-like PATH, and the check sees the same environment", async () => {
  const state = JSON.stringify({ v: 1, board: { boardId: "b", at: 1 }, cards: {}, agents: {} });
  const was = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  try {
    let child, checked;
    await evidenceJob({ job: "evidence", base: "https://x.example", headers: {}, configPath: "c", stateFile: "s", runner: (cmd, args, opts) => { child = { cmd, args, opts }; return Promise.resolve(""); }, ghCheck: (e) => { checked = e; return true; }, read: () => state, fetchImpl: async () => ({ ok: true }), liveFetch: async () => ({ ok: false, status: 500 }), log: () => {} });
    assert.equal(child.cmd, process.execPath); assert.ok(child.args.includes("--no-post"));
    assert.equal(child.opts.env.PATH, `${GH_DIRS.join(":")}:/usr/bin:/bin:/usr/sbin:/sbin`, "the child gets gh's folders");
    assert.ok(child.opts.timeoutMs > 0);
    assert.equal(checked, child.opts.env, "the check is asked about the very environment the child gets");
  } finally { process.env.PATH = was; }
});

// Prevention: a run that cannot find gh fails loudly instead of backing off quietly for 30 minutes.
test("gh missing: the evidence job still posts what git shows, logs a plain line, and then ends as a failed run", async () => {
  const log = [], posted = [];
  const state = JSON.stringify({ v: 1, board: { boardId: "b", at: 1 }, cards: { "card-a": { phase: "build" } }, agents: {} });
  const env = { job: "evidence", base: "https://x.example", headers: {}, configPath: "c", stateFile: "s", build: () => {}, read: () => state, liveFetch: async () => ({ ok: false, status: 500 }), fetchImpl: async (url, o) => { posted.push(JSON.parse(o.body).key); return { ok: true }; }, log: (l) => log.push(l) };
  await assert.rejects(evidenceJob({ ...env, ghCheck: () => false }), (e) => e.message === GH_MISSING);
  assert.ok(log.includes(GH_MISSING), "the plain line is in the log"); assert.ok(posted.includes("cards.card-a"), "the evidence still went out");
  const ok = await evidenceJob({ ...env, ghCheck: () => true });
  assert.ok(ok.written >= 1);
  // the usage job reads no gh, so it never fails on it
  const u = await evidenceJob({ ...env, job: "usage", ghCheck: () => { throw new Error("must not be asked"); } });
  assert.equal(u.written, 0);
});

test("the gh check runs gh --version in the child's environment, and false for any failure", () => {
  let seen;
  assert.equal(defaultGhCheck({ PATH: "/x" }, (cmd, args, opts) => { seen = { cmd, args, opts }; }), true);
  assert.equal(seen.cmd, "gh"); assert.deepEqual(seen.args, ["--version"]); assert.equal(seen.opts.env.PATH, "/x"); assert.ok(seen.opts.timeout > 0);
  assert.equal(defaultGhCheck({ PATH: "/x" }, () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); }), false);
  assert.equal(defaultGhCheck({ PATH: "/nonexistent" }), false, "really not found with an empty PATH");
});
