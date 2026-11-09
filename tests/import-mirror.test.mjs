import test from "node:test";
import assert from "node:assert/strict";
import { plan, report, toSql, compare, threadResolved } from "../collector/import-mirror.mjs";

const docs = {
  initiatives: {
    "open-card": { name: "Open", num: 5, status: "active", size: "L", level: "Full", thread: "c-thread", createdAt: 1 },
    "old-card": { name: "Old", num: 9, status: "done" },
    "Bad_ID": { name: "x", num: 7 },
  },
  threads: { "t-a": { num: 41, title: "Act" }, "t-b": { num: 42, title: "Closed" }, "t-c": { num: 43, title: "Later one" }, "c-thread": { num: 40, title: "card" } },
  messages: {
    m1: { thread: "t-a", from: "Manager", text: "do it", at: 10 }, m2: { thread: "t-a", from: "Owner", text: "done", at: 20 },
    m3: { thread: "t-b", from: "Manager", text: "x", at: 1 }, m4: { thread: "t-b", from: "Owner", text: "Ack.", at: 2, resolved: true },
    m5: { thread: "c-thread", from: "Owner", text: "hi", at: 3 }, m6: { thread: "t-gone", from: "Owner", text: "orphan", at: 3 },
  },
  waiting: {
    a1: { kind: "action", thread: "t-a", steps: [{ text: "s" }], expect: "e", since: 5, response: { at: 20, status: "done" } },
    a2: { kind: "action", thread: "t-b", steps: ["s"], expect: "e" },
    a3: { kind: "later", thread: "t-c", text: "wait" },
    a4: { kind: "action", done: true },
    a5: { kind: "decision", thread: "t-a", question: "q", options: ["x", "y"] },
  },
};

test("open cards map, bad ids are refused with the rule; done and resolved are skipped", () => {
  const p = plan(docs, { owner: "Owner", lead: "Manager" });
  assert.deepEqual(p.cards.map((c) => c.id), ["open-card"]);
  assert.equal(p.skipped.doneCards, 1);
  assert.equal(p.skipped.doneAsks, 1);
  assert.equal(p.skipped.resolvedAsks, 1);
  assert.ok(p.refused.some((r) => r.kind === "card" && r.id === "Bad_ID" && r.rule === "card-id"));
});

test("asked_by is the item's who when it names a roster agent (never the owner), else the lead, and the defaults are counted", () => {
  const d = { ...docs, waiting: { x: { ...docs.waiting.a1, who: "Builder" }, y: { ...docs.waiting.a1, who: "Owner" }, z: { ...docs.waiting.a1 } } };
  const p = plan(d, { owner: "Owner", roster: ["Builder", "Checker"], lead: "Manager" });
  assert.deepEqual(p.asks.map((a) => a.asked_by), ["Builder", "Manager", "Manager"]);
  assert.equal(p.defaulted, 2);
});

test("an answered but unclosed ask is imported with its answer and its #T", () => {
  const p = plan(docs, { owner: "Owner", lead: "Manager" });
  const a = p.asks.find((x) => x.id === "a1");
  assert.equal(a.num, 41);
  assert.equal(a.asked_by, "Manager");
  assert.equal(a.answered_at, 20);
  assert.equal(p.counts.lead, 1);
});

test("an item the store's rules refuse is listed with rule and old id, never patched", () => {
  const p = plan(docs, { owner: "Owner", lead: "Manager" });
  const later = p.refused.find((r) => r.id === "a3");
  assert.equal(later.rule, "later-without-eta"); // the ETA is never defaulted
  const dec = p.refused.find((r) => r.id === "a5");
  assert.match(dec.detail, /recommended|Decision/);
  assert.ok(!p.asks.some((x) => x.id === "a3" || x.id === "a5"));
});

test("a Later's ETA is the old item's eta field, in ms, as it is", () => {
  const eta = Date.now() + 86_400_000;
  const d = { ...docs, initiatives: {}, waiting: { l: { kind: "later", text: "wait", eta } } };
  const p = plan(d, { owner: "Owner", lead: "Manager" });
  assert.equal(p.asks[0].eta_at, eta);
  assert.equal(p.refused.length, 0);
});

test("an ask with no thread gets the next number above the counters, and is in the SQL", () => {
  const d = { ...docs, initiatives: {}, waiting: { l: { kind: "later", text: "wait", eta: Date.now() + 86_400_000 } } };
  const p = plan(d, { owner: "Owner", lead: "Manager", liveT: 100 });
  assert.equal(p.asks[0].num, 100);
  assert.equal(p.counters.T, 101);
  assert.match(toSql(p), /INSERT OR IGNORE INTO asks/);
});

test("no orphans: messages come only with an imported thread", () => {
  const p = plan(docs, { owner: "Owner", lead: "Manager" });
  assert.deepEqual(p.messages.map((m) => m.id).sort(), ["m1", "m2", "m5"]);
});

test("counters sit above every number on the old board and above the live board's", () => {
  assert.deepEqual(plan(docs, { owner: "Owner", lead: "Manager" }).counters, { C: 10, T: 44 });
  assert.deepEqual(plan(docs, { owner: "Owner", liveC: 800, liveT: 1648 }).counters, { C: 800, T: 1648 });
});

test("the SQL is keyed by old id (INSERT OR IGNORE) and the counters only go up", () => {
  const sql = toSql(plan(docs, { owner: "Owner", lead: "Manager" }));
  assert.ok(sql.split("\n").filter((l) => l.startsWith("INSERT")).every((l) => l.startsWith("INSERT OR IGNORE")));
  assert.match(sql, /SET next = MAX\(next, 10\)/);
});

test("the report names every difference from the old page's tab counts", () => {
  assert.deepEqual(compare({ needs: 1, later: 2, lead: 3 }, { needs: 1, later: 5 }), ["Later: old page 5, import 2"]);
  assert.deepEqual(report(plan(docs, { owner: "Owner", lead: "Manager" }), { lead: 2 }).differences, ["With the team: old page 2, import 1"]);
});

test("a thread is resolved by its last message, but an Ack on a card's thread is not", () => {
  assert.equal(threadResolved([{ at: 1, resolved: true }], false), true);
  assert.equal(threadResolved([{ at: 1, resolved: true, kind: "ack" }], true), false);
  assert.equal(threadResolved([], false), false);
});
