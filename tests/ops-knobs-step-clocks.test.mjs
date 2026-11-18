// #C1106 part B: the step clocks' two times are settings the probe posts: stallAfterSec (a card waits this long at a phase with its agent idle) and
// shipSlowSec (Release's ship step is slow after this long). The store reads them at each run; the stall line's words follow the setting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard, createAsk, answerAsk, writeEvidence, writeWeekUsage, wakeAsk, wakeResult, readView, takeInbox, postMessage } from "../worker/board-store.mjs";
import { beat } from "./helpers/beating-store.mjs";
import { resolveKnobs, KNOBS } from "../worker/knobs.mjs";
import { JOBS } from "../worker/probe-jobs.mjs";
import { shouldSend, wakeLimits } from "../worker/wake-rules.mjs";
import { pushLimits } from "../worker/push-rules.mjs";
import { pushRun } from "../worker/push-store.mjs";
import { minWords, stallMsOf, shipSlowMsOf, STALL_AFTER_MS, SHIP_SLOW_MS, heldWakes, HOLD_NO_END_AFTER_MS } from "../worker/board-rules.mjs";

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

// The next three settings: how long a landed card may wait for its deploy pair, how old the probe's copy of a repository may be, and how recent a
// read-only role's post on its card's thread must be. Each through the store with a non-default posted value.
const postKnobs = (db, values) => writeEvidence(db, T, "probe", "knobs", { values, ignored: [] });

test("through the store: a posted landedUnbuiltSec moves the landed-without-a-pair line", async () => {
  const mk = async (landedUnbuiltSec) => {
    const db = makeDb();
    await createCard(db, T, "Manager", { id: "board-c", title: "A board card", owner_role: "Boardsmith", repo: "flight-board", batch: "g1" });
    await writeEvidence(db, T + 1, "probe", "cards.board-c", { lit: ["ship"], phase: "ship", headSha12: "aaaaaaaaaaaa", signed: ["checker", "security"], onMain: true });
    await writeEvidence(db, T + 1, "probe", "agents", { Boardsmith: { state: "working", tool: "Bash", card: "board-c", since: T } });
    if (landedUnbuiltSec !== undefined) await postKnobs(db, { landedUnbuiltSec });
    return db;
  };
  const has = async (db, at) => (await stallsAt(db, at)).some((s) => /no deploy pair holds/.test(s.reason));
  assert.equal(await has(await mk(), T + 40 * M), true, "default 30 min: raised at 40");
  assert.equal(await has(await mk(3600), T + 40 * M), false, "posted 60 min: not at 40");
  assert.equal(await has(await mk(3600), T + 70 * M), true, "posted 60 min: raised at 70");
});

