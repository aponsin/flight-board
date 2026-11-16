// #C1084 (11-16: "#C1081 waits at Checker 15 min, Checker idle since 12:47 pm MT" fired while Checker 2 was reviewing it): a review a numbered checker
// holds a claim on is that session's wait. Busy claimant = no stall; idle claimant 15 min = a stall that names it; no claim = the role as before.
import test from "node:test";
import assert from "node:assert/strict";
import { stalledWaits, STALL_AFTER_MS } from "../worker/board-rules.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, claimReview, takeInbox, wakeAsk } from "../worker/board-store.mjs";

const T = 1_800_000_000_000, MIN = 60_000, NOW = T + 20 * MIN;
const cards = [{ id: "card-a", num: 1, owner_role: "Boardsmith" }];
const evidence = { "card-a": { lit: ["checker"], phase: "checker", ci: "none" } };
const phaseStart = new Map([["card-a|checker", T]]);
const idle = { state: "idle", tool: null, card: null, since: T };
const busy = { state: "working", tool: "Bash", card: "other-card", since: T };
const run = (agents, claims) => stalledWaits({ now: NOW, cards, evidence, agents, openAskCards: new Set(), phaseStart, claims });

test("a card claimed by Checker 2 while Checker 2 is busy is no stall, though the bare Checker session is idle", () => {
  assert.deepEqual(run({ Checker: idle, "Checker 2": busy }, new Map([["card-a", "Checker 2"]])), []);
});

test("Checker 2 idle 15 min on its claim: the stall names Checker 2, not Checker", () => {
  const got = run({ Checker: busy, "Checker 2": idle }, new Map([["card-a", "Checker 2"]]));
  assert.equal(got.length, 1); assert.match(got[0].reason, /^#C1 waits at Checker 15 min, Checker 2 idle since /); assert.equal(got[0].role, "Checker 2");
});

test("no claim: the bare Checker role is read as before", () => {
  const got = run({ Checker: idle, "Checker 2": busy }, new Map());
  assert.equal(got.length, 1); assert.match(got[0].reason, /, Checker idle since /);
  assert.equal(run({ Checker: idle }, undefined).length, 1, "claims is optional");
});

test("a claim by a name that is not a Checker role is ignored", () => {
  const got = run({ Checker: idle, Builder: busy }, new Map([["card-a", "Builder"]]));
  assert.equal(got.length, 1); assert.equal(got[0].role, "Checker");
});

test("the claim names the reviewer only at the checker phase: a card at security or ship with the claim still open names that phase's lane (Checker 2's F1)", () => {
  const at = (phase, agents) => stalledWaits({ now: NOW, cards, evidence: { "card-a": { lit: [phase], phase, ci: "none" } }, agents, openAskCards: new Set(), phaseStart: new Map([[`card-a|${phase}`, T]]), claims: new Map([["card-a", "Checker 2"]]) });
  const sec = at("security", { Security: idle, "Checker 2": busy });
  assert.equal(sec.length, 1); assert.equal(sec[0].role, "Security"); assert.match(sec[0].reason, /^#C1 waits at Security 15 min, Security idle since /);
  const ship = at("ship", { Release: idle, "Checker 2": idle });
  assert.equal(ship.length, 1); assert.equal(ship[0].role, "Release"); assert.match(ship[0].reason, /, Release idle since /);
});

test("the claimant has no session: the line says so, naming the claimant", () => {
  const got = run({ Checker: idle, Security: busy }, new Map([["card-a", "Checker 2"]]));
  assert.equal(got.length, 1); assert.match(got[0].reason, /no session for Checker 2$/);
});

test("the store reads the open claim: a claimed card with Checker 2 busy wakes nobody; released, it wakes with the bare Checker line", async () => {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "card-a", title: "A card", owner_role: "Boardsmith" });
  await writeEvidence(db, T, "probe", "cards.card-a", { lit: ["checker"], phase: "checker", ci: "none" });
  await writeEvidence(db, T, "probe", "agents", { Checker: idle, "Checker 2": { ...busy, since: T } });
  const sha = "a".repeat(40);
  await claimReview(db, T, "Manager", { sha, checker: "Checker 2", card_id: "card-a" });
  await db.prepare("UPDATE evidence SET read_at = ? WHERE key LIKE 'cards.%'").bind(NOW).run();
  assert.equal((await wakeAsk(db, NOW)).count, 0);
  await db.prepare("UPDATE review_claims SET released_at = ?, released_by = 'test'").bind(NOW).run();
  assert.equal((await wakeAsk(db, NOW + MIN)).count, 1);
  assert.match((await takeInbox(db, NOW + 2 * MIN)).stalls[0].reason, /, Checker idle since /);
  assert.ok(STALL_AFTER_MS === 15 * MIN);
});
