// #C1005: the stuck-agent watchdog becomes probe readings: a role stuck on a step (evidence.stuck, kind "step") is pushed to the phone once per session and per
// "since", held from 10 pm to 7 am MT and sent at the first run after 7 am; a user-kind stuck is not this push; a stale or missing reading pushes nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { stuckDue, isNight, pushesDue, pushWords } from "../worker/push-rules.mjs";
import { pushRun } from "../worker/push-store.mjs";
import { mtHour } from "../worker/team-time.mjs";

const MIN = 60e3;
// MT is UTC-7 in November: 2026-11-12 12:00 MT is 19:00 UTC.
const NOON = Date.UTC(2026, 10, 12, 19, 0), AT_2259 = Date.UTC(2026, 10, 13, 5, 59), AT_2300 = Date.UTC(2026, 10, 13, 6, 0), AT_0659 = Date.UTC(2026, 10, 13, 13, 59), AT_0700 = Date.UTC(2026, 10, 13, 14, 0);
const stuck = (since) => ({ Builder: { kind: "step", card: "a-card", since }, Checker: { kind: "user", card: null, since } });

test("the hour in MT, and the night is 10 pm to 7 am", () => {
  assert.equal(mtHour(NOON), 12);
  assert.equal(mtHour(AT_2259), 22);
  assert.equal(mtHour(AT_2300), 23);
  assert.equal(mtHour(Date.UTC(2026, 10, 13, 7, 30)), 0, "midnight hour is 0, never 24");
  assert.equal(isNight(NOON), false);
  assert.equal(isNight(AT_2259), true, "22:59 is night");
  assert.equal(isNight(AT_2300), true);
  assert.equal(isNight(AT_0659), true, "6:59 is night");
  assert.equal(isNight(AT_0700), false, "7:00 is not");
  assert.equal(isNight(Date.UTC(2026, 10, 13, 4, 59)), false, "21:59 MT is day");
  assert.equal(isNight(Date.UTC(2026, 10, 13, 5, 0)), true, "22:00 MT is night");
});

test("stuckDue: a step-stuck role once per since; a user kind, a told one and a bad row are not due", () => {
  const sent = new Set();
  assert.deepEqual(stuckDue({ stuck: stuck(NOON - 40 * MIN), sent, now: NOON }), [{ role: "Builder", since: NOON - 40 * MIN }]);
  sent.add(`ship:stuck:Builder:${NOON - 40 * MIN}`);
  assert.deepEqual(stuckDue({ stuck: stuck(NOON - 40 * MIN), sent, now: NOON }), [], "told once for this since");
  assert.equal(stuckDue({ stuck: stuck(NOON - 20 * MIN), sent, now: NOON }).length, 1, "a new since is told again");
  for (const bad of [null, [], "x", { Builder: null }, { Builder: { kind: "step", since: "soon" } }, { "bad role!": { kind: "step", since: NOON } }]) assert.deepEqual(stuckDue({ stuck: bad, sent: new Set(), now: NOON }), [], JSON.stringify(bad));
});

test("the night holds it and the first run after 7 am sends it; nothing else is held", () => {
  const since = NOON - 60 * MIN;
  assert.deepEqual(stuckDue({ stuck: stuck(since), sent: new Set(), now: AT_2300 }), []);
  assert.deepEqual(stuckDue({ stuck: stuck(since), sent: new Set(), now: AT_0659 }), []);
  assert.equal(stuckDue({ stuck: stuck(since), sent: new Set(), now: AT_0700 }).length, 1);
  const night = pushesDue({ asks: [], ships: [], sent: new Set(), now: AT_2300, stuck: stuck(since) });
  assert.equal(night.payload, null, "a night with only a stuck role pushes nothing");
});

test("the push says the role and a time, never a card or a text", () => {
  const w = JSON.parse(pushWords([], [], null, null, [{ role: "Builder", since: NOON }, { role: "Checker 2", since: NOON }]));
  assert.match(w.body, /Builder \(quiet since .* MT\), Checker 2 \(quiet since .* MT\) look stuck mid-turn/);
  assert.doesNotMatch(w.body, /a-card/);
});

const put = (db, key, value, at) => db.prepare("INSERT OR REPLACE INTO evidence (key, value, read_at) VALUES (?, ?, ?)").bind(key, JSON.stringify(value), at).run();
const sentRefs = async (db) => (await db.prepare("SELECT ref FROM push_sent ORDER BY ref").all()).results.map((r) => r.ref);
const jwkSecret = async () => JSON.stringify({ ...(await crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])).privateKey)), sub: "https://board.example.invalid" });

test("the cron run: one push per session and since, held at night and sent after 7, stale readings push nothing", async () => {
  const db = makeDb(), env = { PUSH_VAPID_JWK: await jwkSecret() };
  const beat = (at) => put(db, "board", { boardId: "flight-board", at }, at); // the probe's heartbeat, so no silence push is due
  const since = NOON - 40 * MIN, ref = `stuck:Builder:${since}`;
  await beat(NOON); await put(db, "stuck", stuck(since), NOON);
  await pushRun(db, NOON, env, async () => assert.fail("no device, no fetch"));
  assert.deepEqual((await sentRefs(db)).filter((r) => r.startsWith("stuck:")), [ref], "noon: told");
  await beat(NOON + MIN); await put(db, "stuck", stuck(since), NOON + MIN);
  await pushRun(db, NOON + MIN, env, async () => assert.fail("told once"));
  assert.equal((await sentRefs(db)).filter((r) => r.startsWith("stuck:")).length, 1, "the same since is not told twice");

  // A new stretch (a new since) held by the night, sent at the first run after 7 am.
  const since2 = AT_2300 - 90 * MIN;
  await beat(AT_2300); await put(db, "stuck", stuck(since2), AT_2300);
  await pushRun(db, AT_2300, env, async () => assert.fail("night"));
  assert.ok(!(await sentRefs(db)).includes(`stuck:Builder:${since2}`), "held at night");
  await beat(AT_0659); await put(db, "stuck", stuck(since2), AT_0659);
  await pushRun(db, AT_0659, env, async () => assert.fail("6:59 is night"));
  assert.ok(!(await sentRefs(db)).includes(`stuck:Builder:${since2}`));
  await beat(AT_0700); await put(db, "stuck", stuck(since2), AT_0700);
  await pushRun(db, AT_0700, env, async () => assert.fail("no device, no fetch"));
  assert.ok((await sentRefs(db)).includes(`stuck:Builder:${since2}`), "7:00: sent");
  assert.match((await db.prepare("SELECT result FROM push_state WHERE id = 1").first()).result, /1 stuck/);

  // A stale reading (the probe wrote it over 15 min ago) pushes nothing.
  const db2 = makeDb();
  await put(db2, "board", { boardId: "flight-board", at: NOON }, NOON);
  await put(db2, "stuck", stuck(NOON - 70 * MIN), NOON - 20 * MIN);
  await pushRun(db2, NOON, env, async () => assert.fail("stale"));
  assert.deepEqual(await sentRefs(db2), []);
});
