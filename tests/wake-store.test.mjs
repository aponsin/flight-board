import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { postMessage, answerAsk, createAsk, wakeAsk, wakeResult, takeInbox, readView } from "../worker/board-store.mjs";

const T = 1_800_000_000_000, MIN = 60_000;
const GOOD = '{"success":true,"message":"delivered"}';

test("while quiet the ask is only a heartbeat: nothing to send", async () => {
  const db = makeDb();
  const r = await wakeAsk(db, T);
  assert.deepEqual([r.send, r.line, r.count], [false, null, 0]);
  assert.equal((await db.prepare("SELECT alive_at FROM wake").first()).alive_at, T);
});

test("the owner's message opens one batch; the line carries a count and an id, never the text", async () => {
  const db = makeDb();
  await postMessage(db, T, "owner", { thread_id: "c-one", body: "SECRET BOARD TEXT do not leak" });
  await postMessage(db, T + 1000, "Manager", { thread_id: "c-one", body: "Manager's own note is not for Manager" });
  const r = await wakeAsk(db, T + 20_000);
  assert.equal(r.send, true);
  assert.match(r.line, /^1 for Manager, batch b-\d+$/);
  assert.doesNotMatch(r.line, /SECRET/);
  await postMessage(db, T + 25_000, "owner", { thread_id: "c-one", body: "another" });
  const again = await wakeAsk(db, T + 40_000);
  assert.equal(again.batchId, r.batchId, "still one batch");
  assert.equal(again.count, 2);
});

test("one send per batch, again after 5 minutes if untaken", async () => {
  const db = makeDb();
  await postMessage(db, T, "owner", { thread_id: "t", body: "x" });
  const a = await wakeAsk(db, T + 20_000);
  await wakeResult(db, T + 25_000, a.batchId, 0, GOOD);
  assert.equal((await wakeAsk(db, T + 60_000)).send, false);
  assert.equal((await wakeAsk(db, T + 25_000 + 5 * MIN + 1)).send, true);
});

test("a send that failed on login shows Manager unreachable with the fix, and the owner is told once", async () => {
  const db = makeDb();
  await postMessage(db, T, "owner", { thread_id: "t", body: "x" });
  const a = await wakeAsk(db, T + 20_000);
  await wakeResult(db, T + 30_000, a.batchId, 1, "Failed to authenticate: OAuth session expired and could not be refreshed");
  const b = await wakeAsk(db, T + 40_000);
  assert.deepEqual([b.status.state, b.status.reason], ["red", "login-lapsed"]);
  assert.match(b.status.fix, /claude \/login/);
  assert.equal(b.tellOwner, true);
  assert.equal((await wakeAsk(db, T + 60_000)).tellOwner, false, "told once");
  assert.equal((await readView(db, T + 60_000)).wakeState.reason, "login-lapsed");
});

test("a send to a session that is not reachable is told apart from a lapsed login", async () => {
  const db = makeDb();
  await postMessage(db, T, "owner", { thread_id: "t", body: "x" });
  const a = await wakeAsk(db, T + 20_000);
  await wakeResult(db, T + 30_000, a.batchId, 0, "No agent named 'Manager' is reachable.");
  assert.equal((await wakeAsk(db, T + 40_000)).status.reason, "no-agent-reachable");
});

test("a good send not taken within 3 minutes shows red 'batch not taken'", async () => {
  const db = makeDb();
  await postMessage(db, T, "owner", { thread_id: "t", body: "x" });
  const a = await wakeAsk(db, T + 20_000);
  await wakeResult(db, T + 25_000, a.batchId, 0, GOOD);
  assert.equal((await wakeAsk(db, T + 25_000 + 2 * MIN)).status.state, "ok");
  assert.equal((await wakeAsk(db, T + 25_000 + 3 * MIN + 1)).status.reason, "batch-not-taken");
});

test("Manager's typed read takes the batch: it closes, the tick moves, a good send clears the owner-told memory", async () => {
  const db = makeDb();
  const ask = await createAsk(db, T, { type: "Decision", title: "Pick", asked_by: "Manager", question: "A or B?", options: ["A", "B"], recommended: "A" });
  await answerAsk(db, T + 1000, "owner", { id: ask.id, answer: "B" });
  await postMessage(db, T + 2000, "owner", { thread_id: "t", body: "hello" });
  const a = await wakeAsk(db, T + 20_000);
  assert.equal(a.count, 2);
  await wakeResult(db, T + 21_000, a.batchId, 0, GOOD);
  const inbox = await takeInbox(db, T + 30_000);
  assert.deepEqual([inbox.messages.length, inbox.answers.length, inbox.answers[0].answer], [1, 1, "B"]);
  const quiet = await wakeAsk(db, T + 40_000);
  assert.deepEqual([quiet.send, quiet.count, quiet.status.state], [false, 0, "idle"]);
  assert.equal((await db.prepare("SELECT seen_at FROM wake").first()).seen_at, T + 30_000);
  assert.equal((await takeInbox(db, T + 50_000)).messages.length, 0, "taken once");
  await postMessage(db, T + 60_000, "owner", { thread_id: "t", body: "again" });
  const next = await wakeAsk(db, T + 70_000);
  assert.notEqual(next.batchId, a.batchId, "a new batch");
  assert.equal(next.send, true);
});

test("over HTTP only the probe asks and reports, and only Manager's role reads the inbox", async () => {
  const env = { DB: makeDb() };
  const as = (who, role) => async () => ({ who, role });
  const post = (auth, path, body = {}) => worker.fetch(new Request(`https://b.test${path}`, { method: "POST", body: JSON.stringify(body) }), env, null, T, auth);
  assert.equal((await post(as("Manager", "agent"), "/api/probe/wake")).status, 403);
  assert.equal((await post(as("owner", "owner"), "/api/probe/wake-result", { exit: 0 })).status, 403);
  assert.equal((await post(as("probe", "probe"), "/api/probe/wake")).status, 200);
  assert.equal((await post(as("probe", "probe"), "/api/probe/wake-result", { exit: "x" })).status, 422);
  assert.equal((await post(as("probe", "probe"), "/api/probe/wake-result", { exit: 0, batchId: "b-1", text: GOOD })).status, 200);
  const rpc = (auth) => worker.fetch(new Request("https://b.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_inbox", arguments: {} } }) }), env, null, T, auth).then((r) => r.json());
  assert.equal((await rpc(as("Manager", "agent"))).result.structuredContent.ok, true);
  assert.equal((await rpc(as("owner", "owner"))).error.code, -32602);
});
