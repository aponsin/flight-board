import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { plan, report, toSql, compare, threadResolved, withStore } from "../collector/import-mirror.mjs";

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

test("an item with no thread field uses the thread doc of its own id and keeps that #T", () => {
  const d = { ...docs, initiatives: {}, threads: { l: { num: 77, title: "t" } }, waiting: { l: { kind: "later", text: "wait", eta: Date.now() + 86_400_000 } } };
  const p = plan(d, { owner: "Owner", lead: "Manager" });
  assert.equal(p.asks[0].num, 77);
});

test("an ask with no thread gets the next number above the counters, and is in the SQL", () => {
  const d = { ...docs, initiatives: {}, waiting: { l: { kind: "later", text: "wait", eta: Date.now() + 86_400_000 } } };
  const p = plan(d, { owner: "Owner", lead: "Manager", liveT: 100 });
  assert.equal(p.asks[0].num, 100);
  assert.equal(p.counters.T, 101);
  assert.match(toSql(p), /INSERT OR IGNORE INTO asks/);
});

test("a Decision in the old board's real shape imports: options become labels, the flagged one is recommended, the answer key becomes its label (Checker)", () => {
  const dec = { kind: "decision", thread: "t-a", question: "Allow it?", options: [{ key: "A", label: "Yes, allow", recommended: true }, { key: "B", label: "No, keep asking" }], response: { at: 20, choice: "A", note: "", status: "chose" } };
  const open = { ...dec, response: undefined };
  const p = plan({ ...docs, initiatives: {}, waiting: { d1: dec, d2: { ...open, thread: "t-c" } } }, { owner: "Owner", lead: "Manager" });
  assert.deepEqual(p.refused, []);
  const a = p.asks.find((x) => x.id === "d1");
  assert.deepEqual(JSON.parse(a.body).options, ["Yes, allow", "No, keep asking"]);
  assert.equal(JSON.parse(a.body).recommended, "Yes, allow");
  assert.equal(a.answer, "Yes, allow");
  assert.equal(a.answer_taken_at, 20, "the first wake after the import does not resend old answers");
  assert.equal(a.answered_by, "owner");
});

test("a Decision with no flagged option is still refused, not given a recommendation", () => {
  const d = { kind: "decision", thread: "t-a", question: "q", options: [{ key: "A", label: "x" }, { key: "B", label: "y" }] };
  const p = plan({ ...docs, initiatives: {}, waiting: { d1: d } }, { owner: "Owner", lead: "Manager" });
  assert.match(p.refused[0].detail, /recommended/);
});

