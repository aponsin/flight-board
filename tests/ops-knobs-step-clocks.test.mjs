// #C1106 part B: the step clocks' two times are settings the probe posts: stallAfterSec (a card waits this long at a phase with its agent idle) and
// shipSlowSec (Release's ship step is slow after this long). The store reads them at each run; the stall line's words follow the setting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, wakeAsk, takeInbox } from "../worker/board-store.mjs";
import { beat } from "./helpers/beating-store.mjs";
import { resolveKnobs, KNOBS } from "../worker/knobs.mjs";
import { minWords, stallMsOf, shipSlowMsOf, STALL_AFTER_MS, SHIP_SLOW_MS } from "../worker/board-rules.mjs";

const M = 60_000, T = 1_800_000_000_000;

test("the defaults are the old numbers and the bounds hold", () => {
  assert.equal(STALL_AFTER_MS, 15 * M);
  assert.equal(SHIP_SLOW_MS, 11 * M);
  assert.equal(resolveKnobs({ stallAfterSec: 1200 }).values.stallAfterSec, 1200);
  assert.deepEqual(resolveKnobs({ stallAfterSec: 10 }).ignored, [{ key: "stallAfterSec", why: "too low" }]);
  assert.deepEqual(resolveKnobs({ shipSlowSec: 99999 }).ignored, [{ key: "shipSlowSec", why: "too high" }]);
  assert.equal(stallMsOf({ values: { stallAfterSec: 1200 } }), 20 * M);
  assert.equal(stallMsOf({ values: { stallAfterSec: 1 } }), STALL_AFTER_MS, "out of bounds: the default");
  assert.equal(shipSlowMsOf(null), SHIP_SLOW_MS);
  assert.ok(KNOBS.stallAfterSec.max >= KNOBS.stallAfterSec.default && KNOBS.shipSlowSec.max >= KNOBS.shipSlowSec.default);
});

test("the stall line says the threshold it crossed: 15 min at the default, 20 min at 1200 s, a part of a minute rounded up", () => {
  assert.equal(minWords(15 * M), "15 min");
  assert.equal(minWords(20 * M), "20 min");
  assert.equal(minWords(150_000), "3 min");
});

async function world(stallAfterSec) {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "card-a", title: "A card", owner_role: "Boardsmith" });
  await writeEvidence(db, T, "probe", "cards.card-a", { lit: ["checker"], phase: "checker", ci: "none" });
  await writeEvidence(db, T, "probe", "agents", { Checker: { state: "idle", tool: null, card: null, since: T } });
  if (stallAfterSec !== undefined) await writeEvidence(db, T, "probe", "knobs", { values: { stallAfterSec }, ignored: [] });
  return db;
}
const stallsAt = async (db, at) => { await beat(db, at); await wakeAsk(db, at); return (await takeInbox(db, at + 1000)).stalls; };

test("through the store: a posted stallAfterSec of 1200 holds the stall at 16 minutes and raises it at 20, with the words 20 min", async () => {
  assert.equal((await stallsAt(await world(1200), T + 16 * M)).length, 0, "16 min is under the posted 20");
  const rows = await stallsAt(await world(1200), T + 20 * M);
  assert.equal(rows.length, 1);
  assert.match(rows[0].reason, /^#C1 waits at Checker 20 min, Checker idle since /);
  assert.equal((await stallsAt(await world(), T + 16 * M)).length, 1, "no setting posted: the 15 min default raises it at 16");
  assert.match((await stallsAt(await world(), T + 16 * M))[0].reason, /^#C1 waits at Checker 15 min,/);
  assert.equal((await stallsAt(await world(600), T + 11 * M)).length, 1, "a posted 600 s raises it at 11");
});

test("through the store: a posted shipSlowSec moves the slow line", async () => {
  const mk = async (shipSlowSec) => {
    const db = makeDb();
    await createCard(db, T, "Manager", { id: "card-b", title: "B card", owner_role: "Boardsmith" });
    await writeEvidence(db, T, "probe", "cards.card-b", { lit: ["ship"], phase: "ship", ci: "none" });
    await writeEvidence(db, T, "probe", "agents", { Boardsmith: { state: "working", tool: "Bash", card: "card-b", since: T } });
    if (shipSlowSec !== undefined) await writeEvidence(db, T, "probe", "knobs", { values: { shipSlowSec }, ignored: [] });
    return db;
  };
  assert.equal((await stallsAt(await mk(), T + 12 * M)).length, 1, "default 11 min: slow at 12");
  assert.equal((await stallsAt(await mk(1200), T + 12 * M)).length, 0, "posted 20 min: not slow at 12");
  assert.equal((await stallsAt(await mk(1200), T + 21 * M)).length, 1, "posted 20 min: slow at 21");
});
