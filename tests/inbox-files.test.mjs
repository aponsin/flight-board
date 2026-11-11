// store-inbox-shows-files (#C837): read_inbox lists the files attached to each message and each answer it returns (id, name, type, size, and where to
// fetch them), so Manager knows a screenshot came with a note. Before, the owner's image reached Manager as text only, with no sign it existed.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { postMessage, answerAsk, createAsk, takeInbox, refuse } from "../worker/board-store.mjs";
import { putFile, linkFiles } from "../worker/file-store.mjs";

const T = 1_800_000_000_000;
const PNG = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])).toString("base64");
const fakeR2 = () => { const m = new Map(); return { put: async (k, v) => { m.set(k, v); }, get: async (k) => (m.has(k) ? { body: m.get(k) } : null), delete: async (k) => { m.delete(k); } }; };
const store = (db, bucket, name, type = "image/png", data = PNG) => putFile({ db, bucket, now: T, who: "owner", refuse }, { name, type, data });

test("a message with an image lists it in the inbox: id, name, type, size and the path to fetch it; a message with none lists an empty files", async () => {
  const db = makeDb(), bucket = fakeR2();
  const img = await store(db, bucket, "image.png");
  assert.equal(img.ok, true);
  const withImg = await postMessage(db, T + 1000, "owner", { thread_id: "c-one", body: "scroll bars are hard to see" });
  await linkFiles(db, T + 1000, "message", withImg.id, [img.id]);
  const plain = await postMessage(db, T + 2000, "owner", { thread_id: "c-one", body: "no picture here" });
  const got = await takeInbox(db, T + 3000);
  const a = got.messages.find((m) => m.id === withImg.id), b = got.messages.find((m) => m.id === plain.id);
  assert.deepEqual(a.files, [{ id: img.id, name: "image.png", type: "image/png", size: 11, fetch: `/_blob/${img.id}` }]);
  assert.deepEqual(b.files, []);
});

test("an answer with files lists them too, in the order they were attached", async () => {
  const db = makeDb(), bucket = fakeR2();
  const one = await store(db, bucket, "z.png"), two = await store(db, bucket, "a.txt", "text/plain", Buffer.from("hello").toString("base64"));
  const ask = await createAsk(db, T, { type: "Decision", title: "Pick", asked_by: "Manager", question: "A or B?", options: ["A", "B"], recommended: "A" });
  await answerAsk(db, T + 1000, "owner", { id: ask.id, answer: "B" });
  await linkFiles(db, T + 1000, "answer", ask.id, [one.id, two.id]);
  const got = await takeInbox(db, T + 2000);
  assert.deepEqual(got.answers[0].files.map((f) => [f.name, f.type, f.fetch]), [["z.png", "image/png", `/_blob/${one.id}`], ["a.txt", "text/plain", `/_blob/${two.id}`]]);
});

test("250 unread messages with files read without a statement binding more than 100 values (D1's limit)", async () => {
  const db = makeDb(), bucket = fakeR2();
  const img = await store(db, bucket, "x.png");
  for (let i = 0; i < 250; i++) { const m = await postMessage(db, T + i, "owner", { thread_id: "t1", body: `m${i}` }); await linkFiles(db, T + i, "message", m.id, [img.id]); }
  let most = 0;
  const counting = { prepare: (sql) => { const s = db.prepare(sql); return { bind: (...a) => { most = Math.max(most, a.length); return s.bind(...a); }, all: () => s.all(), first: () => s.first(), run: () => s.run() }; }, batch: (x) => db.batch(x) };
  const got = await takeInbox(counting, T + 1000);
  assert.equal(got.messages.length, 250);
  assert.ok(got.messages.every((m) => m.files.length === 1 && m.files[0].id === img.id));
  assert.ok(most <= 100, `a statement bound ${most} values`);
});

test("the tool says so: read_inbox's description names the files and how to fetch one", async () => {
  const env = { DB: makeDb(), FILES: fakeR2() };
  const auth = async () => ({ who: "Manager", role: "manager-door" });
  const r = await worker.fetch(new Request("https://b.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), env, null, T, auth);
  const tool = (await r.json()).result.tools.find((t) => t.name === "read_inbox");
  assert.ok(tool, "the Manager door lists read_inbox");
  assert.match(tool.description, /files/);
  assert.match(tool.description, /\/_blob\//);
});

test("the Manager door's read_inbox returns the files over the tool call", async () => {
  const env = { DB: makeDb(), FILES: fakeR2() };
  const img = await store(env.DB, env.FILES, "image.png");
  const m = await postMessage(env.DB, T + 1000, "owner", { thread_id: "c-one", body: "see the picture" });
  await linkFiles(env.DB, T + 1000, "message", m.id, [img.id]);
  const auth = async () => ({ who: "Manager", role: "manager-door" });
  const r = await worker.fetch(new Request("https://b.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_inbox", arguments: {} } }) }), env, null, T + 5000, auth);
  const out = (await r.json()).result.structuredContent;
  assert.equal(out.messages[0].files[0].id, img.id);
  assert.equal(out.messages[0].files[0].fetch, `/_blob/${img.id}`);
});
