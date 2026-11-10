import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker, { TOOLS } from "../worker/board-worker.mjs";

const NOW = 1_800_000_000_000;
const WHO = { manager: { who: "Manager", role: "agent" }, builder: { who: "Builder", role: "agent" }, owner: { who: "owner", role: "owner" }, probe: { who: "probe", role: "probe" } };
const make = () => {
  const env = { DB: makeDb() };
  // A POST says application/json unless the test sets another content type (the guard refuses anything else).
  const call = (as, path, init = {}, now = NOW) => worker.fetch(new Request(`https://board.test${path}`, init.method === "POST" ? { ...init, headers: { "content-type": "application/json", ...init.headers } } : init), env, null, now, async (req) => WHO[req.headers.get("x-as")] ?? null);
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
    // The step tool names the phase a WAIT is at (it requires a wait, so it can never log a work phase: the probe alone says which phase is lit).
    for (const f of ["status", "phase", "num", "live_version"]) assert.ok(!(f in t.inputSchema.properties) || (t.name === "step" && f === "phase" && t.inputSchema.required.includes("wait")), `${t.name} has ${f}`);
  }
});

test("the ask tool's schema lets an Action's step be text or {text, cmd}, and nothing else (#C725 B2)", () => {
  const items = TOOLS.find((t) => t.name === "ask").inputSchema.properties.steps.items;
  const kinds = items.anyOf;
  assert.deepEqual(kinds[0], { type: "string" });
  assert.deepEqual(Object.keys(kinds[1].properties).sort(), ["cmd", "text"]);
  assert.equal(kinds[1].additionalProperties, false);
  assert.deepEqual(kinds[1].required, ["text"]);
});

test("a POST that is not application/json is refused (a cross-site text/plain form), on the page route and on /mcp", async () => {
  const { call } = make();
  const body = JSON.stringify({ id: "t1", answer: "A" });
  const rpcBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  for (const [path, b] of [["/api/answer", body], ["/mcp", rpcBody]]) {
    for (const type of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      assert.equal((await call("owner", path, { method: "POST", headers: { "x-as": "owner", "content-type": type }, body: b })).status, 415, `${path} ${type}`);
    }
    assert.equal((await call("owner", path, { method: "POST", headers: { "x-as": "owner" }, body: b })).status !== 415, true);
  }
});

test("a browser POST from another origin or another site is refused; the same origin and a client with no Origin pass", async () => {
  const { call } = make();
  const post = (headers) => call("owner", "/mcp", { method: "POST", headers: { "x-as": "owner", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal((await post({ origin: "https://evil.test" })).status, 403);
  assert.equal((await post({ origin: "https://board.test.evil.test" })).status, 403);
  assert.equal((await post({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post({ "sec-fetch-site": "same-site" })).status, 403);
  assert.equal((await post({ origin: "https://board.test", "sec-fetch-site": "same-origin" })).status, 200);
  assert.equal((await post({})).status, 200);
});

test("only the owner answers: an agent's answer is an unknown tool, and the owner's answer records answered_by", async () => {
  const { tool, rpc, env } = make();
  const made = (await tool("manager", "ask", { type: "Later", title: "t", asked_by: "Manager", text: "x", eta_at: NOW + 86_400_000 })).structuredContent;
  assert.equal(made.ok, true);
  const bad = await rpc("manager", "tools/call", { name: "answer", arguments: { id: made.id, answer: "yes" } });
  assert.equal(bad.error.message, "unknown tool");
  assert.ok(!(await rpc("manager", "tools/list")).result.tools.some((t) => t.name === "answer"));
  const logged = (await env.DB.prepare("SELECT rule, who FROM refusals WHERE rule = 'tool-not-allowed'").all()).results;
  assert.deepEqual(logged, [{ rule: "tool-not-allowed", who: "Manager" }], "the agent's try is in the refusal log");
  assert.equal((await env.DB.prepare("SELECT answered_at FROM asks WHERE id = ?").bind(made.id).first()).answered_at, null, "and the ask is still unanswered");
  assert.equal((await tool("owner", "answer", { id: made.id, answer: "yes" })).structuredContent.ok, true);
  assert.equal((await env.DB.prepare("SELECT answered_by FROM asks WHERE id = ?").bind(made.id).first()).answered_by, "owner");
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

test("ask_close over MCP: another agent cannot close Manager's ask, the refusal is logged, and the asker or the owner can (Checker on v10)", async () => {
  const { tool, call } = make();
  const ask = await tool("manager", "ask", { type: "Action", title: "Rotate the key", steps: ["rotate"], expect: "done" });
  const id = ask.structuredContent.id;
  assert.equal((await tool("builder", "ask_close", { id })).structuredContent.refused.rule, "close-not-yours");
  const v = await (await call("manager", "/api/view", { headers: { "x-as": "manager" } })).json();
  assert.equal(v.asks[0].closed_at, null);
  assert.deepEqual(v.refusals.map((r) => [r.rule, r.who]), [["close-not-yours", "Builder"]]);
  assert.equal((await tool("manager", "ask_close", { id })).structuredContent.ok, true);
  assert.equal((await tool("probe", "ask_close", { id })), undefined, "the probe has no close tool");
});

test("the To-do and Ideas lists: agents add and change rows over MCP, the owner marks one done from the page, others cannot", async () => {
  const { tool, call } = make();
  const a = await tool("manager", "list_add", { kind: "todo", text: "Glance at the crawlers list", area: "Search", rank: 6 });
  assert.equal(a.structuredContent.ok, true);
  const i = await tool("builder", "list_add", { kind: "idea", text: "Send this look", note: "after the drop-down" });
  assert.equal((await tool("manager", "list_add", { kind: "todo" })).structuredContent.refused.rule, "list-text");
  assert.equal((await tool("manager", "list_add", { kind: "chore", text: "x" })).structuredContent.refused.rule, "list-kind");
  assert.equal((await tool("manager", "list_update", { id: a.structuredContent.id, kind: "idea" })).structuredContent.refused.rule, "list-kind", "a row's kind never changes");
  const post = (as, body) => call(as, "/api/list", { method: "POST", headers: { "x-as": as }, body: JSON.stringify(body) });
  assert.equal((await post("manager", { id: a.structuredContent.id, done: true })).status, 403, "the page route is the owner's");
  assert.equal((await post("owner", { id: a.structuredContent.id, done: true })).status, 200);
  assert.equal((await post("owner", { id: "nope", done: true })).status, 422);
  const v = await (await call("owner", "/api/view", { headers: { "x-as": "owner" } })).json();
  assert.deepEqual(v.lists.map((l) => [l.kind, l.done, l.done_at]), [["idea", 0, null], ["todo", 1, NOW]]);
  assert.equal(v.lists.find((l) => l.kind === "idea").id, i.structuredContent.id);
});

test("card and answer round trip: a Decision answer must be an option", async () => {
  const { tool } = make();
  const ask = await tool("manager", "ask", { type: "Decision", title: "Pick", question: "A or B?", options: ["A", "B"], recommended: "A" });
  const id = ask.structuredContent.id;
  assert.equal((await tool("owner", "answer", { id, answer: "C" })).structuredContent.refused.rule, "answer-not-an-option");
  assert.equal((await tool("owner", "answer", { id, answer: "B" })).structuredContent.ok, true);
  assert.equal((await tool("owner", "answer", { id, answer: "A" })).structuredContent.refused.rule, "ask-already-answered");
});
