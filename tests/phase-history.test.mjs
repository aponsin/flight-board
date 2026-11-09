// Phase history (#C723 B3b): rows appear only when the probe's evidence changes a card's lit phase, in the same write, and the
// old page reads them as its step log.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, readView } from "../worker/board-store.mjs";
import { historyRows, whoForPhase, PHASE_LANES } from "../worker/board-rules.mjs";
import { compatView } from "../worker/compat-view.mjs";
import { render } from "../scripts/fixtures.mjs";

const T = 1_800_000_000_000;
const lit = (p) => ({ lit: [p], phase: p });
const hist = async (db) => (await db.prepare("SELECT card_id, phase, kind, at, who, source FROM phase_history ORDER BY id").all()).results;
const seed = async () => { const db = makeDb(); await createCard(db, T, "Manager", { id: "c1", title: "A card", owner_role: "Builder" }); return db; };

test("the first reading starts a phase; a changed phase ends the old one and starts the new one, both at the write's time", async () => {
  const db = await seed();
  await writeEvidence(db, T + 1, "probe", "cards.c1", lit("build"));
  await writeEvidence(db, T + 2, "probe", "cards.c1", lit("build"));
  await writeEvidence(db, T + 3, "probe", "cards.c1", lit("checker"));
  assert.deepEqual(await hist(db), [
    { card_id: "c1", phase: "build", kind: "start", at: T + 1, who: "Builder", source: "evidence" },
    { card_id: "c1", phase: "build", kind: "end", at: T + 3, who: "Builder", source: "evidence" },
    { card_id: "c1", phase: "checker", kind: "start", at: T + 3, who: "Checker", source: "evidence" },
  ]);
});

test("who is the role the agents evidence shows working on the card, else the phase's lane, else the card's owner", async () => {
  const db = await seed();
  await writeEvidence(db, T, "probe", "agents", { Designer: { state: "working", card: "c1" }, Builder: { state: "idle", card: "c1" } });
  await writeEvidence(db, T + 1, "probe", "cards.c1", lit("build"));
  assert.equal((await hist(db))[0].who, "Designer");
  assert.equal(whoForPhase("c1", "security", {}, "Builder"), "Security"); assert.equal(whoForPhase("c1", "build", {}, "Builder"), "Builder"); assert.equal(whoForPhase("c1", "build", null, null), null);
  assert.equal(PHASE_LANES.live, "Release");
});

test("a refused evidence write adds no history, and a key that is not a card adds none", async () => {
  const db = await seed();
  assert.equal((await writeEvidence(db, T, "probe", "cards.c1", { lit: ["build", "test"] })).ok, false);
  assert.equal((await writeEvidence(db, T, "probe", "agents", {})).ok, true);
  assert.deepEqual(await hist(db), []);
});

test("historyRows is pure: no change, no rows", () => {
  assert.deepEqual(historyRows("c", "build", "build", 1, "x"), []);
  assert.deepEqual(historyRows("c", null, "plan", 1, "x"), [{ card_id: "c", phase: "plan", kind: "start", at: 1, who: "x" }]);
});

test("the compat view gives the history as the old steps, and the old page puts the who on the tile", async () => {
  const db = await seed();
  const now = Date.now();
  await writeEvidence(db, now - 3_600_000, "probe", "cards.c1", lit("plan"));
  await writeEvidence(db, now - 600_000, "probe", "cards.c1", lit("build"));
  const view = await readView(db, now);
  const c = compatView(view).collections;
  assert.deepEqual(c.steps.map((s) => [s.init, s.phase, s.kind, s.who]), [["c1", "plan", "start", "Builder"], ["c1", "plan", "end", "Builder"], ["c1", "build", "start", "Builder"]]);
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  const board = render(html, c).board;
  // Plan is over after the 50 minutes the history says (the old page shows a finished tile's time); Build is the one in progress,
  // from the history's start (the old page's own "start logged HH:MM" line, until it sees work).
  assert.match(board, /<div class="step done" title="Plan">Plan<small>50 min<\/small>/);
  assert.match(board, /<div class="step now[^"]*" title="Build">Build<small[^>]*>start logged /);
});

test("no history, no steps collection", async () => {
  assert.equal("steps" in compatView(await readView(await seed(), T)).collections, false);
});
