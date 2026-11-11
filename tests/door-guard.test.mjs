// store-manager-door-guard (#C827): only the session Manager (or the owner) names may take Manager's wake batch through Manager's door.
// It guards against accidents (another session using Manager's connector), not against someone who copies the id.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { postMessage, setDoorSession, guardedInbox, takeInbox } from "../worker/board-store.mjs";

const T = 1_800_000_000_000;
const SESSION = "local_b0c20591-32ff-41db-b0e5-ff9fc3fb26de", OTHER = "local_aaaaaaaa-1111-2222-3333-444444444444";
const unread = async (db) => (await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE delivered_at IS NULL").first()).n;
const takes = async (db) => (await db.prepare("SELECT claimed, ok, reason FROM inbox_takes ORDER BY id").all()).results;
const call = async (env, who, role, name, args) => {
  const auth = async () => ({ who, role });
  const r = await worker.fetch(new Request("https://b.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env, null, T + 9000, auth);
  return (await r.json());
};
const withMessage = async (db) => { await postMessage(db, T + 1000, "owner", { thread_id: "c-one", body: "hello Manager" }); };

test("with no session set, read_inbox still takes the batch (so a deploy never shuts Manager out) and the take is logged as unguarded", async () => {
  const db = makeDb(); await withMessage(db);
  const got = await guardedInbox(db, T + 2000, undefined);
  assert.equal(got.messages.length, 1); assert.equal(await unread(db), 0);
  assert.deepEqual(await takes(db), [{ claimed: null, ok: 1, reason: "no session set: unguarded" }]);
});

test("a take whose session is not the one set is refused as door-session-mismatch and the batch stays for Manager", async () => {
  const db = makeDb(); await withMessage(db);
  assert.equal((await setDoorSession(db, T, "Manager", SESSION)).ok, true);
  const r = await guardedInbox(db, T + 2000, OTHER);
  assert.equal(r.ok, false); assert.equal(r.refused.rule, "door-session-mismatch");
  assert.equal(await unread(db), 1, "the owner's message is still unread");
  assert.deepEqual(await takes(db), [{ claimed: OTHER, ok: 0, reason: "session does not match" }]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM refusals WHERE rule = 'door-session-mismatch'").first()).n, 1, "it is in the refusal log too");
  // Then Manager's own session takes it.
  const mine = await guardedInbox(db, T + 3000, SESSION);
  assert.equal(mine.messages.length, 1); assert.equal(await unread(db), 0);
  assert.equal((await takes(db)).at(-1).ok, 1);
});

test("a take with no session argument is refused once a session is set; the refusal never echoes the expected id", async () => {
  const db = makeDb(); await withMessage(db); await setDoorSession(db, T, "Manager", SESSION);
  const r = await guardedInbox(db, T + 2000, undefined);
  assert.equal(r.refused.rule, "door-session-mismatch"); assert.equal(await unread(db), 1);
  assert.deepEqual((await takes(db))[0], { claimed: null, ok: 0, reason: "no session given" });
  const wrong = await guardedInbox(db, T + 3000, OTHER);
  assert.doesNotMatch(JSON.stringify(r) + JSON.stringify(wrong), new RegExp(SESSION));
});

test("only Manager or the owner may set the session; its shape is checked; setting again replaces it", async () => {
  const db = makeDb();
  assert.equal((await setDoorSession(db, T, "Checker", SESSION)).refused.rule, "door-session-writer");
  assert.equal((await setDoorSession(db, T, "Manager", "short")).refused.rule, "door-session-shape");
  assert.equal((await setDoorSession(db, T, "Manager", "has spaces and !! in it")).refused.rule, "door-session-shape");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM door_session").first()).n, 0, "nothing was written");
  await setDoorSession(db, T, "Manager", SESSION);
  assert.equal((await setDoorSession(db, T + 1, "owner", OTHER)).ok, true);
  const row = await db.prepare("SELECT session, set_by, set_at FROM door_session").first();
  assert.deepEqual([row.session, row.set_by, row.set_at], [OTHER, "owner", T + 1]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM door_session").first()).n, 1, "one row, replaced");
});

test("on Manager's door, changing an id that is already set needs the current id; the owner does not; the first id needs nothing (Security F1)", async () => {
  const db = makeDb();
  assert.equal((await setDoorSession(db, T, "Manager", SESSION)).ok, true, "none set: no current needed");
  const row = () => db.prepare("SELECT session, set_by, set_at FROM door_session").first();
  const before = await row();
  // the session the guard is against: refused at read_inbox, finds set_door_session, tries to set its own id
  assert.equal((await setDoorSession(db, T + 1, "Manager", OTHER)).refused.rule, "door-session-mismatch");
  assert.equal((await setDoorSession(db, T + 2, "Manager", OTHER, OTHER)).refused.rule, "door-session-mismatch", "its own id as current is no help");
  assert.deepEqual(await row(), before, "the row is unchanged");
  assert.equal((await guardedInbox(db, T + 3, OTHER)).refused.rule, "door-session-mismatch", "and it still cannot take the batch");
  assert.equal((await setDoorSession(db, T + 4, "Manager", OTHER, SESSION)).ok, true, "with the right current it changes");
  assert.equal((await row()).session, OTHER);
  assert.equal((await setDoorSession(db, T + 5, "owner", SESSION)).ok, true, "the owner needs no current");
  assert.equal((await row()).session, SESSION);
});

test("the refusal tells a session that is not Manager's to stop and tell Manager, and says when the id was last set (Checker F1a)", async () => {
  const db = makeDb(); await setDoorSession(db, T, "Manager", SESSION);
  const r = await guardedInbox(db, T + 2000, OTHER);
  assert.match(r.refused.detail, /stop and tell Manager; never call set_door_session/);
  assert.match(r.refused.detail, /last set by Manager at /);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(SESSION));
  assert.match((await guardedInbox(db, T + 3000, undefined)).refused.detail, /stop and tell Manager/);
});

test("replacing a different id that was already set is flagged: a log row, and Manager's next successful read says so once (Checker F1b)", async () => {
  const db = makeDb(); await withMessage(db);
  await setDoorSession(db, T, "Manager", SESSION); // the first id: not a replacement
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM inbox_takes WHERE reason LIKE 'door session replaced%'").first()).n, 0);
  await setDoorSession(db, T + 1, "owner", SESSION); // the same id again: not a replacement
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM inbox_takes WHERE reason LIKE 'door session replaced%'").first()).n, 0);
  await setDoorSession(db, T + 2, "owner", OTHER); // a different id: flagged
  const row = await db.prepare("SELECT at, claimed, reason FROM inbox_takes WHERE reason LIKE 'door session replaced%'").first();
  assert.deepEqual([row.at, row.claimed, row.reason], [T + 2, null, "door session replaced by owner"]);
  assert.equal((await guardedInbox(db, T + 3, SESSION)).refused.rule, "door-session-mismatch", "the old id no longer takes");
  const got = await guardedInbox(db, T + 4, OTHER);
  assert.equal(got.notices.length, 1); assert.match(got.notices[0], /^door session replaced by owner at /);
  assert.equal((await guardedInbox(db, T + 5, OTHER)).notices, undefined, "told once");
  await setDoorSession(db, T + 6, "Manager", SESSION, OTHER); // Manager's own change, with current: flagged too
  assert.match((await guardedInbox(db, T + 7, SESSION)).notices[0], /replaced by Manager/);
});

test("the tool texts say the same: not Manager's session means stop and tell Manager (Checker F1a)", async () => {
  const env = { DB: makeDb() };
  const r = await worker.fetch(new Request("https://b.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), env, null, T, async () => ({ who: "Manager", role: "manager-door" }));
  for (const t of (await r.json()).result.tools.filter((x) => x.name === "read_inbox" || x.name === "set_door_session")) assert.match(t.description, /stop and tell Manager/, t.name);
});

test("over the tool call: read_inbox needs `session`, set_door_session is on Manager's door and the owner's, not the shared door", async () => {
  const env = { DB: makeDb() }; await withMessage(env.DB);
  const set = await call(env, "Manager", "manager-door", "set_door_session", { session: SESSION });
  assert.equal(set.result.structuredContent.ok, true);
  const bad = await call(env, "Manager", "manager-door", "read_inbox", { session: OTHER });
  assert.equal(bad.result.structuredContent.refused.rule, "door-session-mismatch"); assert.equal(bad.result.isError, true);
  assert.equal(await unread(env.DB), 1);
  const good = await call(env, "Manager", "manager-door", "read_inbox", { session: SESSION });
  assert.equal(good.result.structuredContent.messages.length, 1);
  const change = await call(env, "Manager", "manager-door", "set_door_session", { session: OTHER });
  assert.equal(change.result.structuredContent.refused.rule, "door-session-mismatch", "changing it from Manager's door needs current");
  assert.equal((await call(env, "owner", "owner", "set_door_session", { session: OTHER })).result.structuredContent.ok, true, "the owner may set it");
  // an agent cannot: not on its role, and not on the shared door's list
  const agent = await call(env, "Checker", "agent", "set_door_session", { session: OTHER });
  assert.equal(agent.error.message, "unknown tool");
  assert.equal((await env.DB.prepare("SELECT session FROM door_session").first()).session, OTHER, "unchanged by the agent");
});

test("the tool list says read_inbox requires session; set_door_session is offered to Manager's door and not to the shared one", async () => {
  const env = { DB: makeDb() };
  const auth = async () => ({ who: "Manager", role: "manager-door" });
  const r = await worker.fetch(new Request("https://b.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), env, null, T, auth);
  const tools = (await r.json()).result.tools;
  const inbox = tools.find((t) => t.name === "read_inbox");
  assert.deepEqual(inbox.inputSchema.required, ["session"]); assert.match(inbox.description, /session/);
  assert.ok(tools.find((t) => t.name === "set_door_session"));
  const agent = await worker.fetch(new Request("https://b.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }), env, null, T, async () => ({ who: "Checker", role: "agent" }));
  assert.equal((await agent.json()).result.tools.some((t) => t.name === "set_door_session" || t.name === "read_inbox"), false);
});

test("takeInbox itself is unchanged: the guard wraps it, a direct call still marks taken", async () => {
  const db = makeDb(); await withMessage(db);
  assert.equal((await takeInbox(db, T + 2000)).messages.length, 1);
});
