// #C1317: a Terminal or Action ask from Manager may carry related_thread (the owner's thread id, or "none"), as a Decision does: the ask
// is still one ask, answered as before, and the page draws it in that thread, so the owner's thread turns into the click and no second
// thread opens. Other roles keep the old refusal (unknown-field).
import test from "node:test";
import assert from "node:assert/strict";
import { askFromTool } from "../worker/board-store.mjs";
import { waitingDoc } from "../worker/compat-view.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { loadNames } from "./harness.mjs";

const NOW = 1_800_000_000_000;
const terminal = (extra = {}) => ({ type: "Terminal", title: "Clean up the old folders", asked_by: "Manager", commands: ["ls ~/Documents/Code"], ...extra });
const action = (extra = {}) => ({ type: "Action", title: "Open the page", asked_by: "Manager", steps: ["Open the board"], expect: "The board opens", ...extra });
const count = async (db, table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
async function ownerThread(db, id = "t-100") {
  await db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES (?, ?, ?, ?)").bind(id, 900, "we need some clean up", NOW - 1000).run();
  await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)").bind(`m-${id}`, id, "owner", "we need some clean up", NOW - 1000).run();
}

test("a Terminal ask with related_thread is one ask that names the owner's thread, and the page doc carries it", async () => {
  const db = makeDb();
  await ownerThread(db);
  const r = await askFromTool(db, NOW, "Manager", terminal({ related_thread: "t-100" }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.thread_id, "t-100");
  assert.equal(await count(db, "asks"), 1);
  const row = await db.prepare("SELECT * FROM asks WHERE id = ?").bind(r.id).first();
  assert.equal(JSON.parse(row.body).related_thread, "t-100");
  assert.deepEqual(JSON.parse(row.body).commands, ["ls ~/Documents/Code"]);
  assert.equal(waitingDoc(row).thread, "t-100");
  assert.equal(waitingDoc(row).kind, "action");
});

test("an Action ask takes it the same way", async () => {
  const db = makeDb();
  await ownerThread(db);
  const r = await askFromTool(db, NOW, "Manager", action({ related_thread: "t-100" }));
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = await db.prepare("SELECT * FROM asks WHERE id = ?").bind(r.id).first();
  assert.equal(waitingDoc(row).thread, "t-100");
});

test("none, and no related_thread at all, make the ask as before with no thread", async () => {
  const db = makeDb();
  for (const extra of [{ related_thread: "none" }, {}]) {
    const r = await askFromTool(db, NOW, "Manager", terminal(extra));
    assert.equal(r.ok, true, JSON.stringify(r));
    const row = await db.prepare("SELECT * FROM asks WHERE id = ?").bind(r.id).first();
    assert.equal("related_thread" in JSON.parse(row.body), false);
    assert.equal(waitingDoc(row).thread, undefined);
  }
});

test("an unknown thread or an empty value is refused and makes no ask", async () => {
  const db = makeDb();
  assert.equal((await askFromTool(db, NOW, "Manager", terminal({ related_thread: "t-nope" }))).refused.rule, "click-thread-unknown");
  assert.equal((await askFromTool(db, NOW, "Manager", terminal({ related_thread: "" }))).refused.rule, "click-thread-shape");
  assert.equal((await askFromTool(db, NOW, "Manager", action({ related_thread: 5 }))).refused.rule, "click-thread-shape");
  assert.equal(await count(db, "asks"), 0);
});

test("another role's click ask with related_thread is refused as before", async () => {
  const db = makeDb();
  await ownerThread(db);
  const r = await askFromTool(db, NOW, "Builder", terminal({ asked_by: "Builder", related_thread: "t-100" }));
  assert.equal(r.ok, false);
  assert.equal(await count(db, "asks"), 0);
});

// The page: the click is drawn inside the owner's thread, the thread waits on him until Done, and the ask has no row of its own.
const NOWP = Date.now();
const owned = (extra = {}) => {
  const b = loadNames(["youItems", "waitsOn", "threadHtml", "leadAsks", "inThread", "clickIn"]);
  b.state.messages = [{ id: "m-own", thread: "t-100", from: "Owner", text: "we need some clean up", at: NOWP - 600_000 }];
  b.state.threads = [{ id: "t-100", num: 900, title: "we need some clean up" }];
  b.state.waiting = [{ id: "t200", kind: "action", since: NOWP - 1000, text: "Clean up the old folders", from: "Manager", steps: [{ text: "Run this in Terminal:", cmd: "ls ~/Documents/Code" }], thread: "t-100", ...extra }];
  return b;
};

test("page: an open click that names the owner's thread sits in that thread, which waits on the owner, with no row of its own", () => {
  const b = owned();
  const y = b.youItems(NOWP, "");
  assert.deepEqual([...y.asks.map((w) => w.id)], [], "the ask has no row of its own");
  assert.deepEqual([...y.answered], ["t-100"], "the owner's thread is the item");
  assert.equal(b.waitsOn("t-100", NOWP), "you");
  assert.deepEqual([...b.leadAsks(NOWP, "").map((w) => w.id)], []);
  const html = b.threadHtml("t-100", "panel", { acts: true });
  assert.match(html, /ls ~\/Documents\/Code/);
  assert.match(html, /data-copy=/);
});

test("page: once he presses Done the thread stops waiting on him; a click with no thread is a row as before", () => {
  const done = owned({ response: { status: "done", at: NOWP, taken: false } });
  assert.notEqual(done.waitsOn("t-100", NOWP), "you");
  const plain = owned({ thread: undefined });
  assert.deepEqual([...plain.youItems(NOWP, "").asks.map((w) => w.id)], ["t200"]);
  assert.deepEqual([...plain.youItems(NOWP, "").answered], []);
});
