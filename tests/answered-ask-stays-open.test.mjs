// #C1109 (rules the lead kept in memory: never close an ask the owner just answered or marked Done, he closes it; never resolve his thread with an agent's post): the store refuses an
// agent's ask_close for an hour after the owner's answer, and an agent's post cannot carry `resolved` (#C1046's rule, pinned again here beside the new one). The owner closes at any time.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createAsk, answerAsk, closeAsk, postMessage } from "../worker/board-store.mjs";
import { closeRefusal, ANSWERED_CLOSE_HOLD_MS } from "../worker/board-rules.mjs";

const T = 1_800_000_000_000, MIN = 60_000, HOUR = 60 * MIN;
const answerAsker = async (db, by = "Manager") => { const a = await createAsk(db, T, { type: "Answer", title: "A question", asked_by: by, question: "Why?" }); assert.ok(a.ok, JSON.stringify(a)); return a; };
const owner = async (db, id, at, answer = "Because.", status) => { const r = await answerAsk(db, at, "owner", { id, answer, ...(status ? { status } : {}) }); assert.ok(r.ok, JSON.stringify(r)); return r; };
const say = (db, at, who, id, body = "word") => postMessage(db, at, who, { thread_id: id, body });
const closedAt = async (db, id) => (await db.prepare("SELECT closed_at FROM asks WHERE id = ?").bind(id).first()).closed_at;

test("an agent cannot close an ask the owner answered less than an hour ago, even when his word is the newest on the thread; the refusal says he closes it", async () => {
  const db = makeDb(), a = await answerAsker(db);
  await owner(db, a.id, T + MIN);
  await say(db, T + 2 * MIN, "owner", a.id, "Done, thanks.");
  const r = await closeAsk(db, T + 10 * MIN, "Manager", a.id, "agent");
  assert.equal(r.refused.rule, "close-owner-just-answered", JSON.stringify(r));
  assert.match(r.refused.detail, /answered it 9 min ago; he closes it/);
  assert.equal(await closedAt(db, a.id), null, "still open");
  const edge = await closeAsk(db, T + MIN + HOUR - 1, "Manager", a.id, "agent");
  assert.equal(edge.refused.rule, "close-owner-just-answered", "one millisecond short of the hour");
});

test("an hour after his answer an agent may close, with the owner's word newest", async () => {
  const db = makeDb(), a = await answerAsker(db);
  await owner(db, a.id, T + MIN);
  await say(db, T + 2 * MIN, "owner", a.id, "Done, thanks.");
  assert.deepEqual(await closeAsk(db, T + MIN + HOUR, "Manager", a.id, "agent"), { ok: true, id: a.id });
  assert.equal(await closedAt(db, a.id), T + MIN + HOUR);
});

test("the owner closes at once, whatever the hour", async () => {
  const db = makeDb(), a = await answerAsker(db);
  await owner(db, a.id, T + MIN);
  assert.deepEqual(await closeAsk(db, T + 2 * MIN, "owner", a.id, "owner"), { ok: true, id: a.id });
});

test("an ask the owner has not answered is as before: the #C1046 rule decides (the owner's last word), not the hold", async () => {
  const db = makeDb();
  const later = await createAsk(db, T, { type: "Later", title: "L", asked_by: "Manager", text: "t", eta_at: T + 86_400_000 });
  await say(db, T + MIN, "owner", later.id, "Ack.");
  assert.deepEqual(await closeAsk(db, T + 2 * MIN, "Manager", later.id, "agent"), { ok: true, id: later.id });
});

test("an Approval is the Reviewer's housekeeping: closed with no wait after the owner's approval", async () => {
  const db = makeDb();
  const a = await createAsk(db, T, { type: "Approval", title: "Approve #12", asked_by: "Reviewer", pr: 12, head: "a".repeat(40), url: "https://github.com/example/sites/pull/12" });
  if (!a.ok) return assert.fail(JSON.stringify(a));
  const r = await answerAsk(db, T + MIN, "owner", { id: a.id, answer: "Approved" });
  if (r.ok) assert.equal((await closeAsk(db, T + 2 * MIN, "Reviewer", a.id, "agent")).ok, true);
  else assert.equal((await closeAsk(db, T + 2 * MIN, "Reviewer", a.id, "agent")).ok, true, "closed without an answer too");
});

test("the rule's own table: the hold needs an agent, a finite now and an answer inside the hour; not-yours still comes first", () => {
  const ask = (over = {}) => ({ id: "x", type: "Answer", asked_by: "Manager", answered_at: T, ...over });
  const owner_ = { author: "owner" };
  assert.equal(closeRefusal(ask(), "Manager", "agent", owner_, T + 30 * MIN).rule, "close-owner-just-answered");
  assert.equal(closeRefusal(ask(), "Manager", "agent", owner_, T + ANSWERED_CLOSE_HOLD_MS), null, "exactly an hour: allowed");
  assert.equal(closeRefusal(ask(), "Manager", "agent", owner_, null), null, "no clock, no hold (an old caller)");
  assert.equal(closeRefusal(ask(), "Manager", "agent", owner_), null);
  assert.equal(closeRefusal(ask(), "owner", "owner", null, T + MIN), null, "the owner is never held");
  assert.equal(closeRefusal(ask({ answered_at: null, type: "Later" }), "Manager", "agent", owner_, T + MIN), null, "not answered: nothing to hold");
  assert.equal(closeRefusal(ask({ answered_at: T + HOUR }), "Manager", "agent", owner_, T), null, "an answer from the future is no hold");
  assert.equal(closeRefusal(ask(), "Builder", "agent", owner_, T + MIN).rule, "close-not-yours", "not yours first");
  assert.equal(closeRefusal(ask({ type: "Approval" }), "Manager", "agent", null, T + MIN), null, "an Approval is housekeeping");
});

test("an agent's post cannot carry resolved, so it cannot hide the owner's thread (the rule of #C1046 holds beside this one)", async () => {
  const db = makeDb(), a = await answerAsker(db);
  await say(db, T + MIN, "owner", a.id, "A question of mine, not yet answered.");
  const r = await postMessage(db, T + 2 * MIN, "Manager", { thread_id: a.id, body: "answered", resolved: true });
  assert.equal(r.refused.rule, "message-shape");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND author = 'Manager'").bind(a.id).first()).n, 0, "nothing was stored");
});
