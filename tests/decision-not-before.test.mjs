// #C823: a Decision may carry eta_at as a "not before": under Later until that time, under Needs you from it. The rule, the store, the old
// page's doc, the page's two tabs (future and past), and the import that keeps the old ETA (#T166 goes back to Later).
import test from "node:test";
import assert from "node:assert/strict";
import { askRefusal } from "../worker/board-rules.mjs";
import { createAsk } from "../worker/board-store.mjs";
import { waitingDoc } from "../worker/compat-view.mjs";
import { askRow } from "../collector/import-mirror.mjs";
import { askFixSql } from "../collector/import-delta.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { loadNames } from "./harness.mjs";

const NOW = 1_794_336_590_090, HOUR = 3_600_000, DAY = 86_400_000;
const decision = (extra = {}) => ({ type: "Decision", title: "Which one?", asked_by: "Manager", question: "Go?", options: ["Yes", "No"], recommended: "Yes", ...extra });

test("the rule: a Decision's eta_at is a time in the future; a past time, a non-number and a precondition are refused; no eta_at is as before", () => {
  assert.equal(askRefusal(decision(), NOW), null);
  assert.equal(askRefusal(decision({ eta_at: NOW + 3 * DAY }), NOW), null);
  assert.equal(askRefusal(decision({ eta_at: NOW - 2 * HOUR }), NOW)?.rule, "decision-not-before");
  assert.equal(askRefusal(decision({ eta_at: NOW - 30_000 }), NOW), null, "a minute of slack, as for a Later");
  assert.equal(askRefusal(decision({ eta_at: 0 }), NOW)?.rule, "decision-not-before");
  assert.equal(askRefusal(decision({ eta_at: "tomorrow" }), NOW)?.rule, "decision-not-before");
  assert.equal(askRefusal(decision({ eta_at: Infinity }), NOW)?.rule, "decision-not-before");
  assert.equal(askRefusal(decision({ eta_at: NOW + DAY, eta_precondition: "after the install" }), NOW)?.rule, "decision-not-before");
  assert.equal(askRefusal(decision({ eta_at: NOW - 5 * DAY }), null), null, "an import passes no clock: the date may have passed by the time it runs");
  // Later is unchanged: it still needs an ETA, and a past one is refused.
  assert.equal(askRefusal({ type: "Later", title: "t", asked_by: "Manager", text: "x" }, NOW)?.rule, "later-without-eta");
  assert.equal(askRefusal({ type: "Later", title: "t", asked_by: "Manager", text: "x", eta_at: NOW - HOUR }, NOW)?.rule, "later-without-eta");
});

test("the store keeps a Decision's eta_at, and the old page's doc carries it as notBefore (and only then)", async () => {
  const db = makeDb();
  const withDate = await createAsk(db, NOW, decision({ eta_at: NOW + 2 * DAY }));
  const without = await createAsk(db, NOW, decision({ title: "Other" }));
  assert.equal(withDate.ok, true);
  const rows = (await db.prepare("SELECT * FROM asks ORDER BY num").all()).results;
  assert.equal(rows[0].eta_at, NOW + 2 * DAY);
  assert.equal(rows[1].eta_at, null);
  assert.equal(waitingDoc(rows[0]).notBefore, NOW + 2 * DAY);
  assert.equal(waitingDoc(rows[0]).kind, "decision", "still a Decision, with its options");
  assert.equal(waitingDoc(rows[1]).notBefore, undefined);
  assert.equal(without.ok, true);
  const refused = await createAsk(db, NOW, decision({ eta_at: NOW - DAY }));
  assert.equal(refused.ok, false, "a past date is refused at the write");
  assert.equal(refused.refused.rule, "decision-not-before");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM asks").first()).n, 2, "and nothing is stored");
});

// The page's two tabs.
function board(waiting) {
  const b = loadNames(["renderAll", "youItems", "tabCounts", "isLater"]);
  Object.assign(b.state, { waiting, messages: [], threads: [], initRaw: [], ideas: [], todo: [] });
  return b;
}
const dec = (id, notBefore) => ({ id, kind: "decision", text: "Decide " + id, options: [{ key: "A", label: "Go" }, { key: "B", label: "Wait" }], since: NOW - 5 * DAY, ...(notBefore === undefined ? {} : { notBefore }) });

