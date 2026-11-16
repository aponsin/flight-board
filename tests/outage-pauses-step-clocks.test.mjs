// #C990: while the probe is silent (an outage) a step's clock does not run; a real stall outside an outage still fires, and a step already late
// before the outage stays late.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { outageOverlap, waited, slowWakes, stalledWaits, STALL_AFTER_MS, SHIP_SLOW_MS } from "../worker/board-rules.mjs";
import { writeEvidence, readView, outagesOf, PROBE_SILENT_MS, createCard, writeWeekUsage, wakeAsk as realWakeAsk, takeInbox as realTakeInbox } from "../worker/board-store.mjs";
import { beat } from "./helpers/beating-store.mjs";
import { headerHtml } from "../worker/page-header.mjs";

const M = 60_000, NOW = 100 * 60 * M;

test("the waited time is the elapsed time less the outage time inside it", () => {
  assert.equal(outageOverlap(0, 100, [{ start: 20, end: 50 }]), 30);
  assert.equal(outageOverlap(40, 100, [{ start: 20, end: 50 }]), 10, "an outage that began before the step counts from the step's start");
  assert.equal(outageOverlap(0, 30, [{ start: 20, end: 50 }]), 10, "and one still running at `to` counts up to it");
  assert.equal(outageOverlap(60, 100, [{ start: 20, end: 50 }]), 0);
  assert.equal(waited(0, 100, [{ start: 20, end: 50 }, { start: 70, end: 80 }]), 60);
  assert.equal(waited(0, 100, []), 100);
  assert.equal(waited(0, 100, undefined), 100);
});

// A card at Checker, with Checker idle since the phase began.
const cardsOf = () => [{ id: "c1", num: 1, owner_role: "Builder", updated_at: NOW }];
const stallAt = (start, outages, now = NOW) => stalledWaits({
  now, cards: cardsOf(), evidence: { c1: { lit: ["checker"] } }, agents: { Checker: { state: "idle", since: start } },
  openAskCards: new Set(), phaseStart: new Map([["c1|checker", start]]), outages,
});

test("a real stall outside any outage still turns red", () => {
  assert.equal(stallAt(NOW - 20 * M, []).length, 1);
  assert.equal(stallAt(NOW - 20 * M, [{ start: NOW - 90 * M, end: NOW - 80 * M }]).length, 1, "an outage long before the step began changes nothing");
});

test("an outage that covers most of the wait stops it turning red", () => {
  // The step began 20 min ago; 10 of them were an outage that ended 3 minutes ago: it has waited 10.
  assert.equal(stallAt(NOW - 20 * M, [{ start: NOW - 15 * M, end: NOW - 3 * M }]).length, 0);
  // The same step with the outage still open (the probe is silent now): the clock does not run.
  assert.equal(stallAt(NOW - 20 * M, [{ start: NOW - 12 * M, end: NOW }]).length, 0);
});

test("a step already late before the outage stays late during and after it", () => {
  const start = NOW - 40 * M, outage = { start: NOW - 10 * M, end: NOW };
  assert.ok(waited(start, NOW, [outage]) >= STALL_AFTER_MS);
  assert.equal(stallAt(start, [outage]).length, 1, "during the outage");
  assert.equal(stallAt(start, [{ start: NOW - 10 * M, end: NOW - 4 * M }]).length, 1, "after it");
});

