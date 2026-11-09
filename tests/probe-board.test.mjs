import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { postMessage, readView } from "../worker/board-store.mjs";
import { askJob, liveJob, loadEnv, accessHeaders, sendArgs, SEND_TIMEOUT_MS } from "../collector/probe-board.mjs";
import { JOBS } from "../collector/probe-run.mjs";

const SECRET = "s3cr3t-token-value";
const H = { "cf-access-client-id": "id-1", "cf-access-client-secret": SECRET, "content-type": "application/json" };
const BASE = "https://board.test";
// The probe's fetch goes straight into the real Worker code with the probe's identity.
const wired = (env, now = () => Date.now(), productFetch = null) => (url, init = {}) => {
  if (productFetch && url.startsWith("https://product.test")) return productFetch(url, init);
  return worker.fetch(new Request(url, init), env, null, now(), async () => ({ who: "probe", role: "probe" }));
};

test("the env file is parsed without quoting the values into logs", () => {
  const f = join(mkdtempSync(join(tmpdir(), "pe-")), "board.env");
  writeFileSync(f, `BOARD_SERVICE_TOKEN_ID=abc\nBOARD_SERVICE_TOKEN_SECRET="${SECRET}"\n# c\n`);
  const e = loadEnv(f);
  assert.equal(e.BOARD_SERVICE_TOKEN_SECRET, SECRET);
  assert.equal(accessHeaders(e)["cf-access-client-secret"], SECRET);
});

test("the send is a plain headless claude send by name with only the send tools, and its timeout sits inside the job's limit", () => {
  const a = sendArgs("1 for Manager, batch b-1");
  assert.ok(a.join(" ").includes("session named 'Manager'"));
  assert.deepEqual(a.slice(a.indexOf("--allowedTools")), ["--allowedTools", "SendMessage,ListAgents"]);
  assert.ok(SEND_TIMEOUT_MS < JOBS.ask.limitSec * 1000);
});

test("a quiet ask sends nothing; an owner message makes one send and its good result is stored", async () => {
  const env = { DB: makeDb() };
  const logs = [], sends = [];
  const send = async (line) => { sends.push(line); return { exit: 0, text: '{"success":true}' }; };
  const f = wired(env);
  assert.equal((await askJob({ base: BASE, headers: H, fetchImpl: f, send, log: (l) => logs.push(l) })).sent, false);
  await postMessage(env.DB, Date.now(), "owner", { thread_id: "t", body: "PRIVATE BOARD TEXT" });
  const r = await askJob({ base: BASE, headers: H, fetchImpl: f, send, log: (l) => logs.push(l) });
  assert.deepEqual([r.sent, r.exit], [true, 0]);
  assert.equal(sends.length, 1);
  assert.match(sends[0], /^1 for Manager, batch b-\d+$/);
  assert.ok(!logs.join("\n").includes(SECRET) && !sends[0].includes("PRIVATE"));
  assert.equal((await readView(env.DB, Date.now())).wake.last_send_ok, 1);
  assert.equal((await askJob({ base: BASE, headers: H, fetchImpl: f, send, log: () => {} })).sent, false, "no second send for the same batch");
});

test("a send that failed on login is reported to the store with its exit code and shows row 4 red", async () => {
  const env = { DB: makeDb() };
  await postMessage(env.DB, Date.now(), "owner", { thread_id: "t", body: "x" });
  const send = async () => ({ exit: 1, text: "Failed to authenticate: OAuth session expired and could not be refreshed" });
  const logs = [];
  const f = wired(env);
  const r = await askJob({ base: BASE, headers: H, fetchImpl: f, send, log: (l) => logs.push(l) });
  assert.equal(r.exit, 1);
  const next = await askJob({ base: BASE, headers: H, fetchImpl: f, send, log: (l) => logs.push(l) });
  assert.equal(next.status.reason, "login-lapsed");
  assert.equal(next.tellOwner, true);
  assert.ok(logs.some((l) => /TELL OWNER once: login-lapsed/.test(l)));
  assert.equal((await readView(env.DB, Date.now())).wakeState.reason, "login-lapsed");
});

test("a store that answers an error fails the run (exit non-zero), it does not pass silently", async () => {
  await assert.rejects(askJob({ base: BASE, headers: H, fetchImpl: async () => new Response(null, { status: 500 }) }), /wake ask answered 500/);
});

const product = (status, body) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
test("Live now: a good /version.json is stored as the probe's evidence", async () => {
  const env = { DB: makeDb() };
  const r = await liveJob({ base: BASE, headers: H, productUrl: "https://product.test", fetchImpl: wired(env, undefined, product(200, { version: "v1.200.7", commit: "34ebdde", builtAt: "2026-11-09T04:00:00Z" })) });
  assert.deepEqual([r.written, r.version], [true, "v1.200.7"]);
  const v = await readView(env.DB, Date.now());
  assert.equal(v.live.state, "live");
  assert.equal(v.live.version, "v1.200.7");
});

test("Live now: a 404 is unknown, and a malformed or hostile reading is never written", async () => {
  const env = { DB: makeDb() };
  const run = (p) => liveJob({ base: BASE, headers: H, productUrl: "https://product.test", fetchImpl: wired(env, undefined, p) });
  assert.deepEqual(await run(product(404, "")), { written: false, unknown: true });
  assert.equal((await run(product(200, { version: "<script>x</script>", commit: "34ebdde", builtAt: "2026-11-09T04:00:00Z" }))).malformed, true);
  assert.equal((await run(product(200, { version: "v1", commit: "nothex", builtAt: "2026-11-09T04:00:00Z" }))).malformed, true);
  assert.equal((await run(product(200, { version: "v1", commit: "34ebdde", builtAt: "yesterday" }))).malformed, true);
  assert.equal((await readView(env.DB, Date.now())).live.state, "unknown", "nothing was written");
  await assert.rejects(run(product(503, "")), /version\.json answered 503/);
});