test("a Decision with a not-before in the future waits on Later; from the date it is on Needs you (the future/past test)", () => {
  const b = board([dec("future", NOW + 2 * DAY), dec("past", NOW - HOUR), dec("none"), { id: "l1", kind: "later", text: "later", since: NOW - DAY }]);
  assert.equal(b.isLater(b.state.waiting[0], NOW), true);
  assert.deepEqual(b.youItems(NOW, "").asks.map((w) => w.id).sort(), ["none", "past"], "Needs you: the Decision whose date has passed, and one with none");
  const c = b.tabCounts(NOW, "");
  assert.equal(c.you, 2);
  assert.equal(c.later, 2, "Later: the plain Later and the Decision whose date is ahead");
  // the same ask, a minute either side of its date
  const at = NOW + 2 * DAY;
  assert.equal(b.tabCounts(at - 60_000, "").later, 2);
  assert.equal(b.tabCounts(at - 60_000, "").you, 2);
  assert.equal(b.tabCounts(at + 60_000, "").later, 1, "after the date it has left Later");
  assert.equal(b.tabCounts(at + 60_000, "").you, 3, "and is on Needs you, with no write in between");
  assert.equal(b.youItems(at + 60_000, "").asks.some((w) => w.id === "future"), true);
});

// Checker's N1 on 4b78507: a #T link to a Decision with a future date must open Later (where it is listed), not Needs you.
test("a #T link to a Decision with a future date opens the Later tab; the same ask past its date opens Needs you", () => {
  const b = loadNames(["trefPlace", "isLater"]);
  Object.assign(b.state, { waiting: [dec("future", NOW + 2 * DAY), { id: "l1", kind: "later", text: "later", since: NOW - DAY }], messages: [], threads: [], initRaw: [], ideas: [], todo: [] });
  assert.equal(b.trefPlace("future", NOW).tab, "later");
  assert.equal(b.trefPlace("future", NOW + 2 * DAY - 60_000).tab, "later", "a minute before the date");
  assert.equal(b.trefPlace("future", NOW + 2 * DAY + 60_000).tab, "you", "a minute after it, with no write in between");
  assert.equal(b.trefPlace("l1", NOW).tab, "later", "a plain Later is as before");
});

test("a Decision with a future date is not on Needs you, and is drawn under Later with its options", () => {
  const b = board([dec("future", Date.now() + 3 * DAY)]);
  b.renderAll();
  assert.equal(b.els.waiting.innerHTML, '<div class="empty">Nothing needs you.</div>');
  assert.match(b.els.later.innerHTML, /Decide future/);
});

test("the import keeps the old ETA on an item it brings in as a Decision, and #T166 goes back to Later", async () => {
  const eta = NOW + 14 * DAY;
  const old = { kind: "later", text: "Reply price detail?", question: "Keep the replies as they are?", options: [{ key: "A", label: "Keep", recommended: true }, { key: "B", label: "Match the first email" }], eta, since: NOW - 3 * DAY };
  const r = askRow("reply-price-detail", old, { thread: { num: 166 }, askedBy: "Manager" });
  assert.equal(r.ok, true);
  assert.equal(r.row.type, "Decision");
  assert.equal(r.row.eta_at, eta, "the old ETA is the Decision's not-before");
  const noEta = askRow("x", { ...old, eta: undefined }, { thread: { num: 167 }, askedBy: "Manager" });
  assert.equal(noEta.row.eta_at, null);
  // A Decision an earlier run already converted without a date (what the store holds): the fix sets it, once, and only while open and unanswered.
  const db = makeDb();
  await db.prepare("INSERT INTO asks (id, num, type, title, asked_by, body, created_at) VALUES ('reply-price-detail', 166, 'Decision', 't', 'Manager', ?, 1)").bind(r.row.body).run();
  const sql = askFixSql(r.row).split("\n");
  assert.equal(sql.length, 2, "the conversion for a Later, and the date for an already-converted Decision");
  let changed = 0;
  for (const l of sql) changed += (await db.prepare(l).run()).meta.changes;
  assert.equal(changed, 1);
  assert.equal((await db.prepare("SELECT eta_at FROM asks WHERE id = 'reply-price-detail'").first()).eta_at, eta);
  changed = 0;
  for (const l of sql) changed += (await db.prepare(l).run()).meta.changes;
  assert.equal(changed, 0, "a second run changes nothing");
  // answered since: left alone
  await db.prepare("UPDATE asks SET eta_at = NULL, answered_at = 5, answer = 'Keep' WHERE id = 'reply-price-detail'").run();
  for (const l of sql) changed += (await db.prepare(l).run()).meta.changes;
  assert.equal(changed, 0, "an answered Decision is not given a date");
  assert.equal(waitingDoc((await db.prepare("SELECT * FROM asks WHERE id = 'reply-price-detail'").first())).notBefore, undefined);
  // a Later still converts in one statement, keeping the date
  const dbL = makeDb();
  await dbL.prepare("INSERT INTO asks (id, num, type, title, asked_by, body, eta_at, created_at) VALUES ('reply-price-detail', 166, 'Later', 't', 'Manager', '{\"text\":\"t\"}', 5, 1)").run();
  for (const l of sql) await dbL.prepare(l).run();
  const row = await dbL.prepare("SELECT type, eta_at FROM asks WHERE id = 'reply-price-detail'").first();
  assert.deepEqual(row, { type: "Decision", eta_at: eta });
});
