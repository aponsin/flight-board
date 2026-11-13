// #C1046 (the owner, 2026-11-12): no agent closes a thread unless the newest message on it is the owner's. The store refuses an agent's ask_close otherwise,
// telling it to post and leave the thread for him. The owner closes at any time; an agent closes right after the owner's own last message (Ack, Done,
// Closed). An agent's post cannot carry `resolved`, so there is no second way to close.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createAsk, closeAsk, postMessage, readView } from "../worker/board-store.mjs";
import { closeRefusal } from "../worker/board-rules.mjs";

const T = 1_800_000_000_000, MIN = 60_000;
const later = (db, by = "Manager") => createAsk(db, T, { type: "Later", title: "L", asked_by: by, text: "t", eta_at: T + 86_400_000 });
const say = (db, at, who, id, body = "word") => postMessage(db, at, who, { thread_id: id, body });
const refusals = async (db) => (await db.prepare("SELECT rule, who FROM refusals ORDER BY id").all()).results;
const closedAt = async (db, id) => (await db.prepare("SELECT closed_at FROM asks WHERE id = ?").bind(id).first()).closed_at;

test("an agent closes right after the owner's own last message, whatever the word", async () => {
  for (const word of ["Ack.", "Done", "Closed", "Thanks, looks fine"]) {
    const db = makeDb(), a = await later(db);
    await say(db, T + MIN, "Manager", a.id, "Here is the result.");
    await say(db, T + 2 * MIN, "owner", a.id, word);
    const r = await closeAsk(db, T + 3 * MIN, "Manager", a.id, "agent");
    assert.deepEqual(r, { ok: true, id: a.id }, word);
    assert.equal(await closedAt(db, a.id), T + 3 * MIN);
  }
});

test("an agent is refused when the newest message is not the owner's, and the refusal says to post and leave it", async () => {
  const db = makeDb(), a = await later(db);
  // Nobody has written: no owner's word.
  const none = await closeAsk(db, T + MIN, "Manager", a.id, "agent");
  assert.equal(none.refused.rule, "close-not-after-owner");
  assert.match(none.refused.detail, /post your note and leave the thread for the owner/);
  // The owner spoke, then an agent posted after him: his word is no longer the newest.
  await say(db, T + 2 * MIN, "owner", a.id, "Ack.");
  await say(db, T + 3 * MIN, "Builder", a.id, "One more thing.");
  assert.equal((await closeAsk(db, T + 4 * MIN, "Manager", a.id, "agent")).refused.rule, "close-not-after-owner");
  assert.equal(await closedAt(db, a.id), null, "still open");
  assert.deepEqual((await refusals(db)).map((r) => [r.rule, r.who]), [["close-not-after-owner", "Manager"], ["close-not-after-owner", "Manager"]], "each refusal is logged");
  // The owner speaks again: now it closes.
  await say(db, T + 5 * MIN, "owner", a.id, "Closed.");
  assert.equal((await closeAsk(db, T + 6 * MIN, "Manager", a.id, "agent")).ok, true);
});

test("the owner closes at any time, whatever the thread's newest message is", async () => {
  for (const setup of ["empty", "agent-last"]) {
    const db = makeDb(), a = await later(db);
    if (setup === "agent-last") await say(db, T + MIN, "Manager", a.id, "Waiting on you.");
    assert.deepEqual(await closeAsk(db, T + 2 * MIN, "owner", a.id, "owner"), { ok: true, id: a.id }, setup);
    assert.equal((await readView(db, T + 3 * MIN)).asks[0].closed_by, "owner");
  }
});

test("only the thread of the ask counts: the owner's word on another thread does not let an agent close", async () => {
  const db = makeDb(), a = await later(db), b = await later(db);
  await say(db, T + MIN, "owner", b.id, "Ack.");
  assert.equal((await closeAsk(db, T + 2 * MIN, "Manager", a.id, "agent")).refused.rule, "close-not-after-owner");
  assert.equal((await closeAsk(db, T + 2 * MIN, "Manager", b.id, "agent")).ok, true);
});

test("an Approval is closed by the Reviewer for a merged or replaced pull request with no word from the owner", async () => {
  const db = makeDb();
  const a = await createAsk(db, T, { type: "Approval", title: "Approve #12", asked_by: "Reviewer", pr: 12, head: "a".repeat(40), url: "https://github.com/example/sites/pull/12" });
  if (!a.ok) return assert.fail(JSON.stringify(a));
  assert.equal((await closeAsk(db, T + MIN, "Reviewer", a.id, "agent")).ok, true);
});

test("the rule's own table: an agent needs the owner's last word; the owner and an Approval need nothing", () => {
  const ask = (type = "Later") => ({ id: "x", type, asked_by: "Manager" });
  assert.equal(closeRefusal(ask(), "Manager", "agent", { author: "owner" }), null);
  assert.equal(closeRefusal(ask(), "Manager", "agent", { author: "Manager" }).rule, "close-not-after-owner");
  assert.equal(closeRefusal(ask(), "Manager", "agent", null).rule, "close-not-after-owner");
  assert.equal(closeRefusal(ask(), "Manager", "agent").rule, "close-not-after-owner");
  assert.equal(closeRefusal(ask(), "owner", "owner", { author: "Manager" }), null);
  assert.equal(closeRefusal(ask(), "owner", "owner", null), null);
  assert.equal(closeRefusal(ask("Approval"), "Manager", "agent", null), null);
  // The order of the rules is kept: not yours, then not after the owner, then unanswered.
  assert.equal(closeRefusal(ask(), "Builder", "agent", { author: "owner" }).rule, "close-not-yours");
  assert.equal(closeRefusal(ask("Decision"), "Manager", "agent", { author: "owner" }).rule, "close-unanswered");
});

test("an agent's post cannot carry resolved: there is no second way to close a thread", async () => {
  const db = makeDb(), a = await later(db);
  const r = await postMessage(db, T + MIN, "Manager", { thread_id: a.id, body: "done", resolved: true });
  assert.equal(r.refused.rule, "message-shape");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?").bind(a.id).first()).n, 0, "nothing was stored");
});
