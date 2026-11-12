// #C1040: a checker holds a few open claims at most, and a claim on a card that is done (its tip landed) or dropped frees itself.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { claimReview, releaseReview } from "../worker/board-store.mjs";

const T = 1_800_000_000_000;
const sha = (n) => String(n).padStart(40, "a");

test("the cap refuses a checker's seventh open claim with a clear reason; releasing one makes room", async () => {
  const db = makeDb();
  for (let i = 1; i <= 6; i++) assert.equal((await claimReview(db, T + i, "Checker", { sha: sha(i), checker: "Checker 2" })).ok, true);
  const r = await claimReview(db, T + 10, "Checker", { sha: sha(7), checker: "Checker 2" });
  assert.equal(r.ok, false);
  assert.equal(r.refused.rule, "review-claim-cap");
  assert.match(r.refused.detail, /Checker 2 already holds 6 open claims/);
  assert.equal((await claimReview(db, T + 11, "Checker", { sha: sha(1), checker: "Checker 2" })).ok, true, "claiming a tip it already holds is not a new claim");
  assert.equal((await claimReview(db, T + 12, "Checker", { sha: sha(7), checker: "Checker" })).ok, true, "another checker has its own count");
  await releaseReview(db, T + 13, "Manager", { sha: sha(2) });
  assert.equal((await claimReview(db, T + 14, "Checker", { sha: sha(8), checker: "Checker 2" })).ok, true);
});

test("a landed (done) or dropped card frees its claim; a card not yet landed keeps it", async () => {
  const db = makeDb();
  await db.prepare("INSERT INTO cards (id, num, title, summary, track, created_at, updated_at) VALUES ('landed-card', 1, 'A', 's', 'product', 1, 1), ('open-card', 2, 'B', 's', 'product', 1, 1), ('dropped-card', 3, 'C', 's', 'product', 1, 1)").run();
  await claimReview(db, T, "Checker", { sha: sha(1), checker: "Checker 2", card_id: "landed-card" });
  await claimReview(db, T + 1, "Checker", { sha: sha(2), checker: "Checker 2", card_id: "open-card" });
  await claimReview(db, T + 2, "Checker", { sha: sha(4), checker: "Checker 2", card_id: "dropped-card" });
  await db.prepare("UPDATE cards SET done_at = 5 WHERE id = 'landed-card'").run();
  await db.prepare("UPDATE cards SET dropped = 1 WHERE id = 'dropped-card'").run();
  await claimReview(db, T + 3, "Checker", { sha: sha(3), checker: "Checker" });
  const open = (await db.prepare("SELECT sha FROM review_claims WHERE released_at IS NULL ORDER BY sha").all()).results.map((r) => r.sha);
  assert.deepEqual(open, [sha(2), sha(3)]);
  assert.equal((await db.prepare("SELECT released_by FROM review_claims WHERE sha = ?").bind(sha(1)).first()).released_by, "landed");
});
