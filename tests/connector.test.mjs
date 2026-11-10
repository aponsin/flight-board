import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker, { secretMatches } from "../worker/board-worker.mjs";
import { ROSTER_ROLES, closeRefusal, listWriteRefusal } from "../worker/board-rules.mjs";
import { closeAsk, createAsk, readView, postMessage, wakeAsk, wakeResult } from "../worker/board-store.mjs";

const NOW = 1_800_000_000_000;
const SECRET = "s".repeat(43);
const HASH = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SECRET)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const MSECRET = "m".repeat(43); // Manager's own door (#T1661)
const MHASH = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(MSECRET)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const noAccess = async () => null; // the connector path never asks Access
const make = () => {
  const env = { DB: makeDb(), CONNECTOR_HASH: HASH, MANAGER_CONNECTOR_HASH: MHASH };
  const post = (path, body, headers = {}) => worker.fetch(new Request(`https://board.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env, null, NOW, noAccess);
  const rpc = async (method, params, secret = SECRET) => (await post(`/mcp/${secret}`, { jsonrpc: "2.0", id: 1, method, params })).json();
  const tool = async (as, name, args) => (await rpc("tools/call", { name, arguments: { as, ...args } }));
  // Manager's door: no `as`, who is always Manager.
  const mtool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args }, MSECRET));
  return { env, post, rpc, tool, mtool };
};
const decision = { type: "Decision", title: "Pick", question: "A or B?", options: ["A", "B"], recommended: "A" };

test("the connector door is the secret's hash: a wrong secret, no hash set, a GET and a malformed hash all get a bare 404", async () => {
  const { env, post } = make();
  const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  assert.equal((await post(`/mcp/${SECRET}`, body)).status, 200);
  assert.equal((await post(`/mcp/${SECRET}x`, body)).status, 404);
  assert.equal((await post(`/mcp/`, body)).status, 404);
  assert.equal((await worker.fetch(new Request(`https://board.test/mcp/${SECRET}`), env, null, NOW, noAccess)).status, 404);
  delete env.CONNECTOR_HASH;
  assert.equal((await post(`/mcp/${SECRET}`, body)).status, 404, "no hash set: closed");
  env.CONNECTOR_HASH = SECRET; // the secret itself is not a hash
  assert.equal((await post(`/mcp/${SECRET}`, body)).status, 404);
  assert.equal(await secretMatches(SECRET, HASH.toUpperCase()), false);
  assert.equal(await secretMatches(SECRET, HASH), true);
});

test("the whole hash is compared, not a prefix: a hash that differs from the right one in ANY single character (first, last, every place between) does not open the door (Security on v13)", async () => {
  for (let i = 0; i < 64; i++) {
    const other = HASH[i] === "0" ? "1" : "0";
    const wrong = HASH.slice(0, i) + other + HASH.slice(i + 1);
    assert.equal(await secretMatches(SECRET, wrong), false, `differs at ${i}`);
  }
  assert.equal(await secretMatches(SECRET, HASH), true);
  const { env, post } = make();
  env.CONNECTOR_HASH = HASH.slice(0, 63) + (HASH[63] === "0" ? "1" : "0");
  assert.equal((await post(`/mcp/${SECRET}`, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 404, "last character differs, through the Worker");
  env.CONNECTOR_HASH = (HASH[0] === "0" ? "1" : "0") + HASH.slice(1);
  assert.equal((await post(`/mcp/${SECRET}`, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 404, "first character differs, through the Worker");
});

test("a configured hash that is not exactly 64 lowercase hex characters opens nothing, even for the right secret (Security on v13)", async () => {
  const { env, post } = make();
  for (const bad of [HASH.toUpperCase(), HASH.slice(0, 63), HASH + "0", "", " " + HASH.slice(1), HASH.slice(0, 63) + "g", null, 5]) {
    env.CONNECTOR_HASH = bad;
    assert.equal((await post(`/mcp/${SECRET}`, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 404, JSON.stringify(bad));
  }
  env.CONNECTOR_HASH = HASH;
  assert.equal((await post(`/mcp/${SECRET}`, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 200);
});

test("a browser page cannot use the connector: an Origin header or a non-JSON body is refused", async () => {
  const { post, env } = make();
  assert.equal((await post(`/mcp/${SECRET}`, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.test" })).status, 403);
  const r = await worker.fetch(new Request(`https://board.test/mcp/${SECRET}`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }), env, null, NOW, noAccess);
  assert.equal(r.status, 415);
});

test("the connector offers only the agents' tools, each with a required `as` that is one of the 16 roster roles and never the owner", async () => {
  const { rpc } = make();
  const { tools } = (await rpc("tools/list")).result;
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["ask", "ask_close", "card_create", "card_update", "file_put", "list_add", "list_update", "post", "read_view", "step"], "read_inbox is not on the shared door");
  for (const t of tools) {
    assert.ok(t.inputSchema.required.includes("as"), t.name);
    assert.deepEqual(t.inputSchema.properties.as.enum, ROSTER_ROLES, t.name);
  }
  assert.equal(ROSTER_ROLES.length, 16);
  assert.ok(!ROSTER_ROLES.includes("owner") && !ROSTER_ROLES.includes("probe"));
  assert.ok(!tools.find((t) => t.name === "ask").inputSchema.required.includes("asked_by"), "the ask is bound to `as`");
});

test("`as` outside the roster (the owner, a made-up name, nothing) is refused and logged; the owner's tools are not there", async () => {
  const { tool, env } = make();
  for (const as of ["owner", "Somebody", "probe", "manager", undefined]) assert.equal((await tool(as, "read_view", {})).error.code, -32602, String(as));
  assert.deepEqual((await readView(env.DB, NOW)).refusals.map((r) => r.rule), Array(5).fill("as-not-in-roster"));
  for (const name of ["answer", "ack"]) assert.equal((await tool("Manager", name, { id: "t1", answer: "A", version: "v1" })).error.message, "unknown tool", name);
});

test("an ask through the connector is bound to `as`: the Builder's ask says Builder; a claimed other asker is refused", async () => {
  const { tool, env } = make();
  const a = (await tool("Builder", "ask", decision)).result;
  assert.equal(a.structuredContent.ok, true);
  assert.equal((await readView(env.DB, NOW)).asks[0].asked_by, "Builder");
  const bad = (await tool("Builder", "ask", { ...decision, asked_by: "Manager" })).result;
  assert.equal(bad.structuredContent.refused.rule, "asked-by-mismatch");
});

test("the Builder cannot close Manager's ask through the connector; Manager can; the owner name is not claimable", async () => {
  const { tool, env } = make();
  const id = (await tool("Manager", "ask", { type: "Action", title: "Rotate", steps: ["rotate"], expect: "done" })).result.structuredContent.id;
  assert.equal((await tool("Builder", "ask_close", { id })).result.structuredContent.refused.rule, "close-not-yours");
  assert.equal((await tool("Manager", "ask_close", { id })).result.structuredContent.ok, true);
  assert.equal((await readView(env.DB, NOW)).asks[0].closed_by, "Manager");
});

test("read_inbox lives on Manager's own door only: the shared door refuses it for every `as`, Manager included, and logs it; an Access agent cannot call it either (#T1661)", async () => {
  const { tool, mtool, env, rpc } = make();
  for (const as of ["Builder", "Manager"]) assert.equal((await tool(as, "read_inbox", {})).error.message, "unknown tool", as);
  assert.deepEqual((await readView(env.DB, NOW)).refusals.map((r) => r.rule), ["tool-not-allowed", "tool-not-allowed"]);
  assert.equal((await mtool("read_inbox")).result.isError, false);
  // Over Access, an agent token named Manager has no read_inbox either: it is not listed and a call is refused and logged.
  const asManager = async () => ({ who: "Manager", role: "agent" });
  const over = (method, params) => worker.fetch(new Request("https://board.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env, null, NOW, asManager).then((r) => r.json());
  assert.ok(!(await over("tools/list")).result.tools.some((t) => t.name === "read_inbox"));
  assert.equal((await over("tools/call", { name: "read_inbox", arguments: {} })).error.message, "unknown tool");
  assert.equal((await readView(env.DB, NOW)).refusals.length, 3);
  void rpc;
});

test("Manager's door: its own secret and hash, a tool list with read_inbox and no `as`, who is always Manager, and a stray `as` is refused and logged (#T1661)", async () => {
  const { rpc, mtool, env } = make();
  const { tools } = (await rpc("tools/list", undefined, MSECRET)).result;
  assert.ok(tools.some((t) => t.name === "read_inbox"));
  for (const t of tools) assert.ok(!("as" in t.inputSchema.properties) && !t.inputSchema.required.includes("as"), t.name);
  assert.ok(!tools.some((t) => ["answer", "ack"].includes(t.name)), "no owner tools");
  const id = (await mtool("ask", { type: "Action", title: "Mine", steps: ["x"], expect: "y" })).result.structuredContent.id;
  assert.equal((await readView(env.DB, NOW)).asks.find((a) => a.id === id).asked_by, "Manager");
  assert.equal((await mtool("ask", { type: "Action", title: "Claim", steps: ["x"], expect: "y", asked_by: "Builder" })).result.structuredContent.refused.rule, "asked-by-mismatch");
  assert.equal((await mtool("read_view", { as: "Builder" })).error.message, "this door takes no `as`");
  assert.equal((await readView(env.DB, NOW)).refusals.some((r) => r.rule === "as-on-manager-door"), true);
});

test("the two doors are separate: each secret opens only its own door, and one hash on both shuts both (#T1661)", async () => {
  const { env, post } = make();
  const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const names = async (secret) => (await (await post(`/mcp/${secret}`, body)).json()).result.tools.map((t) => t.name);
  assert.ok(!(await names(SECRET)).includes("read_inbox"));
  assert.ok((await names(MSECRET)).includes("read_inbox"));
  env.MANAGER_CONNECTOR_HASH = HASH;
  assert.equal((await post(`/mcp/${SECRET}`, body)).status, 404, "same hash: shared door shut");
  assert.equal((await post(`/mcp/${MSECRET}`, body)).status, 404, "and Manager's secret opens nothing");
  env.MANAGER_CONNECTOR_HASH = MHASH; env.CONNECTOR_HASH = MHASH;
  assert.equal((await post(`/mcp/${MSECRET}`, body)).status, 404, "same hash: Manager's door shut too");
  delete env.CONNECTOR_HASH; env.MANAGER_CONNECTOR_HASH = MHASH;
  assert.equal((await post(`/mcp/${MSECRET}`, body)).status, 200, "Manager's door does not need the shared one");
  assert.equal((await post(`/mcp/${SECRET}`, body)).status, 404);
  delete env.MANAGER_CONNECTOR_HASH;
  assert.equal((await post(`/mcp/${MSECRET}`, body)).status, 404, "no Manager hash: no Manager door");
});

test("end to end: the owner writes, the 20 s ask opens one batch and says send, a good send is recorded, and read_inbox through Manager's door takes it", async () => {
  const { tool, mtool, env } = make();
  // The connector's clock is NOW, so the batch is opened before it (the take must come after the batch).
  await postMessage(env.DB, NOW - 10_000, "owner", { thread_id: "t-one", body: "please look" });
  const first = await wakeAsk(env.DB, NOW - 9000);
  assert.equal(first.send, true);
  assert.match(first.line, /^1 for Manager, batch b-\d+$/, "the line is a count and a batch id, never board text");
  assert.ok(!first.line.includes("please look"));
  await wakeResult(env.DB, NOW - 8000, first.batchId, 0, "ok");
  assert.equal((await wakeAsk(env.DB, NOW - 7000)).send, false, "one send per batch");
  assert.equal((await tool("Builder", "read_inbox", {})).error.message, "unknown tool", "another role cannot take it");
  assert.equal((await wakeAsk(env.DB, NOW - 6000)).count, 1, "still untaken");
  assert.equal((await tool("Manager", "read_inbox", {})).error.message, "unknown tool", "not even as Manager on the shared door");
  assert.equal((await wakeAsk(env.DB, NOW - 5500)).count, 1, "still untaken");
  const got = (await mtool("read_inbox")).result.structuredContent;
  assert.deepEqual(got.messages.map((m) => m.body), ["please look"]);
  const after = await wakeAsk(env.DB, NOW + 1000);
  assert.deepEqual([after.send, after.count, after.status.state], [false, 0, "idle"], "taken: the batch is closed");
});

test("the owner is a role, not a name (Security's nit 1 on v11): an agent whose name is owner closes nothing, and the Worker refuses it", async () => {
  const db = makeDb();
  const ask = await createAsk(db, NOW, { type: "Later", title: "L", asked_by: "Manager", text: "t", eta_at: NOW + 86_400_000 });
  assert.equal((await closeAsk(db, NOW + 1, "owner", ask.id, "agent")).refused.rule, "close-not-yours", "the name owner without the role");
  assert.equal(closeRefusal({ id: "x", asked_by: "owner" }, "owner", "agent").rule, "close-not-yours", "not even as the asker");
  assert.equal(closeRefusal({ id: "x", asked_by: "Manager" }, "owner", undefined).rule, "close-not-yours", "no role is no owner");
  assert.equal(closeRefusal({ id: "x", asked_by: "Manager" }, "owner", "owner"), null);
  assert.equal(closeRefusal({ id: "x", asked_by: "Manager" }, "Manager", "agent"), null);
  const env = { DB: db };
  const res = await worker.fetch(new Request("https://board.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_close", arguments: { id: ask.id } } }) }), env, null, NOW, async () => ({ who: "owner", role: "agent" }));
  assert.equal(res.status, 403);
  assert.equal((await readView(db, NOW + 2)).asks[0].closed_at, null);
});

test("a list row's note is up to 4000 characters: 4000 passes, 4001 is refused (Security's nit 2 on v11)", () => {
  assert.equal(listWriteRefusal({ note: "n".repeat(4000) }), null);
  assert.equal(listWriteRefusal({ note: "n".repeat(4001) }).rule, "list-text");
  assert.equal(listWriteRefusal({ note: "n".repeat(4001) }).detail ?? "", listWriteRefusal({ note: "n".repeat(4001) }).detail ?? "");
});
