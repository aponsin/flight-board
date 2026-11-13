// #C1007: the dispatch wakes Ops once a day from 7 am MT for its daily check, with no card queued; Steward stays quiet with nothing queued.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun, dailyCheck, dailyCheckId, DAILY_CHECK_HOUR } from "../collector/store-dispatch.mjs";
import { dispatchLine, dispatchPending, DISPATCH_FILE, DISPATCH_STATE_FILE } from "../gate/reset.mjs";
import { mtDate, mtHour } from "../worker/team-time.mjs";

const MIN = 60e3, HOUR = 60 * MIN;
// 7:00 am MT on 2026-11-13 (MST, UTC-7).
const SEVEN = Date.UTC(2026, 10, 13, 14, 0);
const ROSTER = ["Manager", "Builder", "Ops", "Steward"], LEAD = "Manager";
const dir = () => mkdtempSync(join(tmpdir(), "c1007-"));
const read = (d, f) => JSON.parse(readFileSync(join(d, f), "utf8"));
const idle = (at, ago = 20 * MIN) => ({ state: "idle", since: at - ago, lastActivityAt: at - ago, card: null });
// A view with no cards: the agents reading only. `ops`: Ops's state and when it last changed.
const view = (at, ops = idle(at)) => ({
  cards: [], asks: [], live: { state: "live", version: "v1.209.13", age: 1000 },
  evidence: { agents: { readAt: at - 10_000, value: { Ops: ops, Manager: idle(at, MIN), Steward: idle(at), Builder: idle(at) } } },
});
const run = (d, at, ops) => dispatchRun(view(at, ops), { dir: d, roster: ROSTER, lead: LEAD, now: at });
const items = (r, role) => r.items.filter((i) => i.role === role);

test("the MT day and hour the turn is built from", () => {
  assert.equal(mtDate(SEVEN), "2026-11-13");
  assert.equal(mtHour(SEVEN), 7);
  assert.equal(mtDate(SEVEN - MIN), "2026-11-13", "6:59 am is still the same MT day");
  assert.equal(mtHour(SEVEN - MIN), 6);
  assert.equal(mtDate(Date.UTC(2026, 10, 14, 6, 59)), "2026-11-13", "11:59 pm MT is not yet the next day");
  assert.equal(mtDate(NaN), null);
  assert.equal(dailyCheckId("2026-11-13"), "ops-daily-2026-11-13");
  for (const bad of [null, "", "2026-1-3", "2026-11-13; rm", 5]) assert.equal(dailyCheckId(bad), null, String(bad));
  assert.equal(DAILY_CHECK_HOUR, 7);
});

test("Ops is woken once a day at 7 am MT with nothing queued, and again the next day", () => {
  const d = dir();
  // Before the hour: nobody.
  assert.deepEqual(items(run(d, SEVEN - 30 * MIN), "Ops"), []);
  // At 7: one item, its line names the day, Ops's watch picks it up, and the wake is recorded.
  const r = run(d, SEVEN);
  assert.equal(items(r, "Ops").length, 1);
  assert.equal(items(r, "Ops")[0].card, "ops-daily-2026-11-13");
  assert.match(dispatchLine(items(r, "Ops")[0]), /^DISPATCH ops-daily-2026-11-13: it waits on you \(Ops\)/);
  assert.equal(dispatchPending(read(d, DISPATCH_FILE), null, { role: "Ops", level: 1 }).length, 1);
  assert.equal(read(d, DISPATCH_STATE_FILE).daily.wokenAt, SEVEN);
  // Ops still idle a minute later (its watch may not have printed): the same item, the same since.
  const r2 = run(d, SEVEN + MIN);
  assert.equal(items(r2, "Ops").length, 1); assert.equal(items(r2, "Ops")[0].since, items(r, "Ops")[0].since);
  // Ops works, then goes idle: the day's check is done, no second wake that day.
  assert.deepEqual(items(run(d, SEVEN + 3 * MIN, { state: "working", since: SEVEN + 2 * MIN, lastActivityAt: SEVEN + 2 * MIN, card: null }), "Ops"), []);
  assert.deepEqual(items(run(d, SEVEN + 5 * HOUR, idle(SEVEN + 5 * HOUR, 4 * HOUR)), "Ops"), []);
  assert.equal(read(d, DISPATCH_STATE_FILE).daily.done, true);
  // The next day at 7 it comes again, even with no cards queued and nothing shipped.
  const next = SEVEN + 24 * HOUR;
  assert.deepEqual(items(run(d, next - 30 * MIN, idle(next - 30 * MIN)), "Ops"), [], "before 7 the next day");
  const r3 = run(d, next, idle(next));
  assert.equal(items(r3, "Ops").length, 1);
  assert.equal(items(r3, "Ops")[0].card, "ops-daily-2026-11-14");
});

