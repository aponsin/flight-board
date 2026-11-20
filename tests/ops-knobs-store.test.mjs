// #C997: the store's own edges (the probe-silent chip, Live now stale) read the settings the probe posted: the Worker has no board config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { writeEvidence, readView } from "../worker/board-store.mjs";

const NOW = 10_000_000, M = 60_000;

async function store() {
  const db = makeDb();
  const board = { boardId: "flight-board", at: NOW - 4 * M, probe: "a".repeat(12), derivedAt: NOW - 600 * M, quietMin: 0 };
  assert.equal((await writeEvidence(db, NOW - 4 * M, "probe", "board", board)).ok, true);
  assert.equal((await writeEvidence(db, NOW - 4 * M, "probe", "live", { version: "v1.2.3" })).ok, true);
  return db;
}

test("with no setting posted, 4 minutes without a post is fine and Live now is live (the 5-minute default)", async () => {
  const v = await readView(await store(), NOW);
  assert.equal(v.probe.state, "ok");
  assert.equal(v.live.state, "live");
});

test("a posted setting moves both edges: past 120 s the probe is silent and Live now is stale", async () => {
  const db = await store();
  assert.equal((await writeEvidence(db, NOW - 4 * M, "probe", "knobs", { values: { probeSilentSec: 120, staleAfterSec: 120 }, ignored: [] })).ok, true);
  const v = await readView(db, NOW);
  assert.equal(v.probe.state, "silent");
  assert.equal(v.live.state, "stale");
});

test("a posted value out of its bounds is refused: the store never holds one (Security's LOW on #C997), and the default edges stay", async () => {
  const db = await store();
  for (const values of [{ probeSilentSec: 1 }, { staleAfterSec: 1e9 }, { probeSilentSec: 119 }, { staleAfterSec: 1801 }]) {
    const r = await writeEvidence(db, NOW - 4 * M, "probe", "knobs", { values, ignored: [] });
    assert.equal(r.ok, false, JSON.stringify(values));
    assert.equal(r.refused?.rule, "knobs-shape");
  }
  const v = await readView(db, NOW);
  assert.equal(v.probe.state, "ok");
  assert.equal(v.live.state, "live");
  assert.equal((await writeEvidence(db, NOW - 4 * M, "probe", "knobs", { values: { probeSilentSec: 120, staleAfterSec: 1800 }, ignored: [] })).ok, true, "the bounds themselves are allowed");
});
