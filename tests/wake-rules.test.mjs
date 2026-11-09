import test from "node:test";
import assert from "node:assert/strict";
import { classifySend, nudgeLine, shouldSend, wakeStatus, shouldTellOwner, RESEND_MS, TAKEN_WITHIN_MS } from "../worker/wake-rules.mjs";

const NOW = 1_800_000_000_000;

test("a good send is ok; the two real failures are told apart", () => {
  assert.deepEqual(classifySend(0, '{"success":true,"message":"to Manager"}'), { ok: true });
  const lapsed = classifySend(1, "Failed to authenticate: OAuth session expired and could not be refreshed");
  assert.equal(lapsed.reason, "login-lapsed");
  assert.match(lapsed.fix, /claude \/login/);
  const gone = classifySend(0, "No agent named 'Manager' is reachable.");
  assert.equal(gone.reason, "no-agent-reachable");
  assert.equal(classifySend(0, '{"success":false}').ok, false);
  assert.equal(classifySend(7, "boom").reason, "send-failed");
});

test("the nudge carries a count and a batch id, never board text", () => {
  assert.equal(nudgeLine(3, "b-123"), "3 for Manager, batch b-123");
  assert.equal(nudgeLine(1, "b 1; rm -rf /"), "1 for Manager, batch b1rm-rf");
});

test("nothing is sent while quiet, once per batch, and at most every 5 min", () => {
  assert.equal(shouldSend({ batchId: null, count: 0 }, NOW), false);
  assert.equal(shouldSend({ batchId: "b1", count: 2, batchAt: NOW - 1000 }, NOW), true);
  const sent = { batchId: "b1", count: 2, batchAt: NOW - 400_000, lastSendAt: NOW - 60_000, lastSendBatch: "b1" };
  assert.equal(shouldSend(sent, NOW), false);
  assert.equal(shouldSend({ ...sent, lastSendAt: NOW - RESEND_MS - 1 }, NOW), true);
  assert.equal(shouldSend({ ...sent, takenAt: NOW - 1000 }, NOW), false);
});

test("row 4 goes red for a lapsed login", () => {
  const w = { askedAt: NOW - 5000, batchId: "b1", count: 1, batchAt: NOW - 9000, lastSendOk: false, lastSendReason: "login-lapsed", lastSendFix: "run claude /login" };
  assert.deepEqual([wakeStatus(w, NOW).state, wakeStatus(w, NOW).reason], ["red", "login-lapsed"]);
});

test("row 4 goes red for an unreachable Manager", () => {
  const w = { askedAt: NOW - 5000, batchId: "b1", count: 1, batchAt: NOW - 9000, lastSendOk: false, lastSendReason: "no-agent-reachable" };
  assert.equal(wakeStatus(w, NOW).reason, "no-agent-reachable");
});

test("row 4 goes red when a good send is not taken in 3 min", () => {
  const w = { askedAt: NOW - 5000, batchId: "b1", count: 1, batchAt: NOW - 400_000, lastSendOk: true, lastSendAt: NOW - TAKEN_WITHIN_MS - 1 };
  assert.equal(wakeStatus(w, NOW).reason, "batch-not-taken");
  assert.equal(wakeStatus({ ...w, lastSendAt: NOW - 60_000 }, NOW).state, "ok");
  assert.equal(wakeStatus({ ...w, takenAt: NOW - 1000 }, NOW).state, "idle");
});

test("row 4 goes red when the probe stops asking", () => {
  assert.equal(wakeStatus({ askedAt: NOW - 200_000 }, NOW).reason, "probe-not-asking");
  assert.equal(wakeStatus({}, NOW).state, "red");
});

test("the owner is told once per reason", () => {
  const red = { state: "red", reason: "login-lapsed" };
  assert.equal(shouldTellOwner(red, null), true);
  assert.equal(shouldTellOwner(red, "login-lapsed"), false);
  assert.equal(shouldTellOwner({ state: "ok" }, null), false);
});
