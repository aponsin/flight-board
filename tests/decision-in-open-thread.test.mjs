// #C920: a decision that follows the owner's question goes in his thread, not a new ask. Manager's Decision ask carries related_thread:
// a thread id (the decision is posted there as kind decision with its options, no ask item) or "none" (refused only when the decision
// names a card or an ask that an open owner thread from the last 2 hours also names). Other roles' asks are as before.
import test from "node:test";
import assert from "node:assert/strict";
import { createCard, askFromTool } from "../worker/board-store.mjs";
import worker, { TOOLS } from "../worker/board-worker.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";

const NOW = 1_800_000_000_000, MIN = 60_000, HOUR = 3_600_000;
const decision = (extra = {}) => ({ type: "Decision", title: "Which one?", asked_by: "Manager", question: "Go?", options: ["Yes", "No"], recommended: "Yes", ...extra });
const count = async (db, table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;

// A free thread of the owner's, titled, with one owner message at `at`.
async function ownerThread(db, id, { title = null, text, at = NOW - 10 * MIN, author = "owner", num = 900 } = {}) {
  await db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES (?, ?, ?, ?)").bind(id, num, title, at).run();
  await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)").bind(`m-${id}`, id, author, text, at).run();
}
async function withCard() {
  const db = makeDb();
  const r = await createCard(db, NOW, "Manager", { id: "card-a", title: "A card" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const num = (await db.prepare("SELECT num FROM cards WHERE id = 'card-a'").first()).num;
  return { db, ref: `#C${num}` };
}

test("related_thread set: the decision lands in that thread as kind decision with its options, and no ask item is made", async () => {
  const { db, ref } = await withCard();
  await ownerThread(db, "t-100", { title: "Pack order", text: `what about ${ref}?` });
  const r = await askFromTool(db, NOW, "Manager", decision({ title: `${ref}: which first?`, related_thread: "t-100" }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.posted_in_thread, true);
  assert.equal(await count(db, "asks"), 0, "no new ask item");
  const m = await db.prepare("SELECT * FROM messages WHERE thread_id = 't-100' AND author = 'Manager'").first();
  assert.equal(m.kind, "decision");
  assert.deepEqual(JSON.parse(m.options), [{ key: "A", label: "Yes" }, { key: "B", label: "No" }]);
  assert.match(m.body, /Go\?/);
  assert.match(m.body, /Recommended: A/);
  // an unknown thread is refused and posts nothing
  const bad = await askFromTool(db, NOW, "Manager", decision({ related_thread: "t-nope" }));
  assert.equal(bad.refused.rule, "decision-thread-unknown");
  assert.equal(await count(db, "messages"), 2);
});

test("a Decision from Manager without related_thread is refused, the message saying to pass a thread id or none", async () => {
  const db = makeDb();
  const r = await askFromTool(db, NOW, "Manager", decision());
  assert.equal(r.refused.rule, "decision-thread-missing");
  assert.match(r.refused.detail, /related_thread/);
  assert.match(r.refused.detail, /"none"/);
  assert.equal(await count(db, "asks"), 0);
  assert.equal((await askFromTool(db, NOW, "Manager", decision({ related_thread: "" }))).refused.rule, "decision-thread-missing");
});

test("none plus a card an open owner thread (last 2 hours) also names is refused, naming that thread", async () => {
  const { db, ref } = await withCard();
  await ownerThread(db, "t-100", { title: "Pack order", text: `can ${ref} wait?` });
  const r = await askFromTool(db, NOW, "Manager", decision({ title: `${ref}: ship it now?`, related_thread: "none" }));
  assert.equal(r.ok, false);
  assert.equal(r.refused.rule, "decision-belongs-in-thread");
  assert.match(r.refused.detail, /t-100/);
  assert.match(r.refused.detail, /Pack order/);
  assert.equal(await count(db, "asks"), 0);
  // the same through the card_id part, and an ask number in the thread's title
  const viaId = await askFromTool(db, NOW, "Manager", decision({ card_id: "card-a", related_thread: "none" }));
  assert.equal(viaId.refused.rule, "decision-belongs-in-thread");
  const db2 = makeDb();
  await ownerThread(db2, "t-200", { title: "About #T1500", text: "hm" });
  assert.equal((await askFromTool(db2, NOW, "Manager", decision({ question: "Does #T1500 stand?", related_thread: "none" }))).refused.rule, "decision-belongs-in-thread");
});

test("none plus an unrelated card is accepted and creates the ask", async () => {
  const { db, ref } = await withCard();
  await ownerThread(db, "t-100", { title: "Pack order", text: "what about #C77777 and #T88888?" });
  const r = await askFromTool(db, NOW, "Manager", decision({ title: `${ref}: ship it now?`, related_thread: "none" }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await count(db, "asks"), 1);
  assert.equal((await db.prepare("SELECT body FROM asks").first()).body.includes("related_thread"), false, "the argument is not stored");
  // no card or ask named at all: nothing to overlap
  const plain = await askFromTool(db, NOW, "Manager", decision({ title: "Which colour?", related_thread: "none" }));
  assert.equal(plain.ok, true);
});

test("a thread older than 2 hours, one that is not the owner's, a closed one and a resolved one do not block", async () => {
  const { db, ref } = await withCard();
  const d = () => decision({ title: `${ref}: ship it now?`, related_thread: "none" });
  await ownerThread(db, "t-old", { text: `about ${ref}`, at: NOW - 2 * HOUR - MIN, num: 901 });
  assert.equal((await askFromTool(db, NOW, "Manager", d())).ok, true, "owner's thread, last word older than 2 hours");
  await ownerThread(db, "t-mgr", { text: `about ${ref}`, author: "Manager", num: 902 });
  assert.equal((await askFromTool(db, NOW, "Manager", d())).ok, true, "a thread the owner never wrote in");
  await ownerThread(db, "t-done", { text: `about ${ref}`, num: 903 });
  await db.prepare("UPDATE messages SET resolved = 1 WHERE thread_id = 't-done'").run();
  assert.equal((await askFromTool(db, NOW, "Manager", d())).ok, true, "resolved thread");
  assert.equal(await count(db, "asks"), 3);
  // inside the window it blocks (59 minutes old)
  await ownerThread(db, "t-new", { text: `about ${ref}`, at: NOW - 59 * MIN, num: 904 });
  assert.equal((await askFromTool(db, NOW, "Manager", d())).refused.rule, "decision-belongs-in-thread");
  // a closed ask's thread does not block
  const db2 = makeDb();
  const asked = await askFromTool(db2, NOW, "Manager", { type: "Later", title: "About #C5001", asked_by: "Manager", text: "x", eta_at: NOW + HOUR });
  await db2.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES ('m-1', ?, 'owner', 'on #C5001', ?)").bind(asked.id, NOW - MIN).run();
  assert.equal((await askFromTool(db2, NOW, "Manager", decision({ title: "#C5001?", related_thread: "none" }))).refused.rule, "decision-belongs-in-thread");
  await db2.prepare("UPDATE asks SET closed_at = ? WHERE id = ?").bind(NOW, asked.id).run();
  assert.equal((await askFromTool(db2, NOW, "Manager", decision({ title: "#C5001?", related_thread: "none" }))).ok, true);
});

test("only Manager's Decision is gated: another role's Decision, and Manager's other types, are as before", async () => {
  const db = makeDb();
  assert.equal((await askFromTool(db, NOW, "Builder", decision({ asked_by: "Builder" }))).ok, true);
  assert.equal((await askFromTool(db, NOW, "Manager", { type: "Later", title: "L", asked_by: "Manager", text: "x", eta_at: NOW + HOUR })).ok, true);
  assert.equal((await askFromTool(db, NOW, "Builder", decision({ asked_by: "Builder", related_thread: "none" }))).refused.rule, "unknown-field", "no related_thread for other roles");
});

test("the thread path keeps every guard of the ask path: screenshots refused, a recommended outside the options refused, no eta_at, the right key, the card carried", async () => {
  const db = makeDb();
  await ownerThread(db, "t-100", { title: "Pack order", text: "what next?" });
  const posted = async () => count(db, "messages");
  const before = await posted();
  // screenshots would be dropped silently by a message: refused, nothing posted (Checker F1)
  const shots = await askFromTool(db, NOW, "Manager", decision({ related_thread: "t-100", screenshots: ["/images/a.png"] }));
  assert.equal(shots.refused.rule, "decision-screenshots-in-thread");
  assert.match(shots.refused.detail, /related_thread "none"/);
  // an empty list carries nothing, so it is fine
  assert.equal((await askFromTool(db, NOW, "Manager", decision({ related_thread: "t-100", screenshots: [] }))).ok, true);
  assert.equal(await posted(), before + 1);
  // askRefusal runs before the post: a recommended that is not among the options is refused, never a thrown error
  const bad = await askFromTool(db, NOW, "Manager", decision({ related_thread: "t-100", recommended: "Maybe" }));
  assert.ok(bad.refused, JSON.stringify(bad));
  assert.notEqual(bad.refused.rule, "decision-thread-unknown");
  assert.equal(await posted(), before + 1, "nothing posted for it");
  // eta_at has no meaning in a message
  assert.equal((await askFromTool(db, NOW, "Manager", decision({ related_thread: "t-100", eta_at: NOW + HOUR }))).refused.rule, "decision-not-before");
  assert.equal(await posted(), before + 1);
  // the recommended key is the letter of the recommended option, and the card id is carried in the body
  const second = await askFromTool(db, NOW, "Manager", decision({ related_thread: "t-100", recommended: "No", card_id: "card-a" }));
  assert.equal(second.ok, true, JSON.stringify(second));
  const m = await db.prepare("SELECT body FROM messages WHERE thread_id = 't-100' AND author = 'Manager' ORDER BY created_at DESC, id DESC").all();
  assert.ok(m.results.some((r) => /Recommended: B/.test(r.body) && /Card: card-a/.test(r.body)), "key B and the card id are in the body");
});

test("through the tool: the ask tool's schema and description name related_thread, and a Manager Decision without it is refused", async () => {
  const ask = TOOLS.find((t) => t.name === "ask");
  assert.ok(ask.inputSchema.properties.related_thread);
  assert.match(ask.description, /related_thread/);
  assert.match(ask.description, /2 hours/);
  const db = makeDb();
  const env = { DB: db };
  const call = async (args) => (await (await worker.fetch(new Request("https://board.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask", arguments: args } }) }), env, null, NOW, async () => ({ who: "Manager", role: "agent" }))).json()).result.structuredContent;
  assert.equal((await call({ type: "Decision", title: "T", asked_by: "Manager", question: "Q?", options: ["a", "b"], recommended: "a" })).refused.rule, "decision-thread-missing");
  assert.equal((await call({ type: "Decision", title: "T", asked_by: "Manager", question: "Q?", options: ["a", "b"], recommended: "a", related_thread: "none" })).ok, true);
});
