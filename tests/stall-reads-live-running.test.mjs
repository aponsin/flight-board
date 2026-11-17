// #C1143 (11-16/17: the board woke Manager with "Boardsmith idle since 11:14 pm" and "Builder idle since 10:25 pm" while get_session showed both running):
// the idle reading can lag. A role whose newest read shows activity inside the stall time (lastActivityAt) is not idle, so no stall line is raised for it,
// at a phase wait or for a queued card. A role quiet for the full stall time still stalls, and a role with no lastActivityAt (a blind reading) reads as before.
import test from "node:test";
import assert from "node:assert/strict";
import { stalledWaits, STALL_AFTER_MS } from "../worker/board-rules.mjs";

const T = 1_800_000_000_000, MIN = 60_000, NOW = T + 40 * MIN;
const queuedCards = [{ id: "card-q", num: 7, owner_role: "Boardsmith", updated_at: NOW - 60 * MIN }];
const phaseCards = [{ id: "card-a", num: 1, owner_role: "Boardsmith" }];
const phaseEvidence = { "card-a": { lit: ["checker"], phase: "checker", ci: "none" } };
const phaseStart = new Map([["card-a|checker", T]]);
const idleSince = T; // idle for 40 min by its own `since`
const agent = (extra) => ({ state: "idle", tool: null, card: null, since: idleSince, ...extra });
const queued = (agents) => stalledWaits({ now: NOW, cards: queuedCards, evidence: {}, agents, openAskCards: new Set(), phaseStart: new Map() });
const atPhase = (agents) => stalledWaits({ now: NOW, cards: phaseCards, evidence: phaseEvidence, agents, openAskCards: new Set(), phaseStart });

test("the stall time is 15 minutes", () => assert.equal(STALL_AFTER_MS, 15 * MIN));

test("a queued card: the owner read idle but active 2 min ago raises no stall; quiet for the whole stall time it does", () => {
  assert.deepEqual(queued({ Boardsmith: agent({ lastActivityAt: NOW - 2 * MIN }) }), []);
  assert.deepEqual(queued({ Boardsmith: agent({ lastActivityAt: NOW - (15 * MIN - 1) }) }), [], "14 min 59 s is still active");
  const quiet = queued({ Boardsmith: agent({ lastActivityAt: NOW - 15 * MIN }) });
  assert.equal(quiet.length, 1); assert.match(quiet[0].reason, /^Boardsmith idle since .*, 1 queued, next #C7$/);
});

test("a phase wait: the lane read idle but active 2 min ago raises no stall; quiet 15 min it does", () => {
  assert.deepEqual(atPhase({ Checker: agent({ lastActivityAt: NOW - 2 * MIN }) }), []);
  assert.deepEqual(atPhase({ Checker: agent({ lastActivityAt: NOW - (15 * MIN - 1) }) }), []);
  const quiet = atPhase({ Checker: agent({ lastActivityAt: NOW - 15 * MIN }) });
  assert.equal(quiet.length, 1); assert.match(quiet[0].reason, /^#C1 waits at Checker 15 min, Checker idle since /);
});

test("a blind reading (no lastActivityAt) reads as before: the idle `since` decides", () => {
  assert.equal(queued({ Boardsmith: agent({}) }).length, 1);
  assert.equal(atPhase({ Checker: agent({ lastActivityAt: null }) }).length, 1);
  assert.equal(atPhase({ Checker: agent({ lastActivityAt: "yesterday" }) }).length, 1, "a non-number is not activity");
});

test("activity a little ahead of the clock (a skew between the probe's read and now) is still activity: no stall", () => {
  assert.deepEqual(atPhase({ Checker: agent({ lastActivityAt: NOW + 5_000 }) }), []);
});
