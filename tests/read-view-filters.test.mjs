import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker, { TOOLS } from "../worker/board-worker.mjs";
import { viewForTool } from "../worker/view-filter.mjs";

// #C1089 read-view-per-owner: the whole view is about 5.4 MB, so read_view takes owner_role and thread_id, and with no filter it is a short summary.
const NOW = 1_800_000_000_000;
const WHO = { manager: { who: "Manager", role: "agent" }, ops: { who: "Ops", role: "agent" }, builder: { who: "Builder", role: "agent" } };
const make = () => {
  const env = { DB: makeDb() };
  const call = (as, path, init = {}) => worker.fetch(new Request(`https://board.test${path}`, { ...init, headers: { "content-type": "application/json", "x-as": as } }), env, null, NOW, async (req) => WHO[req.headers.get("x-as")] ?? null);
  const tool = async (as, name, args) => (await (await call(as, "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result;
  return { tool, env };
};
// Two owner threads with two messages each, as the page writes them.
const threads = async (db) => {
  for (const [id, num] of [["t-100", 900], ["t-200", 901]]) {
    await db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES (?, ?, ?, ?)").bind(id, num, `thread ${num}`, NOW - 1000).run();
    for (const k of [1, 2]) await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)").bind(`m-${id}-${k}`, id, "owner", `words ${k}`, NOW - 900 + k).run();
  }
};
const size = (r) => JSON.stringify(r.structuredContent).length;

async function seed(tool) {
  const pad = "x".repeat(2000);
  for (let i = 0; i < 60; i++) assert.equal((await tool("manager", "card_create", { id: `b-${i}`, title: `Build ${i}`, summary: pad, owner_role: "Builder", batch: "g-test" })).isError, false);
  for (const id of ["o-one", "o-two", "o-three"]) assert.equal((await tool("manager", "card_create", { id, title: id, summary: "an Ops card", owner_role: "Ops", batch: "g-test" })).isError, false);
  const a = await tool("manager", "ask", { type: "Thread", title: "Hello", text: "first words" });
  assert.equal(a.isError, false);
  return a.structuredContent;
}

test("the read_view schema takes owner_role, thread_id, message_id (#C1125) and summary, and nothing else", () => {
  const t = TOOLS.find((x) => x.name === "read_view");
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ["message_id", "owner_role", "summary", "thread_id"]);
  assert.equal(t.inputSchema.additionalProperties, false);
});

test("owner_role=Ops returns only Ops's open cards and stays under 50 KB on a board with 60 big Builder cards", async () => {
  const { tool } = make();
  await seed(tool);
  const whole = await tool("manager", "read_view", {});
  assert.ok(size(whole) > 100_000, "the whole view is big in this board");
  const r = await tool("ops", "read_view", { owner_role: "Ops" });
  assert.equal(r.isError, false);
  assert.deepEqual(r.structuredContent.cards.map((c) => c.id).sort(), ["o-one", "o-two", "o-three"].sort());
  assert.ok(size(r) < 50_000, `${size(r)} bytes`);
  assert.equal(typeof r.structuredContent.evidence, "object", "the answer carries an evidence object, as the digest reads it");
});

test("summary: true returns the summary, not the whole view", async () => {
  const { tool } = make();
  await seed(tool);
  const r = await tool("ops", "read_view", { summary: true });
  const v = r.structuredContent;
  assert.equal(v.summary, true);
  assert.equal(v.openCardsByRole.Builder, 60);
  assert.equal(v.openCardsByRole.Ops, 3);
  assert.equal(v.cards, undefined);
  assert.ok(size(r) < 5_000, `${size(r)} bytes`);
});

test("no argument still returns the whole view, as before (Checker 2's F1: the pickup digest and the approvals check read cards, asks and evidence from it)", async () => {
  const { tool, env } = make();
  await seed(tool);
  await threads(env.DB);
  const v = (await tool("ops", "read_view", {})).structuredContent;
  assert.equal(v.summary, undefined);
  assert.ok(v.evidence && v.refusals && v.groupOrder, "the whole view's other parts are there");
  assert.equal(v.cards.length, 63);
  assert.ok(Array.isArray(v.asks) && v.asks.length === 1);
  assert.equal(v.threads.messages.length, 4);
});

test("thread_id returns that thread and its messages only", async () => {
  const { tool, env } = make();
  await seed(tool);
  await threads(env.DB);
  const r = (await tool("ops", "read_view", { thread_id: "t-100" })).structuredContent;
  assert.equal(r.thread.id, "t-100");
  assert.equal(r.messages.length, 2);
  assert.ok(r.messages.every((m) => m.thread_id === "t-100"));
  assert.equal(r.cards, undefined);
  const none = (await tool("ops", "read_view", { thread_id: "t-nope" })).structuredContent;
  assert.equal(none.thread, null);
  assert.deepEqual(none.messages, []);
});

test("viewForTool: a done or dropped card and a closed ask are not open", () => {
  const view = { tag: "t", now: 1, cards: [{ id: "a", owner_role: "Ops", done_at: null, dropped: 0 }, { id: "b", owner_role: "Ops", done_at: 5, dropped: 0 }, { id: "c", owner_role: "Ops", done_at: null, dropped: 1 }], asks: [{ id: "k1", asked_by: "Ops", closed_at: null }, { id: "k2", asked_by: "Ops", closed_at: 9 }, { id: "k3", asked_by: "Manager", card_id: "a", closed_at: null }, { id: "k4", asked_by: "Manager", card_id: "b", closed_at: null }, { id: "k5", asked_by: "Ops", closed_at: null, withdrawn_at: 7 }], threads: { threads: [], messages: [] }, evidence: { "cards.a": { value: { phase: "build" } }, "cards.b": { value: { phase: "live" } }, "cards.z": { value: {} } } };
  const r = viewForTool(view, { owner_role: "Ops" });
  assert.deepEqual(r.cards.map((c) => c.id), ["a"]);
  assert.deepEqual(r.asks.map((k) => k.id), ["k1", "k3", "k5"], "k2 is closed, k4 sits on a done card; k5 is withdrawn, which is still open (its answer is cleared and it waits for the owner's Approve again), as the digest and the dispatch count it (#C1101)");
  assert.deepEqual(Object.keys(r.evidence), ["cards.a"], "the evidence of the cards returned and no other (Checker 2's F2)");
  assert.deepEqual(r.evidence["cards.a"], { value: { phase: "build" } });
});

test("viewForTool: no argument is the very same whole view; summary: true is not", () => {
  const view = { tag: "t", now: 1, cards: [], asks: [], evidence: {}, threads: { threads: [], messages: [] } };
  assert.equal(viewForTool(view, {}), view);
  assert.equal(viewForTool(view), view);
  assert.equal(viewForTool(view, { summary: false }), view);
  assert.equal(viewForTool(view, { summary: true }).summary, true);
});
