// #C1005 (b): the prompt watch as a probe reading. A role stopped on a call the owner must answer for 30+ min (evidence.stuck, kind "user") is one line in
// Manager's batch (a stall row, told once) and one phone push, both by day only and sent at the first run after 7 am; a step-stuck role, a short stop and a
// stale reading are neither. The words carry a role and a time, never a prompt's text.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { wakeAsk, takeInbox } from "../worker/board-store.mjs";
import { promptDue, promptWakes, pushesDue, pushWords, PROMPT_MIN } from "../worker/push-rules.mjs";
import { pushRun } from "../worker/push-store.mjs";

const MIN = 60e3;
const NOON = Date.UTC(2026, 10, 12, 19, 0), AT_2300 = Date.UTC(2026, 10, 13, 6, 0), AT_0700 = Date.UTC(2026, 10, 13, 14, 0);
const user = (since) => ({ Builder: { kind: "user", card: "a-card", since }, Checker: { kind: "step", card: null, since } });
const put = (db, key, value, at) => db.prepare("INSERT OR REPLACE INTO evidence (key, value, read_at) VALUES (?, ?, ?)").bind(key, JSON.stringify(value), at).run();
const jwkSecret = async () => JSON.stringify({ ...(await crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])).privateKey)), sub: "https://board.example.invalid" });

test("promptWakes / promptDue: user kind only, from 30 min, by day, once per stop", () => {
  const at = (m) => user(NOON - m * MIN);
  assert.equal(PROMPT_MIN, 30);
  assert.equal(promptWakes({ stuck: at(29), now: NOON }).length, 0, "29 min is not yet");
  const rows = promptWakes({ stuck: at(30), now: NOON });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].card_id, `prompt:Builder:${NOON - 30 * MIN}`);
  assert.match(rows[0].reason, /^Builder has waited on a prompt in its session since .* MT \(30\+ min\): open it in the Claude app and answer it$/);
  assert.equal(promptDue({ stuck: at(45), sent: new Set([`ship:prompt:Builder:${NOON - 45 * MIN}`]), now: NOON }).length, 0, "told once");
  assert.equal(promptWakes({ stuck: at(90), now: AT_2300 }).length, 0, "held at night");
  assert.equal(promptWakes({ stuck: at(90), now: AT_0700 }).length, 1, "7:00: sent");
  for (const bad of [null, [], { Builder: { kind: "user", since: "x" } }, { "no good!": { kind: "user", since: 1 } }]) assert.deepEqual(promptWakes({ stuck: bad, now: NOON }), []);
});

// Checker 2's F2 on b39df027: a prompt row inserted at 9:50 pm must survive the 10 pm night hold while the role is still stopped, so the first run after
// 7 am finds it (the insert is ignored for a retired row) and Manager is told once; a stop that ended in the night is gone by then.
test("a prompt row pending at 9:50 pm survives the night while the role is still stopped, and is told once after 7 am", async () => {
  const AT_2150 = Date.UTC(2026, 10, 13, 4, 50), AT_2201 = Date.UTC(2026, 10, 13, 5, 1);
  const since = AT_2150 - 90 * MIN, lines = (inbox) => inbox.stalls.filter((s) => /waited on a prompt/.test(s.reason ?? ""));
  const db = makeDb();
  await put(db, "board", { boardId: "flight-board", at: AT_2150 }, AT_2150);
  await put(db, "stuck", user(since), AT_2150);
  await wakeAsk(db, AT_2150);
  await put(db, "stuck", user(since), AT_2201);
  await wakeAsk(db, AT_2201);
  await put(db, "stuck", user(since), AT_0700);
  await wakeAsk(db, AT_0700);
  assert.equal(lines(await takeInbox(db, AT_0700 + MIN)).length, 1, "still pending after the night");
  await wakeAsk(db, AT_0700 + 2 * MIN);
  assert.equal(lines(await takeInbox(db, AT_0700 + 3 * MIN)).length, 0, "told once");
  // The role answered in the night (the reading no longer shows the stop): the row is over, nothing is told at 7.
  const db2 = makeDb();
  await put(db2, "board", { boardId: "flight-board", at: AT_2150 }, AT_2150);
  await put(db2, "stuck", user(since), AT_2150);
  await wakeAsk(db2, AT_2150);
  await put(db2, "stuck", {}, AT_2201);
  await wakeAsk(db2, AT_2201);
  await put(db2, "stuck", {}, AT_0700);
  await wakeAsk(db2, AT_0700);
  assert.equal(lines(await takeInbox(db2, AT_0700 + MIN)).length, 0, "a stop that ended is not told");
});

test("the push words: a role and no text; a night with only a prompt pushes nothing", () => {
  const w = JSON.parse(pushWords([], [], null, null, [], [{ role: "Builder", since: NOON }, { role: "Checker", since: NOON }]));
  assert.match(w.body, /^Builder, Checker are waiting on a prompt in their sessions: open each in the Claude app and answer\.$/);
  assert.equal(pushesDue({ asks: [], ships: [], sent: new Set(), now: AT_2300, stuck: user(AT_2300 - 90 * MIN) }).payload, null);
});

test("Manager's batch: one stall line per stop, told once, gone when the stop is over; the push marks it sent", async () => {
  const db = makeDb(), env = { PUSH_VAPID_JWK: await jwkSecret() };
  const since = NOON - 40 * MIN;
  await put(db, "board", { boardId: "flight-board", at: NOON }, NOON);
  await put(db, "stuck", user(since), NOON);
  await wakeAsk(db, NOON);
  const first = (await takeInbox(db, NOON + MIN)).stalls.filter((s) => s.card_id?.startsWith?.("prompt:") || /waited on a prompt/.test(s.reason ?? ""));
  assert.equal(first.length, 1, JSON.stringify(first));
  assert.match(first[0].reason, /Builder has waited on a prompt/);
  await put(db, "stuck", user(since), NOON + 2 * MIN);
  await wakeAsk(db, NOON + 2 * MIN);
  const again = (await takeInbox(db, NOON + 3 * MIN)).stalls.filter((s) => /waited on a prompt/.test(s.reason ?? ""));
  assert.equal(again.length, 0, "told once");
  await pushRun(db, NOON + 4 * MIN, env, async () => assert.fail("no device, no fetch"));
  assert.ok((await db.prepare("SELECT ref FROM push_sent").all()).results.some((r) => r.ref === `prompt:Builder:${since}`));
  // A stale reading (the probe wrote it over 15 min ago) makes no line.
  const db2 = makeDb();
  await put(db2, "stuck", user(NOON - 90 * MIN), NOON - 20 * MIN);
  await wakeAsk(db2, NOON);
  assert.equal((await takeInbox(db2, NOON + MIN)).stalls.filter((s) => /waited on a prompt/.test(s.reason ?? "")).length, 0);
});