test("a wait for a role with no session, and a queued card's owner idle time, follow the same rule", () => {
  const outage = { start: NOW - 14 * M, end: NOW - 2 * M };
  // A card at Checker; the roster lists others but not Checker (no session): counted from the phase's start, 20 min ago.
  const noSession = (outages) => stalledWaits({ now: NOW, cards: cardsOf(), evidence: { c1: { lit: ["checker"] } }, agents: { Boardsmith: { state: "working", card: "other" } },
    openAskCards: new Set(), phaseStart: new Map([["c1|checker", NOW - 20 * M]]), outages });
  assert.equal(noSession([]).length, 1, "plain: 20 min with nobody there");
  assert.equal(noSession([outage]).length, 0, "12 of them were an outage");
  // A card nobody pushed, its owner idle since 20 min ago (a queued card), and one whose owner has no session (counted from the card's last update).
  const queued = (agents, outages, updated = NOW - 20 * M) => stalledWaits({ now: NOW, cards: [{ id: "c1", num: 1, owner_role: "Builder", updated_at: updated }], evidence: {}, agents,
    openAskCards: new Set(), phaseStart: new Map(), outages });
  const idle = { Builder: { state: "idle", since: NOW - 20 * M } };
  assert.equal(queued(idle, []).length, 1, "plain: the owner idle 20 min with a card waiting");
  assert.equal(queued(idle, [outage]).length, 0, "12 of those minutes were an outage");
  const gone = { Other: { state: "working", card: "x" } };
  assert.equal(queued(gone, []).length, 1, "plain: no session for the owner");
  assert.equal(queued(gone, [outage]).length, 0, "12 of those minutes were an outage");
});

test("the slow line follows the same rule", () => {
  const cards = [{ id: "c1", num: 1, owner_role: "Builder" }];
  const slow = (start, outages) => slowWakes({ now: NOW, cards, evidence: { c1: { lit: ["ship"] } }, openAskCards: new Set(), phaseStart: new Map([["c1|ship", start]]), medians: {}, outages });
  assert.equal(slow(NOW - SHIP_SLOW_MS - M, []).length, 1, "plain: past 11 min");
  assert.equal(slow(NOW - SHIP_SLOW_MS - M, [{ start: NOW - 8 * M, end: NOW - 1 * M }]).length, 0, "7 of its minutes were an outage");
  assert.equal(slow(NOW - 3 * SHIP_SLOW_MS, [{ start: NOW - 8 * M, end: NOW - 1 * M }]).length, 1, "late long before it stays late");
});

async function store() {
  const db = makeDb();
  const board = { boardId: "flight-board", at: NOW, probe: "a".repeat(12), derivedAt: NOW - 600 * M, quietMin: 0 };
  assert.equal((await writeEvidence(db, NOW, "probe", "board", board)).ok, true);
  return { db, board };
}

test("the first post after a silence of 5 minutes or more records the outage; a short gap records nothing", async () => {
  const { db, board } = await store();
  assert.equal((await writeEvidence(db, NOW + 2 * M, "probe", "board", board)).ok, true);
  assert.deepEqual(await outagesOf(db, NOW + 2 * M), [], "2 minutes: no outage");
  assert.equal((await writeEvidence(db, NOW + 2 * M + PROBE_SILENT_MS + 1000, "probe", "board", board)).ok, true);
  assert.deepEqual(await outagesOf(db, NOW + 2 * M + PROBE_SILENT_MS + 2000), [{ start: NOW + 2 * M, end: NOW + 2 * M + PROBE_SILENT_MS + 1000 }]);
});

test("a run report is no heartbeat: it records no outage and does not end one", async () => {
  const { db } = await store();
  assert.equal((await writeEvidence(db, NOW + 30 * M, "probe", "run.evidence", { ok: false, at: NOW + 30 * M, line: "x" })).ok, true);
  assert.deepEqual(await outagesOf(db, NOW + 30 * M), [{ start: NOW, end: NOW + 30 * M }], "still silent: the open outage runs to now");
});

test("a silence still open is an outage up to now; the view's probe says silent", async () => {
  const { db } = await store();
  assert.deepEqual(await outagesOf(db, NOW + 10 * M), [{ start: NOW, end: NOW + 10 * M }]);
  assert.equal((await readView(db, NOW + 10 * M)).probe.state, "silent");
});

