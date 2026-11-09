// The window.claude shim (#C723): run the shim's own text in a vm against a fake /api/compat, and check what the old page's data
// block sees (snapshots in the old doc shape, the probe event, refused writes rejecting, polling paused while hidden).
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { COMPAT_SHIM } from "../worker/compat-shim.mjs";

function world() {
  const calls = [], timers = [];
  let compat = { tag: "1", at: 1, collections: { waiting: [{ id: "t1", kind: "action", text: "Run it", since: 5 }], todo: [] }, probe: { v: 1, board: { boardId: "b", at: 1 }, cards: {}, agents: {} } };
  let writeAnswer = { status: 200, body: { ok: true } }, down = false;
  const headers = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (down) throw new Error("offline");
    if (url === "/api/compat") {
      if (init.headers?.["if-none-match"] === `"c-${compat.tag}"`) return { status: 304, ok: false, headers: headers({}) };
      return { status: 200, ok: true, headers: headers({ etag: `"c-${compat.tag}"` }), json: async () => compat };
    }
    return { status: writeAnswer.status, ok: writeAnswer.status < 300, json: async () => writeAnswer.body };
  };
  const document = { hidden: false, addEventListener(t, f) { (document.l ??= {})[t] = f; } };
  const window = {};
  vm.runInNewContext(COMPAT_SHIM, { window, fetch, document, setInterval: (f) => (timers.push(f), timers.length), JSON, Promise, Object, String, Error });
  return { window, calls, timers, document, set: (c) => (compat = { ...compat, ...c }), answer: (a) => (writeAnswer = a), down: (v) => (down = v) };
}
const tick = () => new Promise((r) => setImmediate(r));

test("the db snapshot is the old shape: docs with id and data()", async () => {
  const w = world(); const db = await w.window.claude.use("db"); let snap;
  db.collection("waiting").onSnapshot((s) => (snap = s));
  await tick();
  assert.deepEqual(snap.docs.map((d) => ({ id: d.id, ...d.data() })), [{ id: "t1", kind: "action", text: "Run it", since: 5 }]);
  let empty; db.collection("messages").onSnapshot((s) => (empty = s)); await tick();
  assert.equal(empty.docs.length, 0);
});

test("a poll with nothing new sends If-None-Match and tells nobody; a change tells only that collection", async () => {
  const w = world(); const db = await w.window.claude.use("db"); let waiting = 0, todo = 0;
  db.collection("waiting").onSnapshot(() => waiting++); db.collection("todo").onSnapshot(() => todo++);
  await tick(); assert.deepEqual([waiting, todo], [1, 1]);
  await w.timers[0](); await tick();
  assert.equal(w.calls.at(-1).init.headers["if-none-match"], '"c-1"'); assert.deepEqual([waiting, todo], [1, 1]);
  w.set({ tag: "2", collections: { waiting: [{ id: "t1", kind: "action", text: "Run it", since: 5 }], todo: [{ id: "a", text: "x" }] } });
  await w.timers[0](); await tick(); assert.deepEqual([waiting, todo], [1, 2]);
});

test("nothing is polled while the tab is hidden", async () => {
  const w = world(); (await w.window.claude.use("db")).collection("waiting").onSnapshot(() => {}); await tick();
  const n = w.calls.length; w.document.hidden = true; await w.timers[0](); assert.equal(w.calls.length, n);
});

test("the probe reaches watchTool as the old state tool's event", async () => {
  const w = world(); const mcp = await w.window.claude.use("mcp"); const evs = [];
  mcp.watchTool("Flight Board State", "board_state", null, (e) => evs.push(e), { refetchInterval: 1 });
  await tick(); assert.equal(evs.length, 1); assert.equal(evs[0].type, "data"); assert.equal(evs[0].result.payload.v, 1);
});

test("a refused write rejects with the rule and detail; an accepted one is sent as JSON and re-reads at once", async () => {
  const w = world(); const db = await w.window.claude.use("db"); db.collection("waiting").onSnapshot(() => {}); await tick();
  w.answer({ status: 422, body: { ok: false, refused: { rule: "no-route-yet", detail: "messages/m1: nope" } } });
  await assert.rejects(db.doc("messages/m1").set({ text: "hi" }), /no-route-yet: messages\/m1: nope/);
  w.answer({ status: 200, body: { ok: true } });
  const before = w.calls.length;
  await db.doc("waiting/t1").update({ done: true });
  const post = w.calls.find((c) => c.url === "/api/compat/write" && JSON.parse(c.init.body).op === "update");
  assert.deepEqual(JSON.parse(post.init.body), { op: "update", path: "waiting/t1", data: { done: true } });
  assert.equal(post.init.headers["content-type"], "application/json");
  assert.ok(w.calls.length > before + 1, "a read followed the write");
});

test("a failing poll tells the error handler once per streak, and the other handles are absent", async () => {
  const w = world(); const db = await w.window.claude.use("db"); let errs = 0;
  db.collection("waiting").onSnapshot(() => {}, () => errs++); await tick();
  w.down(true); await w.timers[0](); await w.timers[0](); await tick(); assert.equal(errs, 1);
  assert.equal(await w.window.claude.use("assets"), null); assert.equal(await w.window.claude.use("comments"), null);
});

test("unsubscribing stops delivery", async () => {
  const w = world(); const db = await w.window.claude.use("db"); let n = 0;
  const off = db.collection("waiting").onSnapshot(() => n++); await tick(); off();
  w.set({ tag: "9", collections: { waiting: [] } }); await w.timers[0](); await tick(); assert.equal(n, 1);
});
