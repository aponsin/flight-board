// #C1329 (Checker 2's LOW on #C1325): the probe reads a branch named <card id>-v<N> as a re-cut of that card (slugOfBranch), so a new card whose own id ends in -v<number> is refused,
// rule card-id-vn. The ids that are still fine come first (guard-false-positives): a -v inside the id, a v and a number not at the end, and an id ending in a plain word.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard } from "../worker/board-store.mjs";

const NOW = 1_800_000_000_000;

test("must still allow: ids with -v or v<number> anywhere but the end, and an id ending in a word", async () => {
  const db = makeDb();
  for (const id of ["dispatch-sees-v2-branches", "v2-cleanup", "ship-v2x", "move-to-v", "version-two", "rev2", "tv2", "a-v2-b"]) {
    const r = await createCard(db, NOW, "Manager", { id, title: "A card" });
    assert.equal(r.ok, true, `${id}: ${JSON.stringify(r)}`);
  }
});

test("an id ending in -v and a number is refused with rule card-id-vn, whatever the width, and nothing is written", async () => {
  const db = makeDb();
  for (const id of ["fix-menu-v2", "fix-menu-v10", "fix-menu-v123", "x-v1", "a-b-v0"]) {
    const r = await createCard(db, NOW, "Manager", { id, title: "A card" });
    assert.equal(r.ok, false, id);
    assert.equal(r.refused?.rule ?? r.rule, "card-id-vn", `${id}: ${JSON.stringify(r)}`);
    assert.equal(await db.prepare("SELECT 1 AS x FROM cards WHERE id = ?").bind(id).first(), null, `${id} not written`);
  }
});
