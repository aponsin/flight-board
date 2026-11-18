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
  const r = await wakeAsk(broken, NOW + 20_000);
  assert.equal(r.count, 1);
  assert.equal(r.send, true);
  assert.match(r.line, /^1 for Manager, batch b-\d+$/);
});

test("with the Worker's waitUntil the sync runs after the answer: a slow sync does not hold the ask", async () => {
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