test("through the store: a posted copyStaleSec moves the stale-copy line", async () => {
  const mk = async (copyStaleSec) => {
    const db = makeDb();
    await createCard(db, T, "Manager", { id: "c1", title: "A card", owner_role: "Boardsmith" });
    await writeEvidence(db, T, "probe", "cards.c1", { lit: ["build"], phase: "build", ci: "none" });
    await writeEvidence(db, T, "probe", "agents", { Boardsmith: { state: "working", tool: "Bash", card: "c1", since: T } });
    if (copyStaleSec !== undefined) await postKnobs(db, { copyStaleSec });
    return db;
  };
  const has = async (db, at) => (await stallsAt(db, at)).some((s) => /the probe's copy of/.test(s.reason));
  assert.equal(await has(await mk(), T + 2 * 60 * M), true, "default 1 h: 2 h old is stale");
  assert.equal(await has(await mk(14400), T + 2 * 60 * M), false, "posted 4 h: 2 h old is not");
  assert.equal(await has(await mk(14400), T + 5 * 60 * M), true, "posted 4 h: 5 h old is");
});

test("through the store: a posted postedFreshSec widens the window an owner's post counts in, and the line says the window", async () => {
  const mk = async (postedFreshSec) => {
    const db = makeDb();
    await createCard(db, T - 60 * M, "Manager", { id: "c884-look", title: "Look review", owner_role: "Designer" });
    await writeEvidence(db, T, "probe", "agents", { Designer: { state: "idle", tool: null, card: null, since: T } });
    if (postedFreshSec !== undefined) await postKnobs(db, { postedFreshSec });
    await postMessage(db, T + 5 * M, "Designer", { thread_id: "c884-look", body: "Reviewing the screens now." });
    return db;
  };
  const at = T + 100 * M; // the post is 95 minutes old
  const defaulted = await stallsAt(await mk(), at);
  assert.equal(defaulted.length, 1, "default 1 h: a 95-minute-old post no longer counts");
  assert.match(defaulted[0].reason, /nothing posted on its thread in the last hour,/);
  assert.equal((await stallsAt(await mk(7200), at)).length, 0, "posted 2 h: it still counts");
  const narrow = await stallsAt(await mk(600), T + 20 * M);
  assert.equal(narrow.length, 1, "posted 10 min: a 15-minute-old post does not");
  assert.match(narrow[0].reason, /nothing posted on its thread in the last 10 min,/);
});

// Slice three: how long a hold may have no end (the store gives a waiting_on this end when it is written, and a hold with none wakes Manager after it),
// and how long after its card moved on an answered Decision is closed by the board.
const holdRow = (db, id) => db.prepare("SELECT hold_until FROM cards WHERE id = ?").bind(id).first();

test("a posted holdNoEndSec is the end the store gives a waiting_on with none, on create and on update; the default is 2 h", async () => {
  const db = makeDb();
  await postKnobs(db, { holdNoEndSec: 3600 });
  assert.equal((await createCard(db, T, "Manager", { id: "h1", title: "H", waiting_on: "Checker" })).ok, true);
  assert.equal((await holdRow(db, "h1")).hold_until, T + 60 * M, "create: now + the posted 1 h");
  assert.equal((await createCard(db, T, "Manager", { id: "h2", title: "H2" })).ok, true);
  await updateCard(db, T + M, "Manager", { id: "h2", waiting_on: "Security" });
  assert.equal((await holdRow(db, "h2")).hold_until, T + M + 60 * M, "update: now + the posted 1 h");
  const plain = makeDb();
  await createCard(plain, T, "Manager", { id: "h1", title: "H", waiting_on: "Checker" });
  assert.equal((await holdRow(plain, "h1")).hold_until, T + 120 * M, "no setting: 2 h");
  const bad = makeDb();
  await postKnobs(bad, { holdNoEndSec: 5 });
  await createCard(bad, T, "Manager", { id: "h1", title: "H", waiting_on: "Checker" });
  assert.equal((await holdRow(bad, "h1")).hold_until, T + 120 * M, "out of bounds: the default");
});

test("the hold-with-no-end line says the time it waited: 2 h at the default, 3 h at 10800 s, 90 min at 5400 s", () => {
  const card = { id: "c1", num: 1, owner_role: "Boardsmith", waiting_on: "Checker", held_at: T };
  const at = (holdMs, now) => heldWakes({ now, cards: [card], endsPassed: new Set(), holdMs }).map((r) => r.reason);
  assert.equal(at(HOLD_NO_END_AFTER_MS, T + 119 * M).length, 0);
  assert.match(at(HOLD_NO_END_AFTER_MS, T + 120 * M)[0], /no end set after 2 h:/);
  assert.equal(at(180 * M, T + 150 * M).length, 0, "posted 3 h: not at 2 h 30");
  assert.match(at(180 * M, T + 180 * M)[0], /no end set after 3 h:/);
  assert.match(at(90 * M, T + 90 * M)[0], /no end set after 90 min:/);
});

test("through the store: a legacy hold with no end wakes Manager after the posted holdNoEndSec, in its words", async () => {
  const mk = async (holdNoEndSec) => {
    const db = makeDb();
    if (holdNoEndSec !== undefined) await postKnobs(db, { holdNoEndSec });
    await createCard(db, T, "Manager", { id: "c1", title: "C", waiting_on: "Checker" });
    await db.prepare("UPDATE cards SET hold_until = NULL, held_at = ? WHERE id = 'c1'").bind(T).run(); // a hold from before the store gave every waiting_on an end
    return db;
  };
  const lines = async (db, at) => (await stallsAt(db, at)).map((s) => s.reason).filter((r) => /no end set after/.test(r));
  assert.equal((await lines(await mk(), T + 130 * M)).length, 1, "default 2 h: raised at 2 h 10");
  assert.equal((await lines(await mk(10800), T + 130 * M)).length, 0, "posted 3 h: not yet");
  const l = await lines(await mk(10800), T + 190 * M);
  assert.equal(l.length, 1);
  assert.match(l[0], /no end set after 3 h:/);
});

// Slice four: Manager's wake (row 4). wakeTakenSec, wakeResendSec, wakeRetryFailedSec and askStaleSec move the rules the store applies at each ask.
const RED = { state: "red", reason: "the daily full browser run on dev is red", run: "https://github.com/acme/product/actions/runs/1", lastGreenAt: null };
async function wakeWorld(values) {
  const db = makeDb();
  if (values) await postKnobs(db, values);
  await writeEvidence(db, T, "probe", "e2e", RED);
  return db;
}
const askAt = async (db, at) => { await writeEvidence(db, at, "probe", "e2e", RED); return wakeAsk(db, at); };

test("through the store: a posted wakeResendSec moves how soon an untaken batch is sent again", async () => {
  const run = async (values) => {
    const db = await wakeWorld(values);
    const first = await askAt(db, T);
    assert.equal(first.send, true, "the first send of a batch");
    await wakeResult(db, T + 1000, first.batchId, 0, "");
    return (await askAt(db, T + 4 * M)).send;
  };
  assert.equal(await run(), false, "default 5 min: not at 4");
  assert.equal(await run({ wakeResendSec: 120 }), true, "posted 2 min: sent again at 4");
});

test("through the store: a posted wakeTakenSec moves when a sent batch counts as not read", async () => {
  const run = async (values) => {
    const db = await wakeWorld(values);
    const first = await askAt(db, T);
    await wakeResult(db, T + 1000, first.batchId, 0, "");
    return (await askAt(db, T + 4 * M)).status;
  };
  const dflt = await run();
  assert.equal(dflt.state, "red"); assert.equal(dflt.reason, "batch-not-taken");
  assert.equal((await run({ wakeTakenSec: 600 })).state, "ok", "posted 10 min: not yet a failure");
});

test("through the store: a posted askStaleSec moves when the Manager chip reads the probe as not asking, in its words", async () => {
  const run = async (values) => {
    const db = await wakeWorld(values);
    await askAt(db, T);
    return (await readView(db, T + 4 * M)).wakeState;
  };
  const dflt = await run();
  assert.equal(dflt.state, "red"); assert.equal(dflt.reason, "probe-not-asking");
  assert.equal(dflt.fix, "the probe has not asked the store for 3 min");
  assert.notEqual((await run({ askStaleSec: 600 })).reason, "probe-not-asking", "posted 10 min: 4 min of silence is fine");
  const short = await run({ askStaleSec: 120 });
  assert.equal(short.fix, "the probe has not asked the store for 2 min");
});

test("#C1209 (Checker 2's LOW on #C1208): the lowest askStaleSec a setting can take is longer than one ask run plus the interval before the next", () => {
  assert.ok(KNOBS.askStaleSec.min * 1000 > (JOBS.ask.limitSec + JOBS.ask.intervalSec) * 1000, "a run of two slow sends must not read as the probe not asking");
});

test("the retry after a failed send to the owner's words follows the setting; the limits are the old numbers by default", () => {
  const wake = { batchId: "b1", count: 1, batchAt: T, lastSendAt: T, lastSendBatch: "b1", lastSendOk: false, ownerWaiting: true };
  assert.equal(shouldSend(wake, T + 30_000), false);
  assert.equal(shouldSend(wake, T + 60_000), true, "default 60 s");
  assert.equal(shouldSend(wake, T + 60_000, wakeLimits({ values: { wakeRetryFailedSec: 120 } })), false, "posted 120 s: not at 60");
  assert.equal(shouldSend(wake, T + 120_000, wakeLimits({ values: { wakeRetryFailedSec: 120 } })), true);
  assert.deepEqual(wakeLimits(null), { takenMs: 180_000, resendMs: 300_000, retryMs: 60_000, askStaleMs: 180_000 });
});

// Slice five: the share of the week at which the idle-agent stall lines are held (the #C1078 hold).
test("through the store: a posted quotaOutPct moves the share at which the idle-agent lines are held, and the line says it", async () => {
  const RESET = T + 40 * 60 * M;
  const run = async (values, percent) => {
    const db = makeDb();
    if (values) await postKnobs(db, values);
    for (let k = 1; k <= 3; k++) await createCard(db, T, "Manager", { id: `card-${k}`, title: `Card ${k}`, owner_role: "Boardsmith" });
    await writeEvidence(db, T, "probe", "agents", { Boardsmith: { state: "idle", tool: null, card: null, since: T } });
    await writeWeekUsage(db, T + 19 * M, "Manager", { percent, resets_at: new Date(RESET).toISOString() });
    await db.prepare("UPDATE evidence SET read_at = ? WHERE key = 'agents' OR key LIKE 'cards.%'").bind(T + 20 * M).run();
    return stallsAt(db, T + 20 * M);
  };
  const plain = await run(undefined, 92);
  assert.match(plain[0].reason, /^Boardsmith idle since .*, 3 queued, next #C1$/, "92% under the default 98: the idle line stands");
  const held = await run({ quotaOutPct: 90 }, 92);
  assert.equal(held.length, 1);
  assert.match(held[0].reason, /^The week's quota is used up \(90% or more\): idle-agent stall lines are held until it resets at /);
  const still = await run({ quotaOutPct: 95 }, 92);
  assert.match(still[0].reason, /^Boardsmith idle since/, "posted 95: 92 is under it");
});

// Slice six: what the board says to Manager and pushes to the owner's phone (worker/push-rules.mjs).
const decisionAsk = { type: "Decision", title: "Pick", asked_by: "Manager", question: "A or B?", options: ["A", "B"], recommended: "A" };

test("the push limits are the old numbers by default; a nudge to Manager must stay under the owner's push", () => {
  assert.deepEqual(pushLimits(null), { nudgeMin: 10, pushMin: 30, wordMin: 10, wordRepeatMin: 30, wordSlowRepeatMin: 180, wordDays: 7, promptMin: 30, silentMin: 15, shipDays: 7 });
  assert.equal(pushLimits({ values: { ownerPushSec: 900 } }).pushMin, 15);
  assert.equal(pushLimits({ values: { ownerPushSec: 1 } }).pushMin, 30, "out of bounds: the default");
  const r = resolveKnobs({ managerNudgeSec: 2000, ownerPushSec: 1800 });
  assert.deepEqual(r.ignored, [{ key: "managerNudgeSec", why: "not under ownerPushSec" }]);
  assert.ok(r.values.managerNudgeSec < r.values.ownerPushSec);
  assert.deepEqual(resolveKnobs({ ownerPushSec: 300 }).ignored, [], "a lowered push moves an unwritten nudge quietly");
  assert.ok(resolveKnobs({ ownerPushSec: 300 }).values.managerNudgeSec < 300);
});

test("through the store: a posted managerNudgeSec moves how soon an unanswered ask wakes Manager, and the line says it", async () => {
  const run = async (values) => {
    const db = makeDb();
    if (values) await postKnobs(db, values);
    const a = await createAsk(db, T, { ...decisionAsk });
    assert.equal(a.ok, true);
    await beat(db, T + 6 * M);
    await wakeAsk(db, T + 6 * M);
    return (await takeInbox(db, T + 6 * M + 1000)).stalls.map((s) => s.reason).filter((r) => /has waited/.test(r));
  };
  assert.equal((await run()).length, 0, "default 10 min: not at 6");
  const posted = await run({ managerNudgeSec: 300 });
  assert.equal(posted.length, 1, "posted 5 min: at 6");
  assert.match(posted[0], /has waited 5 min for the owner: .* at 30 min it goes to the owner's phone/);
});

test("through the store: a posted ownerWordSec moves how soon a thread ending on the owner's word wakes Manager, in its words", async () => {
  const run = async (values) => {
    const db = makeDb();
    if (values) await postKnobs(db, values);
    await createCard(db, T, "Manager", { id: "c1", title: "C", owner_role: "Boardsmith" });
    await postMessage(db, T + M, "owner", { thread_id: "c1", body: "please change the heading to something clearer" });
    await beat(db, T + 6 * M);
    await wakeAsk(db, T + 6 * M);
    return (await takeInbox(db, T + 6 * M + 1000)).stalls.map((s) => s.reason).filter((r) => /ends on the owner's word/.test(r));
  };
  assert.equal((await run()).length, 0, "default 10 min: not at 5 min old");
  const posted = await run({ ownerWordSec: 240 });
  assert.equal(posted.length, 1, "posted 4 min: at 5 min old");
  assert.match(posted[0], /unanswered for 4\+ min/);
});

test("through the store: the phone push follows ownerPushSec, and a session's usage post does not hide a silent probe from it", async () => {
  const env = { PUSH_VAPID_JWK: JSON.stringify({ ...(await crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])).privateKey)), sub: "https://board.example.invalid" }) };
  const pushed = async (db, now) => (await pushRun(db, now, env)) && (await db.prepare("SELECT kind, ref FROM push_sent").all()).results.map((r) => `${r.kind}:${r.ref}`);
  const mk = async (values) => { const db = makeDb(); if (values) await postKnobs(db, values); const a = await createAsk(db, T, { ...decisionAsk }); return { db, id: a.id }; };
  const d = await mk();
  assert.deepEqual((await pushed(d.db, T + 20 * M)).filter((r) => r.startsWith("ask:")), [], "default 30 min: nothing at 20");
  const p = await mk({ ownerPushSec: 900 });
  assert.deepEqual((await pushed(p.db, T + 20 * M)).filter((r) => r.startsWith("ask:")), [`ask:${p.id}`], "posted 15 min: pushed at 20");
  // F1 on the push: the probe's last post was at T; a session's weekly-usage post at T + 20 min is not the probe.
  const s = makeDb();
  await postKnobs(s, { shipWindowSec: 604800 });
  await writeWeekUsage(s, T + 20 * M, "Manager", { percent: 40, resets_at: new Date(T + 5 * 24 * 60 * M).toISOString() });
  assert.ok((await pushed(s, T + 21 * M)).some((r) => r === `ship:silent:${T}`), "silent since the probe's last post");
});

test("through the store: a posted autoCloseSec moves the board's close of an answered Decision", async () => {
  const mk = async (autoCloseSec) => {
    const db = makeDb();
    if (autoCloseSec !== undefined) await postKnobs(db, { autoCloseSec });
    assert.equal((await createCard(db, T, "Manager", { id: "c", title: "C", next_note: "build it" })).ok, true);
    const a = await createAsk(db, T + M, { type: "Decision", title: "Pick", asked_by: "Manager", question: "A or B?", options: ["A", "B"], recommended: "A", card_id: "c" });
    assert.equal((await answerAsk(db, T + 2 * M, "owner", { id: a.id, answer: "B" })).ok, true);
    await takeInbox(db, T + 3 * M);
    await updateCard(db, T + 10 * M, "Manager", { id: "c", next_note: "the owner chose B: building it" });
    return { db, id: a.id };
  };
  const closedAt = async ({ db, id }, at) => { await beat(db, at); await wakeAsk(db, at); return (await db.prepare("SELECT closed_at FROM asks WHERE id = ?").bind(id).first()).closed_at; };
  assert.equal(await closedAt(await mk(), T + 40 * M), T + 40 * M, "default 30 min after the move: closed at 40");
  assert.equal(await closedAt(await mk(3600), T + 40 * M), null, "posted 60 min: still open at 40");
  assert.equal(await closedAt(await mk(3600), T + 70 * M), T + 70 * M, "posted 60 min: closed at 70");
});
