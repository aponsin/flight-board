// GET /api/compat and POST /api/compat/write (#C723 A2/A3) through the Worker, on the same in-memory D1 as the other Worker tests.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";

const NOW = 1_800_000_000_000;
const WHO = { manager: { who: "Manager", role: "agent" }, owner: { who: "owner", role: "owner" }, probe: { who: "probe", role: "probe" } };
const make = () => {
  const env = { DB: makeDb() };
  const call = (as, path, init = {}) => worker.fetch(new Request(`https://board.test${path}`, init.method === "POST" ? { ...init, headers: { "content-type": "application/json", "x-as": as, ...init.headers } } : { ...init, headers: { "x-as": as, ...init.headers } }), env, null, NOW, async (req) => WHO[req.headers.get("x-as")] ?? null);
  const tool = async (as, name, args) => (await (await call(as, "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.structuredContent;
  const write = async (w, as = "owner") => { const r = await call(as, "/api/compat/write", { method: "POST", body: JSON.stringify(w) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const compat = async () => (await call("owner", "/api/compat")).json();
  return { env, call, tool, write, compat };
};
const decision = { type: "Decision", title: "Hero", question: "Which hero?", options: ["Blue", "Green"], recommended: "Blue" };

test("GET /api/compat answers in the old shapes, with an ETag and a 304", async () => {
  const { call, tool } = make();
  await tool("manager", "ask", decision);
  const r = await call("owner", "/api/compat");
  assert.equal(r.status, 200); const etag = r.headers.get("etag"); assert.match(etag, /^"c-/);
  const body = await r.json();
  assert.equal(body.collections.waiting.length, 1); assert.equal(body.collections.waiting[0].kind, "decision"); assert.equal(body.collections.waiting[0].options[1].key, "B");
  assert.equal((await call("owner", "/api/compat", { headers: { "if-none-match": etag } })).status, 304);
  assert.equal((await call("probe", "/api/compat")).status, 403);
});

test("a choice by key is stored as the option's own text; a key that is no option is refused", async () => {
  const { tool, write, compat } = make();
  const { id } = await tool("manager", "ask", decision);
  const bad = await write({ op: "update", path: `waiting/${id}`, data: { response: { status: "chose", choice: "Z", note: "", at: 1 } } });
  assert.equal(bad.status, 422); assert.equal(bad.body.refused.rule, "answer-not-an-option");
  const ok = await write({ op: "update", path: `waiting/${id}`, data: { response: { status: "chose", choice: "B", note: "", at: 1 }, respondedAt: 1 } });
  assert.equal(ok.status, 200);
  assert.equal((await compat()).collections.waiting[0].response.choice, "B");
  assert.equal((await write({ op: "update", path: `waiting/${id}`, data: { response: { status: "chose", choice: "A", note: "", at: 2 } } })).body.refused.rule, "ask-already-answered");
});

test("Ack and Done answer a non-Decision; a Decision refuses them; a ping alone is accepted and stores nothing", async () => {
  const { tool, write } = make();
  const a = await tool("manager", "ask", { type: "Answer", title: "Is it live?", question: "Is it live?" });
  assert.equal((await write({ op: "update", path: `waiting/${a.id}`, data: { ping: "sent" } })).status, 200);
  assert.equal((await write({ op: "update", path: `waiting/${a.id}`, data: { response: { status: "ack", note: "", at: 1 } } })).status, 200);
  const d = await tool("manager", "ask", decision);
  assert.equal((await write({ op: "update", path: `waiting/${d.id}`, data: { response: { status: "ack", note: "", at: 1 } } })).body.refused.rule, "answer-not-an-option");
});

test("a note with a choice, files and every route that does not exist yet are refused by name, and logged", async () => {
  const { tool, write, call } = make();
  const { id } = await tool("manager", "ask", decision);
  for (const w of [
    { op: "update", path: `waiting/${id}`, data: { response: { status: "chose", choice: "A", note: "but why", at: 1 } } },
    { op: "set", path: "messages/m1-abc", data: { thread: id, from: "owner", text: "hi", at: 1 } },
    { op: "set", path: "approvals/pr5", data: { number: 5 } },
    { op: "update", path: "checkRequests/c1", data: { at: 1 } },
  ]) { const r = await write(w); assert.equal(r.status, 422, JSON.stringify(w)); assert.equal(r.body.refused.rule, "no-route-yet", JSON.stringify(w)); }
  // #C726: files now go through the file store's checks; an id that is no stored file's id is refused by name, before anything is stored.
  const bad = await write({ op: "update", path: `waiting/${id}`, data: { response: { status: "chose", choice: "A", note: "", files: ["x"], at: 1 } } });
  assert.equal(bad.status, 422); assert.equal(bad.body.refused.rule, "files-shape");
  const view = await (await call("owner", "/api/view")).json();
  assert.ok(view.refusals.some((x) => x.rule === "no-route-yet"));
  assert.equal(view.asks[0].answered_at, null, "nothing was half-applied");
});

test("an ask the asker closed first: the owner's answer-and-done is refused whole, and nothing is stored (Checker)", async () => {
  const { tool, write, call } = make();
  const a = await tool("manager", "ask", { type: "Action", title: "Run it", steps: ["Run."], expect: "done" });
  await tool("manager", "ask_close", { id: a.id });
  const r = await write({ op: "update", path: `waiting/${a.id}`, data: { response: { status: "done", note: "", at: 1 }, done: true } });
  assert.equal(r.status, 422); assert.equal(r.body.refused.rule, "ask-already-closed");
  const view = await (await call("owner", "/api/view")).json();
  assert.equal(view.asks[0].answered_at, null, "no answer was stored");
  assert.equal((await write({ op: "update", path: `waiting/${a.id}`, data: { done: true } })).body.refused.rule, "ask-already-closed");
  assert.equal((await write({ op: "update", path: `waiting/${a.id}`, data: { ping: "sent" } })).status, 200, "a ping alone still passes");
});

test("to-do and idea rows: add, done, move", async () => {
  const { write, compat } = make();
  assert.equal((await write({ op: "set", path: "todo/t1", data: { text: "Buy milk", rank: 1, area: "home", addedAt: 1, done: false } })).status, 200);
  assert.equal((await write({ op: "set", path: "ideas/t2", data: { text: "An idea", rank: 1, addedAt: 1, done: false, kind: "idea" } })).status, 200);
  const c = (await compat()).collections;
  assert.equal(c.todo.length, 1); assert.equal(c.ideas.length, 1);
  const id = c.todo[0].id;
  assert.equal((await write({ op: "update", path: `todo/${id}`, data: { rank: 2 } })).status, 200);
  assert.equal((await write({ op: "update", path: `todo/${id}`, data: { done: true, doneAt: 5 } })).status, 200);
  assert.equal((await compat()).collections.todo[0].done, true);
  assert.equal((await write({ op: "update", path: `ideas/${c.ideas[0].id}`, data: { startAt: 1 } })).body.refused.rule, "no-route-yet");
});

test("only the owner writes, and the usual POST guards still hold", async () => {
  const { write, call } = make();
  assert.equal((await write({ op: "set", path: "todo/t1", data: { text: "x" } }, "manager")).status, 403);
  assert.equal((await call("owner", "/api/compat/write", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await write({ op: "frob", path: "todo/t1" })).status, 422);
  assert.equal((await write({ op: "set", path: "../x" })).status, 422);
});
