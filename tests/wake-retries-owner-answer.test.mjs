// #C963 (11-11 8:00 pm MT: the owner answered #T1779 while the app restarted; the wake's send failed ("no-agent-reachable") and the next one waited the
// 5 minutes every untaken batch waits, so Manager read it as "nothing retried"). While the owner's own message or answer is untaken, a FAILED send is
// tried again on the next minute; everything else keeps the 5-minute rule.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { shouldSend, RESEND_MS, RETRY_FAILED_OWNER_MS } from "../worker/wake-rules.mjs";
import { answerAsk, createAsk, postMessage, wakeAsk, wakeResult, takeInbox } from "../worker/board-store.mjs";

const T = 1_800_000_000_000, MIN = 60_000;
const GOOD = '{"success":true,"message":"delivered"}', NO_AGENT = "No agent named 'Manager' is reachable.";
const decision = { type: "Decision", title: "Pick", asked_by: "Manager", question: "A or B?", options: ["A", "B"], recommended: "A" };
const answered = async (db, at = T) => { const a = await createAsk(db, at, decision); await answerAsk(db, at + 1000, "owner", { id: a.id, answer: "B" }); return a; };

test("the rule: a failed send with the owner's words waiting is retried after a minute, any other untaken batch after five", () => {
  const base = { batchId: "b1", count: 1, batchAt: T, lastSendAt: T, lastSendBatch: "b1" };
  assert.equal(RETRY_FAILED_OWNER_MS, MIN);
  assert.equal(RESEND_MS, 5 * MIN);
  const failed = { ...base, lastSendOk: false, ownerWaiting: true };
  assert.equal(shouldSend(failed, T + MIN - 1), false, "not before the minute");
  assert.equal(shouldSend(failed, T + MIN), true);
  assert.equal(shouldSend({ ...failed, ownerWaiting: false }, T + MIN), false, "a stall line alone keeps the five minutes");
  assert.equal(shouldSend({ ...failed, ownerWaiting: false }, T + 5 * MIN), true);
  assert.equal(shouldSend({ ...failed, ownerWaiting: undefined }, T + MIN), false, "no word on it: the old rule");
  const sentOk = { ...base, lastSendOk: true, ownerWaiting: true };
  assert.equal(shouldSend(sentOk, T + MIN), false, "a send that went out and is not taken waits five minutes");
  assert.equal(shouldSend(sentOk, T + 5 * MIN), true);
  assert.equal(shouldSend({ ...failed, takenAt: T + 10 }, T + MIN), false, "a taken batch is never sent again");
  assert.equal(shouldSend({ ...failed, count: 0 }, T + MIN), false, "nothing for Manager");
});

test("the owner's answer whose send failed is sent again on the next minute, until Manager takes it", async () => {
  const db = makeDb();
  await answered(db);
  const a = await wakeAsk(db, T + 20_000);
  assert.equal(a.send, true);
  await wakeResult(db, T + 30_000, a.batchId, 0, NO_AGENT);
  const soon = await wakeAsk(db, T + 50_000);
  assert.equal(soon.status.reason, "no-agent-reachable");
  assert.equal(soon.send, false, "20 s after the failure: not yet");
  const retry = await wakeAsk(db, T + 30_000 + MIN);
  assert.equal(retry.send, true, "a minute after the failure: again");
  assert.equal(retry.batchId, a.batchId, "the same batch");
  await wakeResult(db, T + 31_000 + MIN, retry.batchId, 0, NO_AGENT);
  assert.equal((await wakeAsk(db, T + 60_000 + MIN)).send, false);
  assert.equal((await wakeAsk(db, T + 31_000 + 2 * MIN)).send, true, "and again a minute after that, while he waits");
  const inbox = await takeInbox(db, T + 3 * MIN);
  assert.equal(inbox.answers.length, 1, "the answer is in Manager's read until it is taken");
  assert.equal(inbox.answers[0].answer, "B");
  const after = await wakeAsk(db, T + 3 * MIN + 30_000);
  assert.deepEqual([after.send, after.count], [false, 0], "taken: never sent again");
});

test("his message waiting counts the same as his answer", async () => {
  const db = makeDb();
  await postMessage(db, T, "owner", { thread_id: "t", body: "x" });
  const a = await wakeAsk(db, T + 20_000);
  await wakeResult(db, T + 30_000, a.batchId, 1, NO_AGENT);
  assert.equal((await wakeAsk(db, T + 30_000 + MIN)).send, true);
});

test("must still allow: one answer wakes Manager once when delivery works; a stall alone keeps the five minutes", async () => {
  const db = makeDb();
  await answered(db);
  const a = await wakeAsk(db, T + 20_000);
  await wakeResult(db, T + 25_000, a.batchId, 0, GOOD);
  for (const at of [T + 45_000, T + 25_000 + MIN, T + 25_000 + 4 * MIN]) assert.equal((await wakeAsk(db, at)).send, false, "sent once, nothing more before five minutes");
  assert.equal((await wakeAsk(db, T + 25_000 + 5 * MIN + 1)).send, true, "a batch still untaken after five: the old rule");

  // A stall line alone (an ask the owner has left over 10 minutes, #C904) is no word of his: the five minutes stand.
  const stalls = makeDb();
  await createAsk(stalls, T, decision);
  const s = await wakeAsk(stalls, T + 11 * MIN);
  assert.equal(s.count, 1, "the stall line is the whole batch");
  assert.equal(s.send, true);
  await wakeResult(stalls, T + 11 * MIN + 10_000, s.batchId, 0, NO_AGENT);
  assert.equal((await wakeAsk(stalls, T + 12 * MIN + 10_000)).send, false, "no word of his waits: five minutes");
  assert.equal((await wakeAsk(stalls, T + 16 * MIN + 10_000)).send, true);
});
