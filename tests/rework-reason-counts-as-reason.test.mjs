// #C1120 (11-16, #C1104, #C1105, #C1108): after a rework reason was attached, "is slow with no reason" came about 30 s later and Manager had to write a filler note.
// Attaching a reason clears the card's rework flag, so the reason's own time (rework_history) is what must count as the slow line's reason.
import test from "node:test";
import assert from "node:assert/strict";
import { slowWakes, slowLine, reworkReasonLine, SHIP_SLOW_MS, NOTE_FRESH_MS } from "../worker/board-rules.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard, writeEvidence } from "../worker/board-store.mjs";
import { wakeAsk } from "./helpers/beating-store.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const base = { id: "c", num: 1104, owner_role: "Boardsmith", paused: 0, dropped: 0 };
// After the reason: the store has cleared the flag, so the evidence carries no `rework`.
const cleared = { lit: ["ship"], phase: "ship", headSha12: "aaaaaaaaaaaa", signed: [], onMain: false };
const slow = (fields, reasonAt, ev = cleared) => slowWakes({ now: T, cards: [{ ...base, ...fields }], evidence: { c: ev }, openAskCards: new Set(), phaseStart: new Map([["c|ship", T - SHIP_SLOW_MS - MIN]]), medians: {}, endsPassed: new Set(), reasonAt }).map((s) => s.reason);

test("a rework reason attached 5 minutes ago raises no slow line, though the flag is already cleared", () => {
  assert.deepEqual(slow({ rework_reason: "review findings" }, new Map([["c", T - 5 * MIN]])), []);
  assert.deepEqual(slow({ rework_reason: "review findings" }, { c: T - 5 * MIN }), [], "a plain object reads the same");
});

test("a reason attached 2 hours ago with no newer note raises the slow line; the hour edge is exclusive", () => {
  assert.deepEqual(slow({ rework_reason: "review findings" }, new Map([["c", T - 2 * 60 * MIN]])), [slowLine(1104)]);
  assert.deepEqual(slow({ rework_reason: "review findings" }, new Map([["c", T - NOTE_FRESH_MS + 1]])), []);
  assert.deepEqual(slow({ rework_reason: "review findings" }, new Map([["c", T - NOTE_FRESH_MS]])), [slowLine(1104)]);
});

test("a fresh next_note still counts, and with neither a reason time nor a note the line stays", () => {
  assert.deepEqual(slow({ next_note: "fixing", moved_at: T - 5 * MIN }, new Map()), []);
  assert.deepEqual(slow({ rework_reason: "review findings" }, new Map()), [slowLine(1104)], "no reason time, no claim of freshness");
  assert.deepEqual(slow({ rework_reason: "review findings" }, undefined), [slowLine(1104)]);
});

test("a time in the future is not believed, and a card with no reason text on it is not covered by an old row", () => {
  assert.deepEqual(slow({ rework_reason: "review findings" }, new Map([["c", T + 5 * MIN]])), [slowLine(1104)]);
  assert.deepEqual(slow({}, new Map([["c", T - 5 * MIN]])), [slowLine(1104)]);
  assert.deepEqual(slow({ rework_reason: "" }, new Map([["c", T - 5 * MIN]])), [slowLine(1104)]);
});

test("the store: the rework line, then the reason attached, then 30 s later no slow line; two hours on with no newer note it comes back", async () => {
  const A = "aaaaaaaaaaaa", B = "bbbbbbbbbbbb", rd = (phase, extra = {}) => ({ lit: [phase], phase, headSha12: A, signed: [], onMain: false, ...extra });
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "c", title: "A card", owner_role: "Boardsmith" });
  await writeEvidence(db, T, "probe", "cards.c", rd("checker", { findings: ["checker"] }));
  await writeEvidence(db, T + 1, "probe", "cards.c", rd("ship", { headSha12: B }));
  // #C1406 restated: a probe no longer sets the flag for a push read at ship (the card is back in review), so the flag an older reading left is seeded here.
  const row = JSON.parse((await db.prepare("SELECT value FROM evidence WHERE key = 'cards.c'").first()).value);
  await db.prepare("UPDATE evidence SET value = ? WHERE key = 'cards.c'").bind(JSON.stringify({ ...row, rework: true })).run();
  const num = (await db.prepare("SELECT num FROM cards WHERE id = 'c'").first()).num;
  const attached = T + SHIP_SLOW_MS + 4 * MIN;
  await wakeAsk(db, attached - MIN);
  assert.ok((await db.prepare("SELECT reason FROM stall_wakes WHERE card_id = 'c'").all()).results.some((r) => r.reason === reworkReasonLine(num, "Boardsmith")), "the rework line is there first");
  assert.equal((await updateCard(db, attached, "Boardsmith", { id: "c", rework_reason: "review findings" })).ok, true);
  await wakeAsk(db, attached + 30e3);
  const rows = async () => (await db.prepare("SELECT reason FROM stall_wakes WHERE card_id = 'c'").all()).results.map((r) => r.reason);
  assert.deepEqual(await rows(), [], "no rework line and no slow line 30 s after the reason");
  await wakeAsk(db, attached + 2 * 60 * MIN);
  assert.deepEqual(await rows(), [slowLine(num)], "two hours later, with no newer note, the slow line is back");
});

test("the store: a card sent back twice is covered by its NEWEST reason, not the first one", async () => {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "c", title: "A card", owner_role: "Boardsmith" });
  await writeEvidence(db, T, "probe", "cards.c", { lit: ["ship"], phase: "ship", headSha12: "aaaaaaaaaaaa", signed: [], onMain: false });
  const num = (await db.prepare("SELECT num FROM cards WHERE id = 'c'").first()).num;
  const second = T + 4 * 60 * MIN;
  assert.equal((await updateCard(db, T + 10 * MIN, "Boardsmith", { id: "c", rework_reason: "review findings" })).ok, true);
  assert.equal((await updateCard(db, second, "Boardsmith", { id: "c", rework_reason: "review findings" })).ok, true);
  await wakeAsk(db, second + 5 * MIN);
  assert.deepEqual((await db.prepare("SELECT reason FROM stall_wakes WHERE card_id = 'c'").all()).results, [], "the second reason, 5 minutes old, covers it");
  await wakeAsk(db, second + 2 * 60 * MIN);
  assert.deepEqual((await db.prepare("SELECT reason FROM stall_wakes WHERE card_id = 'c'").all()).results.map((r) => r.reason), [slowLine(num)]);
});
