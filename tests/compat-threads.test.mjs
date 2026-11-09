// Threads and messages for the old page (#C725 B1): read path, reply / ack / close / new thread / rename / reopen, files on a message.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { applyThreads } from "../worker/compat-threads.mjs";
import { takeInbox, readView } from "../worker/board-store.mjs";
import { approvalFor } from "../worker/compat-approvals.mjs";

const NOW = 1_800_000_000_000;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const fakeR2 = () => { const m = new Map(); return { m, put: async (k, v) => { m.set(k, new Uint8Array(v)); }, get: async (k) => (m.has(k) ? { body: m.get(k) } : null), delete: async (k) => { m.delete(k); } }; };
const WHO = { manager: { who: "Manager", role: "agent" }, reviewer: { who: "Reviewer", role: "agent" }, owner: { who: "owner", role: "owner" } };
const make = () => {
  const env = { DB: makeDb(), FILES: fakeR2() };
  const call = (as, path, init = {}) => worker.fetch(new Request(`https://board.test${path}`, init.method === "POST" ? { ...init, headers: { "content-type": "application/json", "x-as": as, ...init.headers } } : { ...init, headers: { "x-as": as, ...init.headers } }), env, null, NOW, async (req) => WHO[req.headers.get("x-as")] ?? null);
  const tool = async (as, name, args) => (await (await call(as, "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.structuredContent;
  const write = async (w) => { const r = await call("owner", "/api/compat/write", { method: "POST", body: JSON.stringify(w) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const compat = async () => (await (await call("owner", "/api/compat")).json()).collections;
  const upload = async (name, type, bytes) => (await call("owner", "/api/files", { method: "POST", body: JSON.stringify({ name, type, data: Buffer.from(bytes).toString("base64") }) })).json();
  const count = async (sql) => (await env.DB.prepare(sql).first()).n;
  return { env, tool, write, compat, upload, count };
};
const answer = { type: "Answer", title: "Is it live?", question: "Is it live?" };
const msg = (id, thread, extra = {}) => ({ op: "set", path: `messages/${id}`, data: { thread, from: "owner", text: "hello", at: 1, ...extra } });

test("an agent's message and the owner's reply come back as the old messages, in order, with the ask's #T number as the thread's", async () => {
  const { tool, write, compat } = make();
  const { id } = await tool("manager", "ask", answer);
  await tool("manager", "post", { thread_id: id, body: "Please look at this." });
  assert.equal((await write(msg("m1-abc", id, { text: "Looks fine" }))).status, 200);
  const c = await compat();
  assert.deepEqual(c.messages.map((m) => [m.thread, m.from, m.text]), [[id, "Manager", "Please look at this."], [id, "owner", "Looks fine"]]);
  const t = c.threads.find((x) => x.id === id);
  assert.ok(Number.isInteger(t.num) && t.num > 0, "the ask's #T number");
});

test("Ack and Close are messages that resolve; a kind is kept; the options an agent's message offers are not invented", async () => {
  const { tool, write, compat } = make();
  const { id } = await tool("manager", "ask", answer);
  assert.equal((await write(msg("m1-ack", id, { text: "Ack.", resolved: true, kind: "ack" }))).status, 200);
  assert.equal((await write(msg("m2-q", id, { text: "why?", kind: "question" }))).status, 200);
  const [a, q] = (await compat()).messages;
  assert.equal(a.resolved, true); assert.equal(a.kind, "ack");
  assert.equal(q.resolved, undefined); assert.equal(q.kind, "question"); assert.equal(q.options, undefined);
});

test("an unknown thread id is a NEW thread of the owner's: it gets a #T number once, its second message does not", async () => {
  const { write, compat, count } = make();
  assert.equal((await write(msg("m1-a", "new-thread-1", { text: "First" }))).status, 200);
  assert.equal((await write(msg("m2-b", "new-thread-1", { text: "Second" }))).status, 200);
  assert.equal(await count("SELECT COUNT(*) AS n FROM threads"), 1);
  const c = await compat();
  assert.equal(c.messages.length, 2);
  const t = c.threads.find((x) => x.id === "new-thread-1");
  assert.ok(t.num > 0);
  assert.equal((await write(msg("m3-c", "new-thread-2"))).status, 200);
  assert.equal((await compat()).threads.find((x) => x.id === "new-thread-2").num, t.num + 1, "the next free #T");
});

test("a rename sets the title only, on an ask, a card or a free thread; an unknown thread and any other field are refused", async () => {
  const { tool, write, compat, count } = make();
  const { id } = await tool("manager", "ask", answer);
  assert.equal((await write({ op: "set", path: `threads/${id}`, data: { title: "  Hero   copy " } })).status, 200);
  assert.equal((await write({ op: "update", path: `threads/${id}`, data: { title: "Hero copy v2" } })).status, 200);
  assert.equal((await compat()).threads.find((x) => x.id === id).title, "Hero copy v2");
  assert.equal(await count("SELECT COUNT(*) AS n FROM threads WHERE num IS NULL"), 1, "a rename of an ask takes no number of its own");
  assert.equal((await write({ op: "update", path: "threads/nope", data: { title: "x" } })).body.refused.rule, "thread-unknown");
  assert.equal((await write({ op: "update", path: `threads/${id}`, data: { title: "x", num: 5 } })).body.refused.rule, "no-route-yet");
  assert.equal((await write({ op: "update", path: `threads/${id}`, data: { title: "   " } })).body.refused.rule, "thread-title");
  assert.equal((await write({ op: "delete", path: `threads/${id}` })).body.refused.rule, "no-route-yet");
});

test("a message is refused by name when it is not the owner's, too long, oddly kinded, has other fields, repeats an id or is deleted", async () => {
  const { tool, write, count } = make();
  const { id } = await tool("manager", "ask", answer);
  const rule = async (w) => (await write(w)).body?.refused?.rule;
  assert.equal(await rule(msg("m1-a", id, { from: "Manager" })), "message-author");
  assert.equal(await rule(msg("m1-a", id, { text: "" })), "message-shape");
  assert.equal(await rule(msg("m1-a", id, { text: "x".repeat(8001) })), "message-shape");
  assert.equal(await rule(msg("m1-a", id, { kind: "Bad Kind" })), "message-shape");
  assert.equal(await rule(msg("m1-a", id, { sneaky: 1 })), "message-shape");
  assert.equal(await rule(msg("x1-a", id)), "message-shape", "the id starts with m");
  assert.equal((await write(msg("m1-a", id))).status, 200);
  assert.equal(await rule(msg("m1-a", id)), "message-exists");
  assert.equal(await rule({ op: "delete", path: "messages/m1-a" }), "no-route-yet");
  assert.equal(await count("SELECT COUNT(*) AS n FROM messages"), 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM threads"), 0, "no thread row for a known ask");
});

test("files on a message are linked and shown; a refused file list stores no message and no new thread", async () => {
  const { write, compat, upload, count } = make();
  const img = await upload("hero.png", "image/png", PNG);
  assert.equal((await write(msg("m1-f", "photo-thread", { assets: [{ id: img.id }] }))).status, 200);
  const c = await compat();
  assert.equal(c.messages[0].assets.length, 1); assert.equal(c.messages[0].assets[0].id, img.id); assert.equal(c.messages[0].assets[0].type, "image/png");
  const bad = await write(msg("m2-f", "other-thread", { assets: [{ id: "zzzzzzzzzzzzzzzzzzzz" }] }));
  assert.equal(bad.status, 422); assert.equal(bad.body.refused.rule, "file-unknown");
  assert.equal(await count("SELECT COUNT(*) AS n FROM messages"), 1, "no message");
  assert.equal(await count("SELECT COUNT(*) AS n FROM threads"), 1, "no new thread for the refused one");
  assert.equal(await count("SELECT COUNT(*) AS n FROM file_links WHERE ref_kind = 'message'"), 1);
});

test("a reply on a closed ask reopens it; an open ask is left alone; an unknown ask is refused", async () => {
  const { tool, write, compat } = make();
  const { id } = await tool("manager", "ask", answer);
  assert.equal((await write({ op: "update", path: `waiting/${id}`, data: { response: { status: "ack", note: "", at: 1 }, done: true } })).status, 200);
  assert.equal((await compat()).waiting[0].done, true);
  assert.equal((await write({ op: "update", path: `waiting/${id}`, data: { done: false, reopenedAt: 5 } })).status, 200);
  assert.equal((await compat()).waiting[0].done, undefined);
  assert.equal((await write({ op: "update", path: `waiting/${id}`, data: { done: false, reopenedAt: 6 } })).status, 200, "reopening an open ask changes nothing");
  assert.equal((await write({ op: "update", path: "waiting/nope", data: { done: false } })).body.refused.rule, "ask-unknown");
});

test("a closed Approval is never reopened by a reply: Release's check stays 'closed' for the old head (Checker's finding)", async () => {
  const { env, tool, write } = make();
  const H1 = "a".repeat(40), H2 = "b".repeat(40), url = "https://github.com/example/sites/pull/12";
  const a1 = await tool("reviewer", "ask", { type: "Approval", title: "Add Pro Shop", pr: 12, head: H1, url });
  assert.equal((await write({ op: "set", path: "approvals/pr12", data: { number: 12, head: H1, at: 1, by: "Owner" } })).status, 200);
  await tool("reviewer", "ask", { type: "Approval", title: "Add Pro Shop", pr: 12, head: H2, url });
  await tool("reviewer", "ask_close", { id: a1.id });
  assert.match(approvalFor((await readView(env.DB, NOW)).asks, 12, H1).why, /closed/);
  const r = await write({ op: "update", path: `waiting/${a1.id}`, data: { done: false, reopenedAt: 5 } });
  assert.equal(r.status, 422); assert.equal(r.body.refused.rule, "approval-reopen");
  assert.match(approvalFor((await readView(env.DB, NOW)).asks, 12, H1).why, /closed/, "still closed, not approved");
});

test("a thread id that is not 1 to 64 of letters, digits and hyphens is refused, and a done:false with other fields reopens nothing and still answers (Security)", async () => {
  const { tool, write, count, compat } = make();
  for (const thread of ["../x", "a b", "x".repeat(65), "a/b"]) assert.equal((await write(msg("m1-a", thread))).body?.refused?.rule, "message-shape", thread);
  assert.equal(await count("SELECT COUNT(*) AS n FROM messages"), 0); assert.equal(await count("SELECT COUNT(*) AS n FROM threads"), 0);
  const { id } = await tool("manager", "ask", answer);
  const r = await write({ op: "update", path: `waiting/${id}`, data: { done: false, response: { status: "ack", note: "", at: 1 } } });
  assert.equal(r.status, 200);
  assert.equal((await compat()).waiting[0].response.status, "ack", "the answer was stored, not swallowed by a reopen");
});

test("the owner's message is what the wake counts for Manager, and a thread of the owner's reaches the inbox", async () => {
  const { env, write } = make();
  await write(msg("m1-a", "new-thread-9", { text: "Please look at the hero" }));
  const inbox = await takeInbox(env.DB, NOW);
  assert.equal(inbox.messages.length, 1); assert.equal(inbox.messages[0].thread_id, "new-thread-9"); assert.equal(inbox.messages[0].author, "owner");
});

test("applyThreads is left alone without the view's threads", () => {
  const c = { initiatives: [] };
  assert.equal(applyThreads(c, {}), c); assert.equal(c.messages, undefined);
});
