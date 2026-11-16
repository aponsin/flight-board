// #C1078 (11-13: the quota hit 100% and Manager was woken once per queued Boardsmith card, "idle, N queued, next #C...", each wake a turn that could
// change nothing): while the session's fresh reading of the week (the week_usage tool) is 98% or more, the idle-agent stall lines are held until the
// reset and ONE line goes to Manager. A stale or missing reading, or one under 98, holds nothing. Other stalls (an ask left open, a landed pack) go on.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, writeWeekUsage, wakeAsk, takeInbox } from "../worker/board-store.mjs";
import { quotaHold, QUOTA_OUT_PCT } from "../worker/board-rules.mjs";
import { mtDayTime } from "../worker/team-time.mjs";

const T = 1_800_000_000_000, MIN = 60_000, HOUR = 60 * MIN;
const RESET = T + 40 * HOUR;

// Boardsmith is idle with `n` queued cards (nothing pushed), as on 11-13.
async function world(n = 3) {
  const db = makeDb();
  for (let k = 1; k <= n; k++) await createCard(db, T, "Manager", { id: `card-${k}`, title: `Card ${k}`, owner_role: "Boardsmith" });
  await writeEvidence(db, T, "probe", "agents", { Boardsmith: { state: "idle", tool: null, card: null, since: T } });
  return db;
}
const week = (db, now, percent, resets = RESET) => writeWeekUsage(db, now, "Manager", { percent, resets_at: new Date(resets).toISOString() });
// The probe rewrites every card's reading each minute; the tests jump hours, so touch the readings (#C927 is not what these test).
const taken = async (db, now) => {
  await db.prepare("UPDATE evidence SET read_at = ? WHERE key = 'agents' OR key LIKE 'cards.%'").bind(now).run();
  await wakeAsk(db, now);
  return (await takeInbox(db, now + 1000)).stalls.map((s) => s.reason);
};

test("control: with no week reading, an idle agent with queued cards wakes Manager once, as before", async () => {
  const db = await world();
  const reasons = await taken(db, T + 20 * MIN);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /^Boardsmith idle since .*, 3 queued, next #C1$/);
});

test("at 98% or more, the idle-agent line is held and one line goes to Manager, with the reset time and no percent", async () => {
  const db = await world();
  await week(db, T + 19 * MIN, 100);
  const reasons = await taken(db, T + 20 * MIN);
  assert.deepEqual(reasons, [`The week's quota is used up (${QUOTA_OUT_PCT}% or more): idle-agent stall lines are held until it resets at ${mtDayTime(RESET)}`]);
});

test("the same spell sends nothing more: a later reading of 99 then 100, and more queued cards, add no wake", async () => {
  const db = await world();
  await week(db, T + 19 * MIN, 98);
  assert.equal((await taken(db, T + 20 * MIN)).length, 1);
  await week(db, T + 40 * MIN, 99);
  assert.deepEqual(await taken(db, T + 41 * MIN), []);
  await createCard(db, T + 45 * MIN, "Manager", { id: "card-9", title: "Card 9", owner_role: "Boardsmith" });
  await week(db, T + 50 * MIN, 100);
  assert.deepEqual(await taken(db, T + 51 * MIN), [], "a new queued card is no new wake while the quota is out");
});

test("97% holds nothing", async () => {
  const db = await world();
  await week(db, T + 19 * MIN, 97);
  const reasons = await taken(db, T + 20 * MIN);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /idle since/);
});

test("a stale reading (over an hour old) or one whose week has reset holds nothing", async () => {
  const db = await world();
  await week(db, T, 100);
  const reasons = await taken(db, T + 2 * HOUR);
  assert.equal(reasons.length, 1, "written 2 h ago: unknown, no hold");
  assert.match(reasons[0], /idle since/);
  const db2 = await world();
  await week(db2, T, 100, T + 3 * HOUR);
  await db2.prepare("UPDATE evidence SET read_at = ? WHERE key = 'usage.week'").bind(T + 4 * HOUR).run();
  const again = await taken(db2, T + 4 * HOUR + MIN);
  assert.equal(again.length, 1, "the week it read has reset: no hold");
  assert.match(again[0], /idle since/);
});

test("after the reset (a reading under 98), the idle line is sent again", async () => {
  const db = await world();
  await week(db, T + 19 * MIN, 100);
  await taken(db, T + 20 * MIN);
  await week(db, T + 41 * HOUR, 2, T + 41 * HOUR + 7 * 24 * HOUR - HOUR);
  const reasons = await taken(db, T + 41 * HOUR + MIN);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /^Boardsmith idle since .*, 3 queued, next #C1$/);
});

test("quotaHold: only a fresh reading at the ceiling or over holds; the line is one row per reset time", () => {
  const stalls = [{ card_id: "a", reason: "x" }];
  const fresh = (pct, resetsAt = RESET) => ({ state: "fresh", pct, resetsAt, readAt: T });
  assert.deepEqual(quotaHold({ now: T, week: fresh(97), stalls }), { stalls, line: [] });
  assert.deepEqual(quotaHold({ now: T, week: { state: "stale" }, stalls }), { stalls, line: [] });
  assert.deepEqual(quotaHold({ now: T, week: { state: "none" }, stalls }), { stalls, line: [] });
  assert.deepEqual(quotaHold({ now: T, week: fresh(100, T - 1), stalls }), { stalls, line: [] }, "a reset time in the past holds nothing");
  const held = quotaHold({ now: T, week: fresh(98), stalls });
  assert.deepEqual(held.stalls, []);
  assert.equal(held.line.length, 1);
  assert.equal(held.line[0].card_id, `quota-out:${RESET}`);
  assert.deepEqual(quotaHold({ now: T, week: fresh(100), stalls: [] }).line, held.line, "the same line whatever the percent or the stalls held");
});
