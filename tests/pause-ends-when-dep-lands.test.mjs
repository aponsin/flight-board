// #C1162 (11-17: #C843 sat paused "until #C827's deploy pair has run" long after #C827 landed, and nobody unpaused it): a paused card whose depends_on cards have all landed is one line to
// Manager, once per spell. The board never unpauses a card by itself.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { pausedDepLanded, PAUSE_DEP_END } from "../worker/board-rules.mjs";
import { createCard, writeEvidence, wakeAsk } from "../worker/board-store.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const onMain = { lit: ["ship"], phase: "ship", onMain: true, signed: ["checker", "security"] };
const card = (id, num, extra = {}) => ({ id, num, owner_role: "Boardsmith", repo: "flight-board", paused: 0, dropped: 0, done_at: null, depends_on: null, ...extra });
const held = (extra = {}) => card("held", 843, { paused: 1, depends_on: JSON.stringify(["dep-a"]), ...extra });
const run = (cards, evidence = {}, endsPassed = new Set(), now = T) => pausedDepLanded({ now, cards, evidence, endsPassed });

test("a paused card whose only dependency is on main (or live, or done) is one line naming both cards; the words end with the marker", () => {
  for (const [name, dep, ev] of [["on main", card("dep-a", 827), { "dep-a": onMain }], ["live", card("dep-a", 827), { "dep-a": { lit: ["live"] } }], ["done", card("dep-a", 827, { done_at: T }), {}]]) {
    const r = run([held(), dep], ev);
    assert.equal(r.length, 1, name);
    assert.equal(r[0].card_id, "held");
    assert.equal(r[0].reason, `#C843's pause has outlived its dependency: #C827 has landed${PAUSE_DEP_END}`, name);
  }
});

