import test from "node:test";
import assert from "node:assert/strict";
import { plan, report, cardRow } from "../collector/import-mirror.mjs";

const docs = {
  initiatives: {
    "open-card": { name: "Open", num: 5, status: "active", size: "L", level: "Full", who: "Builder", createdAt: 1, phaseReason: "review findings" },
    "old-card": { name: "Old", num: 9, status: "done" },
    "dropped-card": { name: "Dropped", num: 6, status: "dropped", size: "XXL" },
    "Bad_ID": { name: "x", num: 7 },
    "dup-num": { name: "y", num: 5 },
    "no-title": { num: 8 },
  },
  messages: { m1: { thread: "t1", from: "a", text: "hi", at: 10 }, m2: { thread: "t1", from: "a" } },
  threads: { t1: { num: 41, title: "x" } },
  waiting: { w1: { kind: "decision" }, w2: { kind: "decision" }, w3: {} },
};

test("open and dropped cards map; done cards are counted, not imported; bad rows are refused with a reason", () => {
  const p = plan(docs);
  assert.deepEqual(p.cards.map((c) => c.id), ["open-card", "dropped-card"]);
  assert.equal(p.cards[0].rework_reason, "review findings");
  assert.equal(p.cards[1].dropped, 1);
  assert.equal(p.cards[1].size, null, "a size outside the schema is not carried");
  assert.deepEqual(p.refused.cards, { "card-id": 1, "duplicate-num": 1, "no-title": 1 });
  assert.equal(p.skipped.doneCards, 1);
});

test("counters continue after the highest number seen, done cards included", () => {
  const p = plan(docs);
  assert.equal(p.counters.C, 10);
  assert.equal(p.counters.T, 42);
});

test("messages arrive delivered; waiting is counted by kind and not mapped", () => {
  const p = plan(docs);
  assert.equal(p.messages.length, 1);
  assert.equal(p.messages[0].delivered_at, 10);
  assert.deepEqual(p.refused.messages, { "message-shape": 1 });
  assert.deepEqual(report(p).waitingByKind, { decision: 2, none: 1 });
});

test("a card row never fails the store's own check on id", () => {
  assert.equal(cardRow("a".repeat(65), { name: "x", num: 1 }).ok, false);
});
