// #C983: the board's own text gives times in Mountain Time with the zone name, never UTC "Z" (the follow-up to #C979, which
// refuses Z in agents' writes). Stored times stay ms; this only checks what is printed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mtTime, mtDayTime, TEAM_TZ } from "../worker/team-time.mjs";
import { heldWakes, stalledWaits, STALL_AFTER_MS, zTimeIn } from "../worker/board-rules.mjs";
import { headerHtml } from "../worker/page-header.mjs";
import { signalText } from "../collector/rework.mjs";
import { setDoorSession, guardedInbox } from "../worker/board-store.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";

const DOOR_A = "local_aaaaaaaa-1111-2222-3333-444444444444", DOOR_B = "local_bbbbbbbb-1111-2222-3333-444444444444";

const Z_TIME = /\d{1,2}:\d{2}(:\d{2})?\s?Z\b/;
// 2027-01-15 08:00 UTC is 1:00 am MST (winter, UTC-7).
const T = Date.UTC(2027, 0, 15, 8, 0);
const H = 3600e3;

test("the formatters: 12-hour time, lower-case am/pm, the zone name; a day when asked; '?' for no time", () => {
  assert.equal(TEAM_TZ, "America/Boise", "the Mountain zone's rules, as collector/state.mjs SCHEDULE");
  assert.equal(mtTime(Date.UTC(2026, 10, 12, 3, 45)), "8:45 pm MT");
  assert.equal(mtTime(Date.UTC(2026, 10, 12, 19, 0)), "12:00 pm MT");
  assert.equal(mtTime(Date.UTC(2026, 10, 12, 7, 5)), "12:05 am MT");
  assert.equal(mtDayTime(Date.UTC(2026, 10, 12, 3, 45)), "Nov 11 8:45 pm MT", "the Mountain day, not the UTC one");
  for (const bad of [NaN, Infinity, 9e15, undefined, null]) { assert.equal(mtTime(bad), "?"); assert.equal(mtDayTime(bad), "?"); }
});

test("summer time: both 2026 change days format right (Mar 8 at 2 am, Nov 1 at 2 am)", () => {
  assert.equal(mtDayTime(Date.UTC(2026, 2, 8, 8, 59)), "Mar 8 1:59 am MT", "last minute of winter time (UTC-7)");
  assert.equal(mtDayTime(Date.UTC(2026, 2, 8, 9, 0)), "Mar 8 3:00 am MT", "2 am jumps to 3 am (UTC-6)");
  assert.equal(mtDayTime(Date.UTC(2026, 10, 1, 7, 59)), "Nov 1 1:59 am MT", "summer time, UTC-6");
  assert.equal(mtDayTime(Date.UTC(2026, 10, 1, 8, 0)), "Nov 1 1:00 am MT", "1 am again, UTC-7");
  assert.equal(mtTime(Date.UTC(2026, 6, 4, 18, 0)), "12:00 pm MT", "July: UTC-6");
});

test("a held line names its end and its start in Mountain Time, no Z", () => {
  const cards = [
    { id: "a", num: 1, waiting_on: "the deploy", check_at: T - H, updated_at: T - 9 * H },
    { id: "b", num: 2, blocked_reason: "someone", updated_at: T - 3 * H },
  ];
  const lines = heldWakes({ now: T, cards, endsPassed: new Set() }).map((w) => w.reason);
  assert.deepEqual(lines, [
    "#C1 held on the deploy, its end has passed: lift or renew (end Jan 15 12:00 am MT)",
    "#C2 held on someone, no end set after 2 h: lift it or give it an end (held since Jan 14 10:00 pm MT)",
  ]);
  for (const l of lines) assert.doesNotMatch(l, Z_TIME);
});

// Checker's F1 on 7ad6140: one behaviour test per site, each failing if the site printed the raw number instead of the Mountain time.
test("a hold_end left open 2 h says since when in Mountain Time", () => {
  const cards = [{ id: "e", num: 7, hold_end: "#T1", held_at: T - 3 * H, updated_at: T - 3 * H }];
  const lines = heldWakes({ now: T, cards, endsPassed: new Set() }).map((w) => w.reason);
  assert.deepEqual(lines, ["#C7 waits on #T1, whose end has not come after 2 h: close it or lift the hold (since Jan 14 10:00 pm MT)"]);
});

test("the door's mismatch refusal says when its session was last set, in Mountain Time", async () => {
  const db = makeDb();
  await setDoorSession(db, T, "Manager", DOOR_A);
  const r = await guardedInbox(db, T + 2000, DOOR_B);
  assert.match(r.refused.detail, /\(the door's session was last set by Manager at Jan 15 1:00 am MT\)$/);
  assert.doesNotMatch(r.refused.detail, new RegExp(String(T)));
});

test("a door replacement notice gives its time in Mountain Time", async () => {
  const db = makeDb();
  await setDoorSession(db, T, "Manager", DOOR_A);
  await setDoorSession(db, T + H, "owner", DOOR_B);
  const got = await guardedInbox(db, T + 2 * H, DOOR_B);
  assert.deepEqual(got.notices, ["door session replaced by owner at Jan 15 2:00 am MT"]);
});

test("a stall reason gives the idle time in Mountain Time, no Z", () => {
  const card = { id: "c", num: 5, owner_role: "Boardsmith" };
  const out = stalledWaits({ now: T + STALL_AFTER_MS * 2, cards: [card], evidence: { c: { lit: ["checker"] } }, openAskCards: new Set(), phaseStart: new Map([["c|checker", T]]), agents: { Checker: { state: "idle", since: T } } });
  assert.deepEqual(out.map((s) => s.reason), ["#C5 waits at Checker 15 min, Checker idle since 1:00 am MT"]);
});

test("the Probe chip says 'silent since' in Mountain Time", () => {
  const html = headerHtml({ live: null, probe: { state: "silent", since: Date.UTC(2026, 10, 12, 3, 45) } });
  assert.match(html, /silent since 8:45 pm MT/);
  assert.doesNotMatch(html, Z_TIME);
});

test("the rework signal says Mountain Time, not UTC", () => {
  const s = signalText({ kind: "findings", who: "Designer", at: Date.UTC(2026, 10, 12, 20, 52) }, (x) => x);
  assert.equal(s, "FINDINGS by Designer at 1:52 pm MT");
  assert.equal(zTimeIn(s), null, "#C979's own check finds no Z time in it");
});

test("no board source prints a time with toISOString(...)Z or a UTC label any more", () => {
  const files = ["worker/board-rules.mjs", "worker/page-header.mjs", "worker/board-store.mjs", "collector/nudges.mjs", "collector/prompt-alarm.mjs", "collector/rework.mjs", "page/board.template.html"];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /toISOString\(\)\.slice\(\s*(0|11)\s*,\s*16\s*\)[^;\n]{0,40}Z/, f);
    assert.doesNotMatch(src, /\} UTC`/, f);
  }
});
