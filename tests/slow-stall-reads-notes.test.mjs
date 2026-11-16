// #C1093 (11-16: Manager got about 10 "is slow with no reason" stalls, each costing a turn: some minutes after a card started, #C1087 a minute after Manager set its
// rework_reason and next_note, #C1090 while it was only queued behind the owner's current card): a next_note written in the last hour is the reason, and a card whose
// owner is working a different card now is queued behind it, not slow.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { slowWakes, slowLine, reworkReasonLine, SHIP_SLOW_MS, NOTE_FRESH_MS } from "../worker/board-rules.mjs";
import { createCard, updateCard, writeEvidence } from "../worker/board-store.mjs";
import { beat, wakeAsk, takeInbox } from "./helpers/beating-store.mjs"; // a probe heartbeat at the asked time: a later ask is not read as a probe outage (#C990)

const T = 1_800_000_000_000, MIN = 60e3;
const rd = (phase, extra = {}) => ({ lit: [phase], phase, headSha12: "aaaaaaaaaaaa", signed: [], onMain: false, ...extra });
const base = { id: "c", num: 1090, owner_role: "Boardsmith", paused: 0, dropped: 0 };
// A card in ship for SHIP_SLOW_MS + 1 min, so the plain rule calls it slow.
const slow = (fields = {}, agents, ev = rd("ship")) => slowWakes({ now: T, cards: [{ ...base, ...fields }], evidence: { c: ev }, openAskCards: new Set(), phaseStart: new Map([["c|ship", T - SHIP_SLOW_MS - MIN]]), medians: {}, endsPassed: new Set(), agents }).map((s) => s.reason);

test("no note, no roster: the card is slow, as before", () => {
  assert.deepEqual(slow(), [slowLine(1090)]);
  assert.deepEqual(slow({ next_note: "waiting on the Worker deploy" }), [slowLine(1090)], "a note with no time says nothing about when it was written");
});

test("a next_note written in the last hour is the reason: no stall; an hour old or more, the stall comes back", () => {
  assert.deepEqual(slow({ next_note: "pack in flight", moved_at: T - 5 * MIN }), [], "5 min ago");
  assert.deepEqual(slow({ next_note: "pack in flight", moved_at: T - NOTE_FRESH_MS + 1 }), [], "just under the hour");
  assert.deepEqual(slow({ next_note: "pack in flight", moved_at: T - NOTE_FRESH_MS }), [slowLine(1090)], "exactly an hour: stale");
  assert.deepEqual(slow({ next_note: "pack in flight", moved_at: T - 3 * 60 * MIN }), [slowLine(1090)], "3 h ago");
  assert.deepEqual(slow({ next_note: "  ", moved_at: T - MIN }), [slowLine(1090)], "a cleared note is no reason");
  assert.deepEqual(slow({ next_note: null, moved_at: T - MIN }), [slowLine(1090)], "no note, only a move");
  assert.deepEqual(slow({ next_note: "pack in flight", moved_at: T + 5 * MIN }), [slowLine(1090)], "a time in the future is not believed");
});

test("a card in rework with no reason keeps its own line even with a fresh note", () => {
  assert.deepEqual(slow({ next_note: "fixing", moved_at: T - MIN }, undefined, rd("ship", { rework: true })), [reworkReasonLine(1090, "Boardsmith")]);
  assert.deepEqual(slow({ next_note: "fixing", moved_at: T - MIN, rework_reason: "review findings" }, undefined, rd("ship", { rework: true })), [], "the reason given and a note just written (#C1087): no stall");
});

// The same card at another phase: 40 min in it, the phase's usual time 10 min (so the limit is 20 min; ship's is its own).
const slowIn = (phase, fields = {}, agents, ev = rd(phase)) => slowWakes({ now: T, cards: [{ ...base, ...fields }], evidence: { c: ev }, openAskCards: new Set(), phaseStart: new Map([[`c|${phase}`, T - 40 * MIN]]), medians: { [phase]: 10 * MIN }, endsPassed: new Set(), agents }).map((s) => s.reason);

