import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";
import { STAMPED } from "../gate/rules.mjs";

// The page stamps every write to a collection edited in place and turns a delete into a tombstone (#C642); the agents are held to the
// same rule at the gate (gate/rules.mjs STAMPED), so the two lists are one.
function fakeDb() {
  const calls = [];
  const doc = (path) => ({ set: async (...a) => calls.push(["set", path, ...a]), update: async (...a) => calls.push(["update", path, ...a]), delete: async () => calls.push(["delete", path]), get: async () => "got", onSnapshot: () => "snap" });
  return { calls, collection: (n) => ({ name: n }), doc };
}

test("the page's list of stamped collections is the gate's", () => {
  const b = loadNames(["STAMPED", "isTombstone", "stampedDb"]);
  assert.deepEqual([...b.STAMPED], STAMPED);
});

test("stampedDb: set and update to those collections carry updatedAt; the rest are untouched; a delete is a tombstone", async () => {
  const b = loadNames(["STAMPED", "isTombstone", "stampedDb"]);
  const db = fakeDb(), s = b.stampedDb(db);
  const before = Date.now();
  await s.doc("waiting/w1").update({ response: "yes" });
  await s.doc("initiatives/c1").set({ name: "c" });
  await s.doc("ideas/i1").update({ done: true });
  await s.doc("waiting/w2").delete();
  await s.doc("steps/x").set({ at: 5 });
  await s.doc("messages/m").set({ at: 6, text: "hi" });
  await s.doc("ctx/Manager").update({ pct: 3 });
  const [u, st, id, del, steps, msg, ctx] = db.calls;
  assert.deepEqual(u.slice(0, 2), ["update", "waiting/w1"]);
  assert.equal(u[2].response, "yes");
  assert.ok(u[2].updatedAt >= before && u[2].updatedAt <= Date.now());
  assert.ok(st[2].updatedAt >= before && st[2].name === "c");
  assert.ok(id[2].updatedAt >= before && id[2].done === true);
  assert.deepEqual(del.slice(0, 2), ["update", "waiting/w2"], "a delete goes out as an update");
  assert.equal(del[2].deleted, true);
  assert.ok(del[2].updatedAt >= before);
  assert.deepEqual(steps, ["set", "steps/x", { at: 5 }], "steps keep their own at");
  assert.deepEqual(msg, ["set", "messages/m", { at: 6, text: "hi" }]);
  assert.deepEqual(ctx, ["update", "ctx/Manager", { pct: 3 }]);
  assert.deepEqual(s.collection("waiting"), { name: "waiting" }, "reads pass through");
  assert.equal(await s.doc("waiting/w1").get(), "got");
});

test("a tombstone is left out of what the page shows, in the collections that have them only", () => {
  const b = loadNames(["STAMPED", "isTombstone"]);
  assert.equal(b.isTombstone("waiting", { id: "a", deleted: true, updatedAt: 1 }), true);
  assert.equal(b.isTombstone("waiting", { id: "a", deleted: false }), false);
  assert.equal(b.isTombstone("waiting", { id: "a" }), false);
  assert.equal(b.isTombstone("steps", { id: "a", deleted: true }), false, "steps are not tombstoned");
  assert.equal(b.isTombstone("waiting", null), false);
});

test("the page's snapshot reader filters tombstones and every write goes through the stamped db", () => {
  const src = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(src, /dbRef=stampedDb\(db\)/, "writes go through the stamped db");
  assert.match(src, /\.map\(d=>\(\{id:d\.id,\.\.\.\(d\.data\(\)\|\|\{\}\)\}\)\)\.filter\(d=>!isTombstone\(name,d\)\)/, "the snapshot reader drops tombstones");
  assert.equal((src.match(/\bdb\.doc\(/g) ?? []).length, 1, "the one raw doc() is the stamped wrapper's own; every other write goes through dbRef");
});
