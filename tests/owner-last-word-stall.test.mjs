// #C1081 (11-16: three threads ended on the owner's words with no reply; read_inbox shows a message once, so a thread answered somewhere else
// stayed unanswered): a thread whose newest message is the owner's and is 10+ min old wakes Manager, and again every 30 min, until someone posts in it.
import test from "node:test";
import assert from "node:assert/strict";
import { wakeAsk, takeInbox } from "../worker/board-store.mjs";
import { ownerWordWakes, OWNER_WORD_PREFIX, OWNER_WORD_MIN, OWNER_WORD_REPEAT_MIN, OWNER_WORD_DAYS } from "../worker/push-rules.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";

const NOW = 1_794_336_590_090, MIN = 60e3, DAY = 86_400_000;
const row = (extra = {}) => ({ thread_id: "thr1", at: NOW - 11 * MIN, resolved: 0, ask_num: null, ask_closed_at: null, ask_withdrawn_at: null, card_num: null, card_dropped: 0, card_done_at: null, thread_num: 166, ...extra });

test("the rule: the owner's last word 11 min old raises one line with the number and the time, never the text", () => {
  const w = ownerWordWakes({ rows: [row()], now: NOW });
  assert.equal(w.length, 1);
  assert.equal(w[0].card_id, `${OWNER_WORD_PREFIX}thr1`);
  assert.match(w[0].reason, /^#T166 ends on the owner's word of .+, unanswered for 10\+ min: post in the thread/);
  assert.doesNotMatch(w[0].reason, /reminder/);
  assert.equal(OWNER_WORD_MIN, 10);
});

test("not before 10 min; a card thread says #C, an ask thread #T; one with no number is not named", () => {
  assert.deepEqual(ownerWordWakes({ rows: [row({ at: NOW - 9 * MIN })], now: NOW }), []);
  assert.equal(ownerWordWakes({ rows: [row({ at: NOW - 10 * MIN })], now: NOW }).length, 1, "10 min exactly counts");
  assert.match(ownerWordWakes({ rows: [row({ thread_num: null, card_num: 1081 })], now: NOW })[0].reason, /^#C1081 ends/);
  assert.match(ownerWordWakes({ rows: [row({ thread_num: null, ask_num: 1957 })], now: NOW })[0].reason, /^#T1957 ends/);
  assert.deepEqual(ownerWordWakes({ rows: [row({ thread_num: null })], now: NOW }), []);
});

test("a thread that is over is not named: a message that resolved it, a closed or withdrawn ask, a dropped or done card", () => {
  for (const extra of [{ resolved: 1 }, { ask_num: 5, ask_closed_at: NOW - MIN }, { ask_num: 5, ask_withdrawn_at: NOW - MIN }, { card_num: 5, thread_num: null, card_dropped: 1 }, { card_num: 5, thread_num: null, card_done_at: NOW - MIN }]) {
    assert.deepEqual(ownerWordWakes({ rows: [row(extra)], now: NOW }), [], JSON.stringify(extra));
  }
});

test("the same word is told again every 30 min with a new reminder number, and the reason does not change in between", () => {
  const at = NOW - 11 * MIN;
  const reasonAt = (t) => ownerWordWakes({ rows: [row({ at })], now: t })[0].reason;
  assert.equal(reasonAt(at + 10 * MIN), reasonAt(at + 39 * MIN), "same reason through the first 30 min");
  assert.match(reasonAt(at + 40 * MIN), /\(reminder 1\)/);
  assert.equal(reasonAt(at + 40 * MIN), reasonAt(at + 69 * MIN));
  assert.match(reasonAt(at + 70 * MIN), /\(reminder 2\)/);
  assert.equal(OWNER_WORD_REPEAT_MIN, 30);
});

test("only the last 7 days: an older word is left alone", () => {
  assert.equal(ownerWordWakes({ rows: [row({ at: NOW - 6 * DAY })], now: NOW }).length, 1);
  assert.deepEqual(ownerWordWakes({ rows: [row({ at: NOW - 8 * DAY })], now: NOW }), []);
  assert.equal(OWNER_WORD_DAYS, 7);
});

// Through the store.
const thread = (db, id, num) => db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES (?, ?, ?, ?)").bind(id, num, "t", NOW - DAY).run();
const say = (db, id, thread_id, author, at, resolved = 0) => db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at, resolved) VALUES (?, ?, ?, ?, ?, ?)").bind(id, thread_id, author, "ok close then", at, resolved).run();
const line = async (db, t) => { await wakeAsk(db, t); return (await takeInbox(db, t)).stalls.filter((s) => s.card_id.startsWith(OWNER_WORD_PREFIX)); };

test("through the store: the owner's word 11 min old wakes Manager; once read it comes again at the reminder, not before", async () => {
  const db = makeDb();
  await thread(db, "thr1", 166);
  await say(db, "m1", "thr1", "owner", NOW - 11 * MIN);
  const first = await line(db, NOW);
  assert.equal(first.length, 1);
  assert.match(first[0].reason, /^#T166 ends on the owner's word/);
  assert.equal((await line(db, NOW + 5 * MIN)).length, 0, "told once, nothing between");
  const again = await line(db, NOW + 30 * MIN);
  assert.equal(again.length, 1);
  assert.match(again[0].reason, /\(reminder 1\)/);
});

test("through the store: a post by an agent after the owner's word ends it, and a word under 10 min old raises nothing", async () => {
  const db = makeDb();
  await thread(db, "thr1", 166);
  await thread(db, "thr2", 167);
  await say(db, "m1", "thr1", "owner", NOW - 20 * MIN);
  await say(db, "m2", "thr1", "Manager", NOW - 5 * MIN);
  await say(db, "m3", "thr2", "owner", NOW - 3 * MIN);
  assert.deepEqual(await line(db, NOW), []);
});

test("through the store: a reminder not yet read is replaced by the next, and once someone posts the line is retired unread", async () => {
  const db = makeDb();
  await thread(db, "thr1", 166);
  await say(db, "m1", "thr1", "owner", NOW - 11 * MIN);
  await wakeAsk(db, NOW);
  await wakeAsk(db, NOW + 30 * MIN);
  const got = (await takeInbox(db, NOW + 31 * MIN)).stalls.filter((s) => s.card_id.startsWith(OWNER_WORD_PREFIX));
  assert.equal(got.length, 1, "Manager reads the newest reminder only");
  assert.match(got[0].reason, /\(reminder 1\)/);
  await say(db, "m2", "thr1", "Manager", NOW + 32 * MIN);
  assert.equal((await line(db, NOW + 61 * MIN)).length, 0);
});

test("through the store: a thread whose owner message resolved it raises nothing", async () => {
  const db = makeDb();
  await thread(db, "thr1", 166);
  await say(db, "m1", "thr1", "owner", NOW - 20 * MIN, 1);
  assert.deepEqual(await line(db, NOW), []);
});