test("the header says the step clocks are paused while the probe is silent", () => {
  const view = { live: { state: "live", version: "v1", age: 1000 }, probe: { state: "silent", since: NOW } };
  assert.match(headerHtml(view), /silent since .*step clocks paused/);
  assert.doesNotMatch(headerHtml({ ...view, probe: { state: "ok", lastAt: NOW } }), /paused/);
});

// Checker 2's F1 on 896adf64: a session's weekly-usage post (the week_usage door tool) is not the probe, so it neither hides the silence nor loses the
// start of the outage when the probe comes back.
test("a session's usage report is no heartbeat: the silence stays open and the outage keeps its true start", async () => {
  const { db, board } = await store();
  const RESET = new Date(NOW + 5 * 24 * 60 * M).toISOString();
  assert.deepEqual(await writeWeekUsage(db, NOW + 20 * M, "Manager", { percent: 50, resets_at: RESET }), { ok: true });
  assert.deepEqual(await outagesOf(db, NOW + 22 * M), [{ start: NOW, end: NOW + 22 * M }], "still silent from the probe's last post");
  assert.equal((await readView(db, NOW + 22 * M)).probe.state, "silent", "the Probe chip reads the same");
  assert.equal((await writeEvidence(db, NOW + 30 * M, "probe", "board", board)).ok, true);
  assert.deepEqual(await outagesOf(db, NOW + 31 * M), [{ start: NOW, end: NOW + 30 * M }], "the recorded outage starts at the probe's last post, not at the usage report");
});

// Checker 2's F2: nothing checked that the store feeds the outages to the step clocks (syncStalls to stalledWaits, slowWakes).
async function stallWorld() {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "card-a", title: "A card", owner_role: "Boardsmith" });
  await writeEvidence(db, NOW, "probe", "cards.card-a", { lit: ["checker"], phase: "checker", ci: "none" });
  await writeEvidence(db, NOW, "probe", "agents", { Checker: { state: "idle", tool: null, card: null, since: NOW } });
  return db;
}
const stallsAt = async (db, at) => { await realWakeAsk(db, at); return (await realTakeInbox(db, at + 1000)).stalls; };

test("through the store: a card past the stall time while the probe was silent is not a stall; the same wait with the probe posting is", async () => {
  // Control: the probe posts throughout (a heartbeat 1 minute before), the card has waited 20 minutes: the stall row is there.
  const control = await stallWorld();
  await beat(control, NOW + 19 * M);
  const rows = await stallsAt(control, NOW + 20 * M);
  assert.equal(rows.length, 1, "control: a real stall");
  assert.match(rows[0].reason, /waits at Checker/);
  // The probe's last post was at NOW; nobody posted until the question 20 minutes later: all of it is an outage, the card has waited no time.
  const silent = await stallWorld();
  assert.deepEqual(await stallsAt(silent, NOW + 20 * M), [], "silent probe: the step clock did not run");
});

test("through the store: the slow line (a ship step past its median) follows the outage too", async () => {
  const mk = async () => {
    const db = makeDb();
    await createCard(db, NOW, "Manager", { id: "card-b", title: "B card", owner_role: "Boardsmith" });
    await writeEvidence(db, NOW, "probe", "cards.card-b", { lit: ["ship"], phase: "ship", ci: "none" });
    // The owner is working on it, so the stall line (stalledWaits) has nothing to say and only the slow line can.
    await writeEvidence(db, NOW, "probe", "agents", { Boardsmith: { state: "working", tool: "Bash", card: "card-b", since: NOW } });
    return db;
  };
  const control = await mk();
  await beat(control, NOW + SHIP_SLOW_MS);
  assert.ok((await stallsAt(control, NOW + SHIP_SLOW_MS + M)).some((s) => /is slow with no reason/.test(s.reason)), "control: slow row");
  const silent = await mk();
  assert.deepEqual(await stallsAt(silent, NOW + SHIP_SLOW_MS + M), [], "silent probe: no slow row");
});