test("a card's free-text phaseReason is not a rework reason: only the five reasons carry over, anything else is left empty", () => {
  const d = { ...docs, initiatives: { a: { name: "A", num: 1, phaseReason: "Suite passed at 2bd53cf is the test step", status: "active" }, b: { name: "B", num: 2, phaseReason: "design change", status: "active" } }, waiting: {} };
  const p = plan(d, { owner: "Owner", lead: "Manager" });
  assert.deepEqual(p.refused, []);
  assert.deepEqual(p.cards.map((c) => c.rework_reason), [null, "design change"]);
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

test("a card's review-skip words carry over as they are (customerText, lookChange, skip); not said stays NULL; a skip naming no phase is refused", () => {
  const d = { ...docs, initiatives: {
    a: { name: "A", num: 1, status: "active", customerText: false, lookChange: true, skip: ["language"] },
    b: { name: "B", num: 2, status: "active" },
    c: { name: "C", num: 3, status: "active", skip: ["Lunch Break"] },
    e: { name: "E", num: 4, status: "active", skip: ["plan", "language", "look"] },
  }, waiting: {} };
  const p = plan(d, { owner: "Owner", lead: "Manager" });
  assert.deepEqual(p.cards.map((c) => [c.id, c.customer_text, c.look_change, c.skip]), [["a", 0, 1, '["language"]'], ["b", null, null, null], ["e", null, null, '["plan","language","look"]']]);
  assert.deepEqual(p.refused.map((r) => [r.id, r.rule]), [["c", "card-skip"]]);
});

test("closures: an ask the store holds that the old board has since closed is closed by the store's own rule; the dry run lists it and the open count then matches the old board", () => {
  const d = { initiatives: {}, messages: { m1: { thread: "t-res", from: "Manager", text: "x", at: 50, resolved: true } }, threads: { "t-res": { num: 7 } },
    waiting: { "w-done": { kind: "later", text: "a", done: true, doneAt: 900 }, "w-res": { kind: "later", text: "b", thread: "t-res" }, "w-open": { kind: "later", text: "c", eta: 4_000_000_000_000 },
      "w-dec": { kind: "decision", done: true }, "w-new": { kind: "later", text: "n", eta: 4_000_000_000_000 } } };
  const store = [{ id: "w-done", type: "Later" }, { id: "w-res", type: "Later" }, { id: "w-open", type: "Later" }, { id: "w-dec", type: "Decision", answered_at: null }, { id: "w-gone", type: "Later" }, { id: "w-shut", type: "Later", closed_at: 5 }];
  const p = withStore(plan(d, { owner: "Owner", lead: "Manager" }), d, store, 1234);
  assert.deepEqual(p.closures.close, [{ id: "w-done", at: 900 }, { id: "w-res", at: 50 }]);
  assert.deepEqual(p.closures.refused.map((r) => [r.id, r.rule]), [["w-dec", "close-unanswered"]]);
  assert.deepEqual(p.closures.unknown, [{ id: "w-gone", rule: "not-on-old-board" }]);
  assert.equal(p.openAsksAfter, 4, "w-open, w-dec and w-gone stay open in the store, w-new is added");
  assert.equal(report(p).openAsksMatchOldBoard, false, "the refused and unknown ones keep the counts apart until the lead settles them");
  const sql = toSql(p).split("\n");
  assert.ok(sql.includes("UPDATE asks SET closed_at = 900, closed_by = 'import' WHERE id = 'w-done' AND closed_at IS NULL;"));
  assert.ok(sql.includes("UPDATE asks SET closed_at = 50, closed_by = 'import' WHERE id = 'w-res' AND closed_at IS NULL;"));
  assert.equal(sql.some((l) => /DELETE/i.test(l)), false, "nothing is ever deleted");
});

test("To-do and Ideas import as they are: open items only, the old kind becomes the category, no trigger or ETA made up, a bad row is listed by old id, a second run changes nothing", () => {
  const d = { ...docs, initiatives: {}, waiting: {},
    todo: { crawlers: { text: "Glance at the crawlers list", area: "Search", rank: 6, addedAt: 11 }, "was-done": { text: "old", done: true }, "Bad Id": { text: "x" }, "no-text": { area: "x" } },
    ideas: { "send-look": { text: "Send this look", area: "Demos", kind: "build", note: "after the drop-down", rank: 1 }, "t1792434643422": { text: "An idea with no area" } } };
  const p = plan(d, { owner: "Owner", lead: "Manager" });
  assert.deepEqual(p.lists.map((l) => [l.id, l.kind, l.text, l.area, l.category, l.note, l.rank, l.done, l.added_at]), [
    ["crawlers", "todo", "Glance at the crawlers list", "Search", null, null, 6, 0, 11],
    ["send-look", "idea", "Send this look", "Demos", "build", "after the drop-down", 1, 0, 0],
    ["t1792434643422", "idea", "An idea with no area", null, null, null, null, 0, 0]]);
  assert.deepEqual(p.refused.map((r) => [r.kind, r.id, r.rule]), [["list", "Bad Id", "list-id"], ["list", "no-text", "list-text"]]);
  assert.deepEqual([p.counts.todo, p.counts.ideas, p.skipped.doneLists], [1, 2, 1]);
  assert.deepEqual(report(p, { todo: 1, ideas: 3 }).differences, ["Ideas: old page 3, import 2"]);
  const dir = new URL("../worker/migrations/", import.meta.url), db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const sql = toSql(p);
  db.exec(sql); db.exec(sql);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lists").get().n, 3);
  // The old board marks one done after the import: the next run marks it done here, once, and never reopens a row.
  const later = withStore(plan({ ...d, todo: { crawlers: { ...d.todo.crawlers, done: true, doneAt: 77 } } }, { owner: "Owner", lead: "Manager" }), { ...d, todo: { crawlers: { ...d.todo.crawlers, done: true, doneAt: 77 } } }, [], 1234, db.prepare("SELECT * FROM lists").all());
  assert.deepEqual(later.closures.lists, [{ id: "crawlers", at: 77 }]);
  db.exec(toSql(later));
  assert.deepEqual({ ...db.prepare("SELECT done, done_at FROM lists WHERE id = 'crawlers'").get() }, { done: 1, done_at: 77 });
});

test("the SQL fills the review-skip columns of a card that is already in the store, once, and a second run changes nothing", () => {
  const dir = new URL("../worker/migrations/", import.meta.url);
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  // The store as the first import left it: the card is there, without the three words.
  db.exec("INSERT INTO cards (id, num, title, summary, track, created_at, updated_at) VALUES ('a', 1, 'A', 's', 'product', 1, 1)");
  const sql = toSql(plan({ ...docs, initiatives: { a: { name: "A", num: 1, status: "active", customerText: false, lookChange: true, skip: ["language"] } }, waiting: {} }, { owner: "Owner", lead: "Manager" }));
  const row = () => db.prepare("SELECT title, customer_text, look_change, skip FROM cards WHERE id = 'a'").get();
  db.exec(sql);
  assert.deepEqual({ ...row() }, { title: "A", customer_text: 0, look_change: 1, skip: '["language"]' });
  db.exec(sql);
  assert.deepEqual({ ...row() }, { title: "A", customer_text: 0, look_change: 1, skip: '["language"]' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cards").get().n, 1);
});