test("a card in build whose owner is working a different card is queued behind it, not slow; on this card, idle or unread, it is slow", () => {
  const b = (agents, fields) => slowIn("build", fields, agents);
  assert.deepEqual(b({ Boardsmith: { state: "working", card: "other-card" } }), []);
  assert.deepEqual(b({ Boardsmith: { state: "working", card: "c" } }), [slowLine(1090)], "working this very card");
  assert.deepEqual(b({ Boardsmith: { state: "idle", card: "other-card" } }), [slowLine(1090)], "idle: nobody is on another card");
  assert.deepEqual(b({ Boardsmith: { state: "working" } }), [slowLine(1090)], "working, no card named");
  assert.deepEqual(b({ Builder: { state: "working", card: "other-card" } }), [slowLine(1090)], "another role's work does not queue it");
  assert.deepEqual(b({}), [slowLine(1090)]);
  assert.deepEqual(b(null), [slowLine(1090)]);
});

// Checker 2's M1 on e78bf708: at ship and at a review the card waits on Release or the reviewer, whatever the owner is doing, so the owner's other card hides nothing there.
test("where the owner does not do the work (ship, checker, security, language, design) the slow line fires whatever the owner is working", () => {
  const busy = { Boardsmith: { state: "working", card: "other-card" } }, idle = { Boardsmith: { state: "idle", card: "other-card" } };
  for (const phase of ["checker", "security", "language", "design"]) {
    assert.deepEqual(slowIn(phase, {}, busy), [slowLine(1090)], `${phase}: owner busy elsewhere`);
    assert.deepEqual(slowIn(phase, {}, idle), [slowLine(1090)], `${phase}: owner idle`);
  }
  assert.deepEqual(slow({}, busy), [slowLine(1090)], "ship: owner busy elsewhere");
  assert.deepEqual(slow({}, idle), [slowLine(1090)], "ship: owner idle");
});

test("a card sent back to its owner with findings is the owner's work again: queued behind the owner's other card, not slow", () => {
  const busy = { Boardsmith: { state: "working", card: "other-card" } };
  assert.deepEqual(slowIn("checker", {}, busy, rd("checker", { findings: ["checker"] })), [], "findings at checker, the owner busy elsewhere");
  assert.deepEqual(slowIn("checker", {}, { Boardsmith: { state: "idle" } }, rd("checker", { findings: ["checker"] })), [slowLine(1090)], "findings, the owner idle");
  assert.deepEqual(slowIn("checker", {}, busy, rd("checker", { signed: ["checker"] })), [slowLine(1090)], "a signed card is not sent back");
});

// The store's own wiring: syncStalls hands slowWakes the card's next_note and moved_at and the roster reading.
async function slowRows(setup, at) {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "c", title: "A card", owner_role: "Boardsmith" });
  await writeEvidence(db, T, "probe", "cards.c", rd("ship"));
  await setup(db);
  await wakeAsk(db, at);
  return (await takeInbox(db, at + 1000)).stalls.map((s) => s.reason).filter((r) => /is slow with no reason/.test(r));
}
const LATE = T + SHIP_SLOW_MS + 2 * MIN;

test("the store: a slow card names Manager; a note written a minute ago ends it; an hour later it is back", async () => {
  assert.equal((await slowRows(async () => {}, LATE)).length, 1, "no note: the stall");
  assert.deepEqual(await slowRows(async (db) => { assert.ok((await updateCard(db, LATE - MIN, "Boardsmith", { id: "c", next_note: "pack in flight" })).ok); }, LATE), [], "note a minute ago");
  assert.equal((await slowRows(async (db) => { assert.ok((await updateCard(db, T + MIN, "Boardsmith", { id: "c", next_note: "pack in flight" })).ok); }, T + MIN + NOTE_FRESH_MS + SHIP_SLOW_MS)).length, 1, "the note is over an hour old");
});

// The store's card is at ship (Release's step, not the owner's work), so the owner's other card ends nothing there, whichever card the roster names (Checker 2's M1 on e78bf708).
test("the store: a card at ship is slow whatever card its owner is working (the roster reading)", async () => {
  // The roster is a probe post at LATE - 1 s: a heartbeat just before it, else the gap since the card's reading is recorded as an outage that pauses the clock (#C990).
  const roster = (card) => async (db) => { await beat(db, LATE - 2000); await writeEvidence(db, LATE - 1000, "probe", "agents", { Boardsmith: { state: "working", card, lastActivityAt: LATE - 1000, since: LATE - 5 * MIN } }); };
  assert.equal((await slowRows(roster("other-card"), LATE)).length, 1, "the owner on another card: still slow at ship");
  assert.equal((await slowRows(roster("c"), LATE)).length, 1);
});