test("several dependencies: the line only when every one has landed, and it names them all", () => {
  const cards = [held({ depends_on: JSON.stringify(["dep-a", "dep-b"]) }), card("dep-a", 827), card("dep-b", 830)];
  assert.deepEqual(run(cards, { "dep-a": onMain }), [], "one still open: nothing");
  const r = run(cards, { "dep-a": onMain, "dep-b": onMain });
  assert.equal(r.length, 1);
  assert.match(r[0].reason, /outlived its dependency: #C827, #C830 have landed: unpause it or close it$/);
});

test("nothing for: a dependency still open, dropped or unknown to the board; a paused card with no depends_on; a card that is not paused, dropped or done", () => {
  const dep = card("dep-a", 827);
  assert.deepEqual(run([held(), dep], { "dep-a": { lit: ["checker"], onMain: false } }), [], "open dependency");
  assert.deepEqual(run([held(), card("dep-a", 827, { dropped: 1 })], { "dep-a": onMain }), [], "dropped dependency");
  assert.deepEqual(run([held()], {}), [], "dependency the board does not have");
  assert.deepEqual(run([held({ depends_on: null }), dep], { "dep-a": onMain }), [], "no depends_on");
  assert.deepEqual(run([held({ depends_on: "[]" }), dep], { "dep-a": onMain }), [], "empty depends_on");
  assert.deepEqual(run([held({ depends_on: "not json" }), dep], { "dep-a": onMain }), [], "unreadable depends_on");
  assert.deepEqual(run([held({ paused: 0 }), dep], { "dep-a": onMain }), [], "not paused");
  assert.deepEqual(run([held({ dropped: 1 }), dep], { "dep-a": onMain }), [], "dropped card");
  assert.deepEqual(run([held({ done_at: T }), dep], { "dep-a": onMain }), [], "done card");
  assert.deepEqual(run([held({ depends_on: JSON.stringify(["held"]) })], {}), [], "a card that names itself");
});

// Checker 2's F1: an open hold is somebody's decision, not a stall. A hold_end naming the dependency stands until the store ends it (the dependency dropped, done or live), not when it reaches main.
test("an open hold is skipped: hold_end naming the dependency while it is on main, a check_at still to come; the hold's end passed (the dependency live) gives the line", () => {
  const dep = card("dep-a", 827);
  assert.deepEqual(run([held({ hold_end: "dep-a" }), dep], { "dep-a": onMain }), [], "hold_end names the dependency, which is only on main: the hold stands");
  assert.deepEqual(run([held({ check_at: T + MIN }), dep], { "dep-a": onMain }), [], "a check_at still to come");
  assert.equal(run([held({ check_at: T - MIN }), dep], { "dep-a": onMain }).length, 1, "a check_at that has passed is no open hold");
  const live = { "dep-a": { lit: ["live"], onMain: true } };
  assert.equal(run([held({ hold_end: "dep-a" }), dep], live, new Set(["dep-a"])).length, 1, "the dependency is live: the store passed its id as an end that has passed");
  assert.deepEqual(run([held({ hold_end: "dep-a" }), dep], live, new Set()), [], "without the store's word that the end passed, the hold stands");
});

test("through the store: a pending line for Manager once the dependency lands, told once per spell, and gone when the card is unpaused; a later spell tells again", async () => {
  const db = makeDb();
  assert.equal((await createCard(db, T, "Manager", { id: "dep-a", title: "The dependency", owner_role: "Boardsmith", repo: "flight-board" })).ok, true);
  const made = await createCard(db, T, "Manager", { id: "held", title: "The held card", owner_role: "Boardsmith", repo: "flight-board", depends_on: ["dep-a"], paused: 1, next_note: "Paused until the dependency's deploy pair has run.", check_at: T - MIN });
  assert.equal(made.ok, true, JSON.stringify(made));
  const rows = async (pendingOnly = false) => (await db.prepare(`SELECT card_id, reason, taken_at FROM stall_wakes WHERE reason LIKE '%${PAUSE_DEP_END}'${pendingOnly ? " AND taken_at IS NULL" : ""}`).all()).results;
  await writeEvidence(db, T + 1, "probe", "cards.dep-a", { lit: ["checker"], phase: "checker", onMain: false });
  await wakeAsk(db, T + MIN);
  assert.deepEqual(await rows(), [], "the dependency is still open: nothing");
  await writeEvidence(db, T + 2 * MIN, "probe", "cards.dep-a", onMain);
  await wakeAsk(db, T + 3 * MIN);
  const r = await rows(true);
  assert.equal(r.length, 1); assert.equal(r[0].card_id, "held"); assert.match(r[0].reason, /^#C\d+'s pause has outlived its dependency: #C\d+ has landed: unpause it or close it$/);
  await wakeAsk(db, T + 10 * MIN);
  assert.equal((await rows()).length, 1, "the same line is not raised twice in a spell");
  await db.prepare("UPDATE cards SET paused = 0 WHERE id = 'held'").run();
  await wakeAsk(db, T + 11 * MIN);
  assert.deepEqual(await rows(), [], "unpaused: the row goes");
  await db.prepare("UPDATE cards SET paused = 1 WHERE id = 'held'").run();
  await wakeAsk(db, T + 12 * MIN);
  assert.equal((await rows(true)).length, 1, "a later spell tells again");
});

// Checker 2's LOW on v2: no store test ended a hold_end by the dependency going live, so dropping endsPassed from the store's call went unseen.
test("through the store: a hold_end naming the dependency stands while it is only on main, and the line comes once the dependency is live", async () => {
  const db = makeDb();
  assert.equal((await createCard(db, T, "Manager", { id: "dep-a", title: "The dependency", owner_role: "Boardsmith", repo: "flight-board" })).ok, true);
  const made = await createCard(db, T, "Manager", { id: "held", title: "The held card", owner_role: "Boardsmith", repo: "flight-board", depends_on: ["dep-a"], paused: 1, next_note: "Paused until the dependency is live." });
  assert.equal(made.ok, true, JSON.stringify(made));
  await db.prepare("UPDATE cards SET hold_end = 'dep-a', check_at = NULL WHERE id = 'held'").run();
  const rows = async () => (await db.prepare(`SELECT card_id FROM stall_wakes WHERE reason LIKE '%${PAUSE_DEP_END}'`).all()).results;
  await writeEvidence(db, T + 1, "probe", "cards.dep-a", onMain);
  await wakeAsk(db, T + MIN);
  assert.deepEqual(await rows(), [], "on main only: the hold_end stands, no line");
  await writeEvidence(db, T + 2 * MIN, "probe", "cards.dep-a", { lit: ["live"], phase: "live", onMain: true });
  await wakeAsk(db, T + 3 * MIN);
  assert.deepEqual((await rows()).map((x) => x.card_id), ["held"], "the dependency is live: the hold ended, one line");
});
