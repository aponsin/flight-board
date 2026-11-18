// #C1213 (inbox-delivers-new-threads): the owner's new question threads (t-<ms> ids the page mints, kind "question") reach Manager's read_inbox, and a message
// that arrives after a take opens a new wake batch of its own.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { wakeAsk, takeInbox } from "../worker/board-store.mjs";

const NOW = 1_800_000_000_000;
const WHO = { owner: { who: "owner", role: "owner" } };
const make = () => {
  const env = { DB: makeDb() };
  const write = async (w, now = NOW) => { const r = await worker.fetch(new Request("https://board.test/api/compat/write", { method: "POST", headers: { "content-type": "application/json", "x-as": "owner" }, body: JSON.stringify(w) }), env, null, now, async () => WHO.owner); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { env, write };
};
const newThread = (id, thread, text, at, extra = {}) => ({ op: "set", path: `messages/${id}`, data: { thread, from: "owner", text, at, kind: "question", ...extra } });
const reply = (id, thread, text, at) => ({ op: "set", path: `messages/${id}`, data: { thread, from: "owner", text, at } });

test("an owner's new question thread and a later message in an older thread both come back from the inbox once", async () => {
  const { env, write } = make();
  assert.equal((await write(reply("m1-aaaaaa", "t2036", "an older thread's word", 1), NOW)).status, 200);
  assert.equal((await write(newThread("m2-bbbbbb", "t-1795017662309", "what about PR#324 ?", 2), NOW + 1000)).status, 200);
  const first = await takeInbox(env.DB, NOW + 5000);
  assert.deepEqual(first.messages.map((m) => [m.thread_id, m.body]), [["t2036", "an older thread's word"], ["t-1795017662309", "what about PR#324 ?"]]);
  assert.deepEqual((await takeInbox(env.DB, NOW + 6000)).messages, [], "once");
});

test("a new thread written after a take opens a new batch, and the next take returns it", async () => {
  const { env, write } = make();
  assert.equal((await write(reply("m1-aaaaaa", "t2036", "one", 1), NOW)).status, 200);
  const a = await wakeAsk(env.DB, NOW + 20_000);
  assert.equal(a.count, 1);
  await takeInbox(env.DB, NOW + 25_000);
  assert.equal((await write(newThread("m2-bbbbbb", "t-1795017662309", "what about PR#324 ?", 2), NOW + 29_000)).status, 200);
  const b = await wakeAsk(env.DB, NOW + 40_000);
  assert.equal(b.count, 1);
  assert.notEqual(b.batchId, a.batchId, "a new batch");
  assert.equal(b.send, true);
  assert.deepEqual((await takeInbox(env.DB, NOW + 45_000)).messages.map((m) => m.thread_id), ["t-1795017662309"]);
});

// A db whose statements on the cards table fail, as a stall sync that throws or hangs would (the first thing syncStalls reads).
const failingOn = (db, test, how) => ({ prepare: (sql) => (test(sql) ? { bind: () => ({ run: how, all: how, first: how }), run: how, all: how, first: how } : db.prepare(sql)), batch: (x) => db.batch(x) });

test("a stall sync that throws does not hold back the owner's word: the batch opens and the ask answers", async () => {
  const { env, write } = make();
  assert.equal((await write(newThread("m2-bbbbbb", "t-1795017662309", "what about PR#324 ?", 2), NOW)).status, 200);
  const broken = failingOn(env.DB, (sql) => sql.startsWith("SELECT id, num, owner_role"), async () => { throw new Error("sync broke"); });
  const realLog = console.log; console.log = () => {};
  let r; try { r = await wakeAsk(broken, NOW + 20_000); } finally { console.log = realLog; }
  assert.equal(r.count, 1);
  assert.equal(r.send, true);
  assert.match(r.line, /^1 for Manager, batch b-\d+$/);
});

// #C1214 (Checker 2's L1 on #C1213): { timeout } so a wakeAsk that stops handing the sync to waitUntil fails this test; the gate below never opens then.
test("with the Worker's waitUntil the sync runs after the answer: a slow sync does not hold the ask", { timeout: 5000 }, async () => {
  const { env, write } = make();
  assert.equal((await write(newThread("m2-bbbbbb", "t-1795017662309", "what about PR#324 ?", 2), NOW)).status, 200);
  let release; const gate = new Promise((res) => { release = res; });
  const slow = failingOn(env.DB, (sql) => sql.startsWith("SELECT id, num, owner_role"), async () => { await gate; return { results: [] }; });
  let deferred = null;
  const r = await wakeAsk(slow, NOW + 20_000, (p) => { deferred = p; });
  assert.equal(r.send, true, "answered while the sync is still waiting");
  assert.equal(r.count, 1);
  assert.ok(deferred instanceof Promise);
  release();
  await deferred;
});

test("a sync that fails leaves one line in the Worker's log with the reason, and a quiet sync leaves none", async () => {
  const { env } = make();
  const lines = [], realLog = console.log;
  console.log = (...a) => { lines.push(a.join(" ")); };
  try {
    await wakeAsk(env.DB, NOW + 20_000);
    assert.deepEqual(lines, [], "a quiet sync logs nothing");
    const broken = failingOn(env.DB, (sql) => sql.startsWith("SELECT id, num, owner_role"), async () => { throw new Error("cards table unreadable"); });
    await wakeAsk(broken, NOW + 40_000);
  } finally { console.log = realLog; }
  assert.equal(lines.length, 1);
  const o = JSON.parse(lines[0]).wakeSync;
  assert.equal(o.stalls, "cards table unreadable");
  assert.equal(o.sweep, "ok");
  assert.ok(Number.isInteger(o.ms) && Number.isInteger(o.stallsMs));
});

// #C1214 (Checker 2's L2): a stall row that is over is retired by the sync, so it must not open a batch before the sync runs (Manager would be woken to an empty inbox).
test("a stall line that is already over opens no batch: the first count is the owner's words only", async () => {
  const { env } = make();
  await env.DB.prepare("INSERT INTO stall_wakes (card_id, reason, created_at) VALUES (?, ?, ?)").bind("gone-card", "a card waits that no longer does", NOW).run();
  const r = await wakeAsk(env.DB, NOW + 20_000);
  assert.equal(r.count, 0);
  assert.equal(r.send, false);
  assert.equal((await env.DB.prepare("SELECT batch_id FROM wake WHERE id = 1").first()).batch_id, null, "no batch was opened for it");
});

// #C1214 (Checker 2's F1): the same, on the Worker's route, where waitUntil is set.
const wakeRoute = (env, waited, at) => worker.fetch(new Request("https://board.test/api/probe/wake", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), env, { waitUntil: (p) => waited.push(p) }, at, async () => ({ who: "probe", role: "probe" })).then((r) => r.json());
const overStall = (env) => env.DB.prepare("INSERT INTO stall_wakes (card_id, reason, created_at) VALUES (?, ?, ?)").bind("gone-card", "a card waits that no longer does", NOW).run();

test("on the Worker's route a stall line that is already over opens no batch either (waitUntil set, no owner word)", async () => {
  const { env } = make();
  await overStall(env);
  const waited = [];
  const body = await wakeRoute(env, waited, NOW + 20_000);
  assert.equal(body.count, 0);
  assert.equal(body.send, false);
  assert.equal((await env.DB.prepare("SELECT batch_id FROM wake WHERE id = 1").first()).batch_id, null, "no batch was opened for it");
  assert.equal(waited.length, 0, "nothing urgent: the sync ran before the count");
});

test("on the Worker's route an owner word still opens the batch at once and the sync waits for waitUntil", async () => {
  const { env, write } = make();
  await overStall(env);
  assert.equal((await write(newThread("m2-bbbbbb", "t-1795017662309", "what about PR#324 ?", 2), NOW)).status, 200);
  const waited = [];
  const body = await wakeRoute(env, waited, NOW + 20_000);
  assert.equal(body.send, true);
  assert.ok(body.count >= 1);
  assert.equal(waited.length, 1, "the sync was handed to waitUntil");
  await Promise.all(waited);
});

test("a stall line that is still current opens a batch once the sync has run, as before", async () => {
  const { env } = make();
  await env.DB.prepare("INSERT INTO stall_wakes (card_id, reason, created_at) VALUES (?, ?, ?)").bind("ping:t1", "The owner pinged thread t1", NOW).run();
  const r = await wakeAsk(env.DB, NOW + 20_000);
  assert.equal(r.count, 1);
  assert.equal(r.send, true);
});

test("the probe's wake route hands the sync to the Worker's waitUntil, and still answers with the owner's word", async () => {
  const { env, write } = make();
  assert.equal((await write(newThread("m2-bbbbbb", "t-1795017662309", "what about PR#324 ?", 2), NOW)).status, 200);
  const waited = [];
  const res = await worker.fetch(new Request("https://board.test/api/probe/wake", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), env, { waitUntil: (p) => waited.push(p) }, NOW + 20_000, async () => ({ who: "probe", role: "probe" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.send, true, JSON.stringify(body));
  assert.equal(body.count, 1);
  assert.equal(waited.length, 1, "the sync was handed to waitUntil");
  await Promise.all(waited);
});
