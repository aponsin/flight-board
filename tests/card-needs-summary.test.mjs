// #C1087 (11-16: #C1074 was created with no summary and the builder had nothing to build from): the card_create TOOL refuses a card with no summary, or one that
// is only blanks, unless from_thread is the number of a thread that exists and so explains the card. The store function without the tool's option is as before.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { createCard, createAsk } from "../worker/board-store.mjs";

const T = 1_800_000_000_000;
const tool = (db, fields) => createCard(db, T, "Manager", fields, { needSummary: true });
const refusedAs = (r, rule) => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.refused?.rule ?? r.rule, rule, JSON.stringify(r)); };

test("no summary and no from_thread: refused with the rule card-summary; a summary: ok", async () => {
  const db = makeDb();
  refusedAs(await tool(db, { id: "c-none", title: "No words" }), "card-summary");
  assert.equal((await tool(db, { id: "c-ok", title: "With words", summary: "Build the thing, because the owner asked." })).ok, true);
});

test("an empty, blank or non-text summary is no summary", async () => {
  const db = makeDb();
  for (const [i, summary] of ["", "   \n\t ", null, 7, ["a"]].entries()) refusedAs(await tool(db, { id: `c-bad-${i}`, title: "x", summary }), "card-summary");
});

test("from_thread alone is ok when it names a thread that exists; an unknown, zero, negative or non-integer one is refused", async () => {
  const db = makeDb();
  const ask = await createAsk(db, T, { type: "Answer", title: "A question", asked_by: "Manager", question: "Why?" });
  assert.ok(ask.ok, JSON.stringify(ask));
  assert.equal((await tool(db, { id: "c-thread", title: "From a thread", from_thread: ask.num })).ok, true);
  await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES ('m-1', 't777', 'owner', 'build it', ?)").bind(T).run();
  assert.equal((await tool(db, { id: "c-msgs", title: "From a messages thread", from_thread: 777 })).ok, true);
  for (const [i, from_thread] of [9999, 0, -1, 1.5, "1"].entries()) refusedAs(await tool(db, { id: `c-t-${i}`, title: "x", from_thread }), "card-summary");
});

test("the store function without the tool's option is as before (no summary needed): importers and older callers are untouched", async () => {
  const db = makeDb();
  assert.equal((await createCard(db, T, "Manager", { id: "c-plain", title: "Plain" })).ok, true);
});

// Checker 2's F1 LOW: the tool wiring itself. board-worker.mjs's card_create case passes { needSummary: true }; dropping it left every test green.
test("through the card_create TOOL (the worker's own wiring): no summary and no from_thread is refused with card-summary; a summary is ok", async () => {
  const env = { DB: makeDb() };
  const call = (body) => worker.fetch(new Request("https://board.test/mcp", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-as": "manager" } }), env, null, T, async () => ({ who: "Manager", role: "agent" }));
  const tool = async (args) => (await (await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "card_create", arguments: args } })).json()).result.structuredContent;
  const bare = await tool({ id: "c-tool-bare", title: "No words" });
  assert.equal(bare.ok, false, JSON.stringify(bare));
  assert.equal(bare.refused?.rule ?? bare.rule, "card-summary", JSON.stringify(bare));
  assert.equal((await tool({ id: "c-tool-ok", title: "With words", summary: "Build the thing, because it is needed." })).ok, true);
});

test("the refusal is logged and says what to do", async () => {
  const db = makeDb();
  const r = await tool(db, { id: "c-log", title: "x" });
  assert.match(JSON.stringify(r), /summary/);
  assert.match(JSON.stringify(r), /from_thread/);
  const row = await db.prepare("SELECT rule FROM refusals WHERE rule = 'card-summary'").first();
  assert.ok(row, "the refusal is in the log");
});
