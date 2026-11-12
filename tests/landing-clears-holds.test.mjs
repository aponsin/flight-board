// #C1036: a card's holds clear when the probe first reads its commit on main; the words are kept in hold_history; a card not yet landed keeps its hold.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { writeEvidence } from "../worker/board-store.mjs";

const T = 1_800_000_000_000;
const card = (db, id, num, extra = "") => db.prepare(`INSERT INTO cards (id, num, title, summary, track, created_at, updated_at, waiting_on, blocked_reason, check_at, hold_end, held_at, hold_until) VALUES (?, ?, 't', 's', 'product', 1, 1, 'Security', 'old block', ?, 'some-ask', ?, ?)`).bind(id, num, T - 1, T - 5000, T - 1000).run();
const read = (db, id, at, onMain) => writeEvidence(db, at, "probe", `cards.${id}`, { lit: ["ship"], phase: "ship", onMain });
const row = (db, id) => db.prepare("SELECT waiting_on, blocked_reason, hold_end, check_at, held_at, hold_until FROM cards WHERE id = ?").bind(id).first();

test("the first reading on main clears waiting_on, blocked_reason, hold_end, check_at and keeps a copy", async () => {
  const db = makeDb();
  await card(db, "landed-card", 1);
  await read(db, "landed-card", T, true);
  assert.deepEqual(await row(db, "landed-card"), { waiting_on: null, blocked_reason: null, hold_end: null, check_at: null, held_at: null, hold_until: null });
  const h = await db.prepare("SELECT card_id, waiting_on, blocked_reason, hold_end, check_at FROM hold_history").all();
  assert.deepEqual(h.results, [{ card_id: "landed-card", waiting_on: "Security", blocked_reason: "old block", hold_end: "some-ask", check_at: T - 1 }]);
});

test("a card not yet on main keeps its hold, and nothing is copied", async () => {
  const db = makeDb();
  await card(db, "open-card", 2);
  await read(db, "open-card", T, false);
  await read(db, "open-card", T + 1, undefined);
  assert.equal((await row(db, "open-card")).waiting_on, "Security");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM hold_history").first()).n, 0);
});

test("a hold set after the card was first read on main is not cleared by the next reading; a done card is left alone", async () => {
  const db = makeDb();
  await card(db, "later-card", 3);
  await read(db, "later-card", T, true);
  await db.prepare("UPDATE cards SET waiting_on = 'new wait' WHERE id = 'later-card'").run();
  await read(db, "later-card", T + 60_000, true);
  assert.equal((await row(db, "later-card")).waiting_on, "new wait", "only the first sighting on main clears");
  await card(db, "done-card", 4);
  await db.prepare("UPDATE cards SET done_at = 5 WHERE id = 'done-card'").run();
  await read(db, "done-card", T, true);
  assert.equal((await row(db, "done-card")).waiting_on, "Security");
});

test("a card with no hold writes no history row", async () => {
  const db = makeDb();
  await db.prepare("INSERT INTO cards (id, num, title, summary, track, created_at, updated_at) VALUES ('plain', 5, 't', 's', 'product', 1, 1)").run();
  await read(db, "plain", T, true);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM hold_history").first()).n, 0);
});
