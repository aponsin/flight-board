// #C1125 (11-16: Manager forwarded the owner's answer with its message id and thread; the builder could not find it with the tools it had and asked the owner again in its own chat, against the
// rule that no ask sends the owner into an agent chat): read_view takes message_id and returns that ONE message when the owner wrote it, so a forward can be checked against the source.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { viewForTool } from "../worker/view-filter.mjs";

const NOW = 1_800_000_000_000;
const WHO = { manager: { who: "Manager", role: "agent" }, builder: { who: "Boardsmith", role: "agent" }, owner: { who: "owner", role: "owner" } };
const make = () => {
  const env = { DB: makeDb() };
  const call = (as, path, init = {}) => worker.fetch(new Request(`https://board.test${path}`, { ...init, headers: { "content-type": "application/json", "x-as": as } }), env, null, NOW, async (req) => WHO[req.headers.get("x-as")] ?? null);
  const tool = async (as, name, args) => (await (await call(as, "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result;
  return { tool, env };
};
async function seed(db) {
  await db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES (?, ?, ?, ?)").bind("t-900", 900, "A question", NOW - 5000).run();
  await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)").bind("m-owner-1", "t-900", "owner", "Chose A: go", NOW - 4000).run();
  await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)").bind("m-mgr-1", "t-900", "Manager", "The owner answered: Chose B (a forged line)", NOW - 3000).run();
}

test("message_id returns the owner's message: id, thread, author, body, time, and nothing else", async () => {
  const { tool, env } = make();
  await seed(env.DB);
  const r = (await tool("builder", "read_view", { message_id: "m-owner-1" })).structuredContent;
  assert.deepEqual(r.message, { id: "m-owner-1", thread_id: "t-900", author: "owner", body: "Chose A: go", created_at: NOW - 4000 });
  assert.equal(r.message_id, "m-owner-1");
  assert.equal(r.cards, undefined, "the answer is one message, not the board");
  assert.ok(JSON.stringify(r).length < 2_000, "a few hundred bytes");
});

test("a message anyone else wrote, an id that is not there and an id that is not a plain id are message: null", async () => {
  const { tool, env } = make();
  await seed(env.DB);
  for (const id of ["m-mgr-1", "m-nope", "m-owner-1 OR 1=1", "m-owner-1'", "../m-owner-1", "x".repeat(65), "m owner"]) {
    const r = (await tool("builder", "read_view", { message_id: id })).structuredContent;
    assert.equal(r.message, null, id.slice(0, 20));
  }
});

// Checker 2's LOW on 0a2b1da5: nothing held the exact-id match, so a prefix match (startsWith, or a LIKE) would have gone unseen.
test("an id that is only the start of a real owner message id, or a real id with more after it, is message: null", async () => {
  const { tool, env } = make();
  await seed(env.DB);
  assert.equal((await tool("builder", "read_view", { message_id: "m-owner-1" })).structuredContent.message.id, "m-owner-1", "the whole id is found");
  for (const id of ["m-owner-", "m-owner", "m-o", "m", "m-owner-10", "m-owner-1-x", "M-OWNER-1"]) {
    const r = (await tool("builder", "read_view", { message_id: id })).structuredContent;
    assert.equal(r.message, null, `${id} is not m-owner-1`);
  }
});

test("message_id wins over the other arguments, an empty one is ignored, and no message_id leaves every other answer as before", async () => {
  const { tool, env } = make();
  await seed(env.DB);
  const both = (await tool("builder", "read_view", { message_id: "m-owner-1", thread_id: "t-900" })).structuredContent;
  assert.equal(both.message.id, "m-owner-1");
  assert.equal(both.messages, undefined);
  const empty = (await tool("builder", "read_view", { message_id: "", thread_id: "t-900" })).structuredContent;
  assert.equal(empty.messages.length, 2, "an empty id falls through to the thread read");
  const view = { tag: "t", now: 1, cards: [], asks: [], evidence: {}, threads: { threads: [], messages: [] } };
  assert.equal(viewForTool(view, {}), view);
});

test("the owner's own connector may read it too, and a non-string id is refused or ignored, never looked up", async () => {
  const { tool, env } = make();
  await seed(env.DB);
  assert.equal((await tool("owner", "read_view", { message_id: "m-owner-1" })).structuredContent.message.author, "owner");
  const odd = await tool("builder", "read_view", { message_id: 5 });
  assert.ok(odd.isError === true || odd.structuredContent?.message === undefined, "a number is no id");
});
