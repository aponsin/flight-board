// #C925 (11-11: #T1779 "At 8 am MT I'll put one decision to you" and #T1785 were Manager's own dated promises, filed as Later asks; at
// 8 am they read "waiting on you" and nothing woke Manager): a Later can carry owed_by "Manager". At its date the store wakes Manager
// once, and the page says "Manager owes you this", never "waiting on you". A Later that waits on the owner is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { askRefusal, PROMISE_ROLES } from "../worker/board-rules.mjs";
import { createAsk, wakeAsk, takeInbox } from "../worker/board-store.mjs";
import { waitingDoc } from "../worker/compat-view.mjs";
import { promiseWakes, askWakes, askWaitsFrom, pushesDue, PROMISE_WAKE_PREFIX } from "../worker/push-rules.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { loadNames } from "./harness.mjs";

const NOW = 1_794_336_590_090, MIN = 60e3, HOUR = 3_600_000, DAY = 86_400_000;
const promise = (extra = {}) => ({ type: "Later", title: "One decision for you", asked_by: "Manager", text: "At 8 am MT I'll put one decision to you", eta_at: NOW + HOUR, owed_by: "Manager", ...extra });
const later = (extra = {}) => ({ type: "Later", title: "A screenshot", asked_by: "Manager", text: "Take the screenshot after the deploy", eta_at: NOW + HOUR, ...extra });

test("the rule: owed_by is the lead's own promise, on a Later with a date; anything else is refused; a Later without it is as before", () => {
  assert.deepEqual(PROMISE_ROLES, ["Manager"]);
  assert.equal(askRefusal(promise(), NOW), null);
  assert.equal(askRefusal(later(), NOW), null, "Still allowed: a Later that waits on the owner");
  for (const [why, ask] of [
    ["on a Decision", { type: "Decision", title: "t", asked_by: "Manager", question: "q", options: ["A", "B"], recommended: "A", owed_by: "Manager" }],
    ["owed by another role", promise({ owed_by: "Builder", asked_by: "Builder" })],
    ["owed by someone else than the asker", promise({ asked_by: "Release" })],
    ["with a precondition", promise({ eta_precondition: "after the install" })],
    ["not a string", promise({ owed_by: true })],
  ]) assert.equal(askRefusal(ask, NOW)?.rule, "promise-shape", why);
  assert.equal(askRefusal(promise({ eta_at: undefined }), NOW)?.rule, "later-without-eta", "a promise without a date is a Later without an ETA");
});

test("the store keeps owed_by and the old page's doc carries it as owedBy; a plain Later carries none; a hostile stored value is not carried", async () => {
  const db = makeDb();
  assert.equal((await createAsk(db, NOW, promise())).ok, true);
  assert.equal((await createAsk(db, NOW, later())).ok, true);
  const rows = (await db.prepare("SELECT * FROM asks ORDER BY num").all()).results;
  assert.equal(rows[0].owed_by, "Manager"); assert.equal(rows[1].owed_by, null);
  assert.equal(waitingDoc(rows[0]).owedBy, "Manager");
  assert.equal(waitingDoc(rows[1]).owedBy, undefined);
  assert.equal(waitingDoc({ ...rows[0], owed_by: "<b>x</b>" }).owedBy, undefined);
  assert.ok(!JSON.parse(rows[0].body).owed_by, "owed_by is a column, not part of the body");
});

test("at its date a promise wakes Manager once, with its number; never before, never the owner's nudge or phone; a plain Later is unchanged", () => {
  const p = { id: "t1779", num: 1779, type: "Later", eta_at: NOW, created_at: NOW - DAY, owed_by: "Manager", answered_at: null, closed_at: null, withdrawn_at: null };
  const l = { ...p, id: "t1770", num: 1770, owed_by: null };
  assert.deepEqual(promiseWakes({ asks: [p, l], now: NOW - 1 }), [], "not before its date");
  const w = promiseWakes({ asks: [p, l], now: NOW });
  assert.equal(w.length, 1);
  assert.equal(w[0].card_id, `${PROMISE_WAKE_PREFIX}t1779`);
  assert.match(w[0].reason, /^#T1779 is due now: you promised it/);
  assert.deepEqual(promiseWakes({ asks: [{ ...p, closed_at: NOW }, { ...p, answered_at: NOW }, { ...p, withdrawn_at: NOW }], now: NOW + HOUR }), []);
  // The owner's side: a promise waits on nobody there.
  assert.equal(askWaitsFrom(p), null);
  assert.deepEqual(askWakes({ asks: [p], now: NOW + HOUR }), []);
  assert.deepEqual(pushesDue({ asks: [p], ships: [], sent: new Set(), now: NOW + HOUR }).asks, []);
  // Still allowed: the owner's Later still nudges Manager at 10 min and reaches the phone at 30.
  assert.equal(askWakes({ asks: [l], now: NOW + 10 * MIN }).length, 1);
  assert.equal(pushesDue({ asks: [l], ships: [], sent: new Set(), now: NOW + 30 * MIN }).asks.length, 1);
});

test("through the store: Manager's wake batch carries the promise once at its date", async () => {
  const db = makeDb();
  const r = await createAsk(db, NOW, promise());
  assert.equal(r.ok, true);
  assert.equal((await wakeAsk(db, NOW + HOUR - MIN)).count, 0, "before its date");
  assert.equal((await wakeAsk(db, NOW + HOUR)).count, 1);
  const got = (await takeInbox(db, NOW + HOUR + MIN)).stalls;
  assert.ok(got.some((s) => /^#T\d+ is due now: you promised it/.test(s.reason)));
  assert.equal((await wakeAsk(db, NOW + 3 * HOUR)).count, 0, "told once");
});

// The page.
function board(waiting) {
  const b = loadNames(["renderAll", "youItems", "tabCounts", "isLater", "laterHtml", "ownerWait"]);
  Object.assign(b.state, { waiting, messages: [], threads: [], initRaw: [], ideas: [], todo: [] });
  return b;
}
const doc = (id, eta, extra = {}) => ({ id, kind: "later", text: "Later " + id, since: NOW - DAY, eta, ...extra });

test("the page: a promise stays under Later past its date, badged 'Manager owes you this', never 'waiting on you'; the owner's Later moves to Needs you as today", () => {
  const b = board([doc("t1779", NOW - HOUR, { owedBy: "Manager", initiative: "c1" }), doc("t1770", NOW - HOUR)]);
  assert.equal(b.isLater(b.state.waiting[0], NOW), true, "past its date, still Later");
  assert.deepEqual(b.youItems(NOW, "").asks.map((w) => w.id), ["t1770"], "Still allowed: the owner's Later is on Needs you at its date");
  const c = b.tabCounts(NOW, "");
  assert.equal(c.you, 1); assert.equal(c.later, 1);
  const html = b.laterHtml(NOW);
  assert.match(html, /Manager owes you this/);
  assert.doesNotMatch(html, /waiting on you/);
  assert.equal(b.ownerWait({ id: "c1" }, NOW), null, "a card with only a promise on it is not waiting on the owner");
});
