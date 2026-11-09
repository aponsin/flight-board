import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker, { TOOLS } from "../worker/board-worker.mjs";

const NOW = 1_800_000_000_000;
const WHO = { manager: { who: "Manager", role: "agent" }, owner: { who: "owner", role: "owner" }, probe: { who: "probe", role: "probe" } };
const make = () => {
  const env = { DB: makeDb() };
  const call = (as, path, init = {}, now = NOW) => worker.fetch(new Request(`https://board.test${path}`, init), env, null, now, async (req) => WHO[req.headers.get("x-as")] ?? null);
  const rpc = async (as, method, params, id = 1, now = NOW) => (await call(as, "/mcp", { method: "POST", headers: { "x-as": as }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }, now)).json();
  const tool = async (as, name, args, now = NOW) => (await rpc(as, "tools/call", { name, arguments: args }, 1, now)).result;
  return { env, call, rpc, tool };
};

test("no identity, no answer", async () => {
  const { call } = make();
  assert.equal((await call("nobody", "/api/view", { headers: { "x-as": "nobody" } })).status, 401);
});

test("no tool writes status or phase, and the tool schemas forbid unknown fields", () => {
  for (const t of TOOLS) {
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    for (const f of ["status", "phase", "num", "live_version"]) assert.ok(!(f in t.inputSchema.properties), `${t.name} has ${f}`);
  }
});

test("tools/list shows each role only its tools; the probe has no card or ask tools", async () => {
  const { rpc } = make();
  const names = async (as) => (await rpc(as, "tools/list")).result.tools.map((t) => t.name);
  assert.ok((await names("manager")).includes("ask"));
  assert.ok(!(await names("manager")).includes("ack"));
  assert.ok((await names("owner")).includes("ack"));
  assert.deepEqual(await names("probe"), ["read_view"]);
});

test("a bad ask is refused in the same call and shows in the view's refusal log", async () => {
  const { tool } = make();
  const r = await tool("manager", "ask", { type: "Later", title: "t", text: "x" });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.refused.rule, "later-without-eta");
  const view = (await tool("manager", "read_view", {})).structuredContent;
  assert.equal(view.refusals[0].rule, "later-without-eta");
  assert.equal(view.refusals[0].who, "Manager");
});

test("who asks is who authenticated: a claimed other name is refused", async () => {
  const { tool } = make();
  const r = await tool("manager", "ask", { type: "Thread", title: "t", text: "x", asked_by: "Checker" });
  assert.equal(r.structuredContent.refused.rule, "asked-by-mismatch");
  const ok = await tool("manager", "ask", { type: "Thread", title: "t", text: "x" });
  assert.equal(ok.structuredContent.ok, true);
});

test("a role without the tool cannot call it", async () => {
  const { rpc } = make();
  const r = await rpc("manager", "tools/call", { name: "ack", arguments: { version: "1" } });
  assert.equal(r.error.code, -32602);
  assert.equal((await rpc("probe", "tools/call", { name: "card_create", arguments: { id: "x", title: "x" } })).error.code, -32602);
});

test("the view answers 304 to its own tag and a new tag after a change", async () => {
  const { call, tool } = make();
  const a = await call("manager", "/api/view", { headers: { "x-as": "manager" } });
  const tag = a.headers.get("etag");
  assert.ok(tag);
  const same = await call("manager", "/api/view", { headers: { "x-as": "manager", "if-none-match": tag } }, NOW + 5000);
  assert.equal(same.status, 304);
  await tool("manager", "card_create", { id: "c-one", title: "One" });
  const after = await call("manager", "/api/view", { headers: { "x-as": "manager", "if-none-match": tag } });
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.get("etag"), tag);
});

test("only the probe writes evidence over HTTP, and a second lit phase is refused with 422", async () => {
  const { call } = make();
  const post = (as, body) => call(as, "/api/probe/evidence", { method: "POST", headers: { "x-as": as }, body: JSON.stringify(body) });
  assert.equal((await post("manager", { key: "live", value: { version: "1" } })).status, 403);
  assert.equal((await post("probe", { key: "live", value: { version: "1" } })).status, 200);
  assert.equal((await post("probe", { key: "cards.c-one", value: { lit: ["build", "test"] } })).status, 422);
});

test("card and answer round trip: a Decision answer must be an option", async () => {
  const { tool } = make();
  const ask = await tool("manager", "ask", { type: "Decision", title: "Pick", question: "A or B?", options: ["A", "B"], recommended: "A" });
  const id = ask.structuredContent.id;
  assert.equal((await tool("owner", "answer", { id, answer: "C" })).structuredContent.refused.rule, "answer-not-an-option");
  assert.equal((await tool("owner", "answer", { id, answer: "B" })).structuredContent.ok, true);
  assert.equal((await tool("owner", "answer", { id, answer: "A" })).structuredContent.refused.rule, "ask-already-answered");
});
