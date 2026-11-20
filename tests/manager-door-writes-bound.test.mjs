// #C1298 (11-19: a session that was not Manager's wrote a message through Manager's connector, so the board signed it "Manager" and the owner got a new-reply badge for it): the door guard
// read_inbox has (#C827) now covers every write on Manager's door. A write names the caller's session (`session`, taken off the arguments before the tool sees them) and the Worker compares it with
// the door session: none named is refused, so is one that is not the set one; with none set, a named session goes through (a deploy never shuts Manager out). Nothing is written on a refusal.
// Reads (read_view) and the two door tools (read_inbox, set_door_session) carry their own guards. The shared door is unchanged. It guards against accidents, not against someone who copies the id.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { setDoorSession } from "../worker/board-store.mjs";

const NOW = 1_800_000_000_000;
const SECRET = "s".repeat(43), MSECRET = "m".repeat(43);
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const SESSION = "local_b0c20591-32ff-41db-b0e5-ff9fc3fb26de", OTHER = "local_aaaaaaaa-1111-2222-3333-444444444444";
const make = async () => {
  const env = { DB: makeDb(), CONNECTOR_HASH: await sha(SECRET), MANAGER_CONNECTOR_HASH: await sha(MSECRET) };
  const rpc = async (secret, method, params) => (await (await worker.fetch(new Request(`https://board.test/mcp/${secret}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env, null, NOW, async () => null)).json());
  const manager = async (name, args = {}) => (await rpc(MSECRET, "tools/call", { name, arguments: args })).result;
  const shared = async (as, name, args = {}) => (await rpc(SECRET, "tools/call", { name, arguments: { as, ...args } })).result;
  const messages = async () => (await env.DB.prepare("SELECT author, body FROM messages WHERE thread_id = 't-900' ORDER BY created_at").all()).results;
  const refusals = async () => (await env.DB.prepare("SELECT rule FROM refusals WHERE rule = 'door-session-mismatch'").all()).results.length;
  return { env, rpc, manager, shared, messages, refusals };
};
const post = (extra = {}) => ({ thread_id: "t-900", body: "a note", ...extra });

test("a write on Manager's door that names no session is refused, nothing is written, and the refusal is logged (with or without a door session set)", async () => {
  const { env, manager, messages, refusals } = await make();
  for (const none of [undefined, "", "   ", 7, null]) {
    const r = await manager("post", post(none === undefined ? {} : { session: none }));
    assert.equal(r.isError, true, String(none));
    assert.equal(r.structuredContent.refused.rule, "door-session-mismatch");
    assert.match(r.structuredContent.refused.detail, /needs the `session` argument/);
  }
  assert.deepEqual(await messages(), [], "nothing written");
  assert.equal(await refusals(), 5);
  assert.equal((await setDoorSession(env.DB, NOW, "Manager", SESSION)).ok, true);
  assert.equal((await manager("post", post())).isError, true, "also with a door session set");
  assert.deepEqual(await messages(), []);
});

test("with a door session set, only that session writes; another session's write is refused and writes nothing, and the expected id is never echoed", async () => {
  const { env, manager, messages } = await make();
  assert.equal((await setDoorSession(env.DB, NOW, "Manager", SESSION)).ok, true);
  const bad = await manager("post", post({ session: OTHER }));
  assert.equal(bad.isError, true);
  assert.match(bad.structuredContent.refused.detail, /not the one set for Manager's door/);
  assert.ok(!JSON.stringify(bad).includes(SESSION), "the set id is not given back");
  assert.deepEqual(await messages(), []);
  const good = await manager("post", post({ session: SESSION }));
  assert.equal(good.isError, false, JSON.stringify(good));
  assert.deepEqual((await messages()).map((m) => [m.author, m.body]), [["Manager", "a note"]]);
});

test("with no door session set, a write that names a session goes through (a deploy never shuts Manager out)", async () => {
  const { manager, messages } = await make();
  assert.equal((await manager("post", post({ session: SESSION }))).isError, false);
  assert.equal((await messages()).length, 1);
});

test("the session is not a field of the tool: it is taken off before the write (card_create and ask still validate their own fields), and it is not stored", async () => {
  const { env, manager } = await make();
  assert.equal((await setDoorSession(env.DB, NOW, "Manager", SESSION)).ok, true);
  const ask = await manager("ask", { session: SESSION, type: "Action", title: "Mine", steps: ["x"], expect: "y" });
  assert.equal(ask.isError, false, JSON.stringify(ask));
  assert.ok(!(await env.DB.prepare("SELECT * FROM asks").all()).results.some((r) => Object.values(r).includes(SESSION)), "the session id is in no ask row");
  const stray = await manager("post", post({ session: SESSION, nonsense: 1 }));
  assert.equal(stray.isError, true, "an unknown field is still refused by the tool's own rule");
});

test("tools/list on Manager's door shows `session` as required on every write tool, and not on read_view, read_inbox or set_door_session; the shared door's list has none", async () => {
  const { rpc } = await make();
  const tools = (await rpc(MSECRET, "tools/list")).result.tools;
  const writes = tools.filter((t) => !["read_view", "read_inbox", "set_door_session"].includes(t.name));
  assert.ok(writes.length >= 8, "there are write tools");
  for (const t of writes) { assert.ok(t.inputSchema.properties.session, `${t.name} has session`); assert.ok(t.inputSchema.required.includes("session"), `${t.name} requires it`); }
  assert.ok(!("session" in tools.find((t) => t.name === "read_view").inputSchema.properties));
  assert.ok(tools.find((t) => t.name === "read_inbox").inputSchema.required.includes("session"), "read_inbox keeps its own");
  assert.deepEqual(tools.find((t) => t.name === "set_door_session").inputSchema.required, ["session"], "set_door_session is unchanged");
  const shared = (await rpc(SECRET, "tools/list")).result.tools;
  assert.ok(shared.every((t) => !("session" in t.inputSchema.properties)), "the shared door takes no session");
});

test("reads and the door tools are not covered: read_view needs no session, read_inbox and set_door_session keep their own guards; the shared door writes as before", async () => {
  const { env, manager, shared, messages } = await make();
  assert.equal((await manager("read_view")).isError, false, "read_view needs no session");
  assert.equal((await manager("read_inbox", {})).isError, true, "read_inbox with no session is refused by its own guard");
  assert.equal((await manager("set_door_session", { session: SESSION })).isError, false, "the first id needs nothing");
  assert.equal((await manager("set_door_session", { session: OTHER })).isError, true, "changing it needs `current`");
  assert.equal((await shared("Builder", "post", post({ body: "from a builder" }))).isError, false);
  assert.deepEqual((await messages()).map((m) => m.author), ["Builder"], "signed with the `as` it declared, no session needed");
  assert.ok(env, "ok");
});