test("a busy Ops is woken when it goes idle; the first run after the hour wakes it for that day; Ops off the roster gets no item", () => {
  const d = dir();
  assert.deepEqual(items(run(d, SEVEN, { state: "working", since: SEVEN - 5 * MIN, lastActivityAt: SEVEN - MIN, card: null }), "Ops"), [], "busy at 7");
  assert.equal(read(d, DISPATCH_STATE_FILE).daily.done, false, "the turn is not spent");
  assert.equal(items(run(d, SEVEN + 10 * MIN, idle(SEVEN + 10 * MIN, 5 * MIN)), "Ops").length, 1, "woken when idle");
  // Woken, then Ops worked and went idle again between two runs (never seen busy): idle since after the wake ends the day's turn.
  const d4 = dir();
  assert.equal(items(run(d4, SEVEN), "Ops").length, 1);
  assert.deepEqual(items(run(d4, SEVEN + 30 * MIN, idle(SEVEN + 30 * MIN, 20 * MIN)), "Ops"), []);
  assert.equal(read(d4, DISPATCH_STATE_FILE).daily.done, true);
  // Busy after the wake while its reading's `since` still lags (older than the wake): busy alone ends the turn.
  const d5 = dir();
  assert.equal(items(run(d5, SEVEN), "Ops").length, 1);
  assert.deepEqual(items(run(d5, SEVEN + 3 * MIN, { state: "working", since: SEVEN - 5 * MIN, lastActivityAt: SEVEN - 5 * MIN, card: null }), "Ops"), []);
  assert.equal(read(d5, DISPATCH_STATE_FILE).daily.done, true);
  // The first run ever, mid-afternoon: Ops is woken once for that day.
  const d2 = dir(), pm = SEVEN + 8 * HOUR;
  assert.equal(items(run(d2, pm), "Ops").length, 1);
  // Ops not on the roster: no item, and the turn waits.
  const d3 = dir();
  const r = dispatchRun(view(SEVEN), { dir: d3, roster: ["Manager"], lead: LEAD, now: SEVEN });
  assert.deepEqual(items(r, "Ops"), []); assert.equal(read(d3, DISPATCH_STATE_FILE).daily.wokenAt, undefined);
});

test("Steward is quiet with nothing queued: no item at 7 am, none all day", () => {
  const d = dir();
  for (const at of [SEVEN - HOUR, SEVEN, SEVEN + MIN, SEVEN + 6 * HOUR, SEVEN + 12 * HOUR]) assert.deepEqual(items(run(d, at), "Steward"), [], String(at));
});

test("dailyCheck unit: a bad time, a done day and a stale state change nothing", () => {
  assert.deepEqual(dailyCheck(null, { Ops: idle(SEVEN) }, NaN), { card: null, daily: null });
  const done = { daily: { date: "2026-11-13", done: true } };
  assert.equal(dailyCheck(done, { Ops: idle(SEVEN) }, SEVEN + HOUR).card, null);
  // A done flag from yesterday does not spend today.
  const old = dailyCheck({ daily: { date: "2026-11-12", done: true, wokenAt: SEVEN - 24 * HOUR } }, { Ops: idle(SEVEN) }, SEVEN);
  assert.equal(old.card?.id, "ops-daily-2026-11-13"); assert.equal(old.daily.date, "2026-11-13"); assert.equal(old.daily.done, false);
  // A malformed kept state is ignored.
  assert.equal(dailyCheck({ daily: [] }, { Ops: idle(SEVEN) }, SEVEN).card?.who, "Ops");
});
