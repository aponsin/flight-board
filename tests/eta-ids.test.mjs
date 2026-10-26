// The derived ETA (a card's "Live in" from its phase, never only what was declared) and card numbers (#C12), like
// thread numbers. Fictional board.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { checkWrites, CARD_SEQ } from "../gate/rules.mjs";
import { afterWrite } from "../gate/after.mjs";
import { keepCounter } from "../gate/gate.mjs";
import { allocate } from "../scripts/card-ids.mjs";

const MIN = 60e3, H = 36e5, NOW = 1_800_000_000_000;
const b = loadNames(["phaseMedians", "derivedEta", "cardEta", "cardTag", "gaps", "PHASES"]);
const log = (...xs) => xs.map(([phase, start, end]) => ({ phase, start, end }));
// Two cards that went live: build 2 h and 4 h, checker 30 min each, ship 10 min.
const done = [
  { status: "done", doneAt: NOW - 10 * H, phaseLog: log(["build", NOW - 20 * H, NOW - 18 * H], ["checker", NOW - 18 * H, NOW - 17.5 * H], ["ship", NOW - 17.5 * H, NOW - 17.5 * H + 10 * MIN]) },
  { status: "done", doneAt: NOW - 5 * H, phaseLog: log(["build", NOW - 12 * H, NOW - 8 * H], ["checker", NOW - 8 * H, NOW - 7.5 * H], ["ship", NOW - 7.5 * H, NOW - 7.5 * H + 10 * MIN]) },
];

test("phase medians come from the cards that went live; open cards and waits don't count", () => {
  const med = b.phaseMedians([...done, { status: "active", phaseLog: log(["build", NOW - 99 * H, NOW]) }]);
  assert.equal(med.build, 3 * H);
  assert.equal(med.checker, 30 * MIN);
  assert.equal(med.ship, 10 * MIN);
});

test("the ETA from the phase: in ship the release start + ~10 min; before, what's left here + the medians ahead, skips left out", () => {
  const med = b.phaseMedians(done);
  const skipAll = ["plan", "test", "language", "security"];
  // 4 minutes into a ship: about 6 minutes left, not hours (it showed "Live in 3 h 11 min").
  assert.equal(b.derivedEta({ status: "active", phase: "ship", shipAt: NOW - 4 * MIN, etaLive: NOW + 3 * H }, med, NOW), NOW + 6 * MIN);
  assert.equal(b.derivedEta({ status: "active", phase: "ship", shipAt: NOW - 20 * MIN }, med, NOW), NOW + MIN, "a slow ship: a minute away, never in the past");
  // 1 h into build: 2 h left of the median, then checker and ship.
  const build = { status: "active", phase: "build", skip: skipAll, phaseLog: log(["build", NOW - H, null]) };
  assert.equal(b.derivedEta(build, med, NOW), NOW + 2 * H + 30 * MIN + 10 * MIN);
  // Past the median: at least 5 minutes left of this phase.
  assert.equal(b.derivedEta({ ...build, phaseLog: log(["build", NOW - 5 * H, null]) }, med, NOW), NOW + 5 * MIN + 30 * MIN + 10 * MIN);
  // A phase ahead with no history: no derived ETA (the declared one is the fallback).
  assert.equal(b.derivedEta({ ...build, skip: ["plan", "test"] }, med, NOW), null, "language and security have no history");
  assert.equal(b.derivedEta({ status: "done", phase: "live" }, med, NOW), null);
  assert.equal(b.derivedEta({ status: "active", phase: "nowhere" }, med, NOW), null);
});

test("the card shows the derived ETA, the declared one only as a fallback; the gap follows the one shown", () => {
  b.state.initiatives = done;
  b.state.phaseMed = b.phaseMedians(done);
  const ship = { status: "active", phase: "ship", shipAt: Date.now() - 4 * MIN, etaLive: Date.now() - H, nextNote: "n", level: "None" };
  assert.ok(b.cardEta(ship) > Date.now(), "derived, not the stale declared one");
  assert.ok(!b.gaps(ship).includes("ETA passed"), "a stale declared ETA isn't a gap when the phase gives one");
  const noData = { status: "active", phase: "plan", skip: [], etaLive: Date.now() - H, nextNote: "n", level: "None" };
  assert.equal(b.cardEta(noData), noData.etaLive, "no data: the declared one");
  assert.ok(b.gaps(noData).includes("ETA passed"));
  assert.ok(b.gaps({ status: "active", phase: "plan", skip: [], nextNote: "n", level: "None" }).includes("no ETA"));
});

test("a card's number shows as #C, never as a thread's #T", () => {
  assert.match(b.cardTag({ num: 12 }), /#C12/);
  assert.doesNotMatch(b.cardTag({ num: 12 }), /#T/);
  assert.equal(b.cardTag({}), "");
  assert.equal(b.cardTag({ num: "12" }), "");
});

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01" });
const who = { role: "Builder", manager: false };
const now = Date.now() - 1234;
const card = { name: "X", size: "S", status: "active", level: "Quick", plannedVersion: "1.0.0", etaLive: Date.now() + 6e5, nextNote: "n", nextNoteAt: now, plan: "keep-lights-on" };
const mirror = (initiatives = []) => ({ docs: { initiatives, plan: [{ id: "keep-lights-on", parent: null, order: 1, text: "K", kind: "objective" }], waiting: [], ideas: [], messages: [], derived: [] } });
const seq = (next, op = "update", if_version = 3) => ({ op, collection: "meta", doc_id: CARD_SEQ, data: { next }, ...(if_version ? { if_version } : {}) });
const errs = (writes, { m = mirror(), state = {} } = {}) => checkWrites(writes, { config, who, now, state, mirror: m }).errors.join(" | ");

test("card numbers: a new card takes the counter's next in the same batch; a number is kept for good", () => {
  assert.equal(errs([{ op: "set", collection: "initiatives", doc_id: "c1", data: { ...card, num: 1 } }, seq(2, "set", 0)]), "", "the first card makes the counter");
  assert.match(errs([{ op: "set", collection: "initiatives", doc_id: "c1", data: card }]), /a new card gets its number/);
  assert.match(errs([{ op: "set", collection: "initiatives", doc_id: "c1", data: { ...card, num: 5 } }]), /moves meta\/cardSeq in the same batch/);
  assert.match(errs([{ op: "set", collection: "initiatives", doc_id: "c1", data: { ...card, num: 5 } }, seq(7)]), /no gap/);
  assert.match(errs([{ op: "set", collection: "initiatives", doc_id: "c1", data: { ...card, num: 5 } }, seq(6, "update", 0)], { state: { cardSeq: 5 } }), /pin it with if_version/);
  assert.match(errs([{ op: "set", collection: "initiatives", doc_id: "c1", data: { ...card, num: 4 } }, seq(5)], { state: { cardSeq: 5 } }), /next never goes back|#C4 was handed out/);
  assert.match(errs([{ op: "set", collection: "initiatives", doc_id: "c1", data: { ...card, num: 0 } }, seq(1)]), /num: a whole number from 1/);
  const old = mirror([{ id: "c1", ...card, num: 3 }]);
  assert.equal(errs([{ op: "update", collection: "initiatives", doc_id: "c1", data: { nextNote: "m", nextNoteAt: now } }], { m: old }), "");
  assert.match(errs([{ op: "update", collection: "initiatives", doc_id: "c1", data: { num: 9 } }, seq(10)], { m: old }), /#C3 for good/);
  assert.match(errs([{ op: "set", collection: "initiatives", doc_id: "c1", data: card }], { m: old }), /#C3 for good/, "a set that drops it");
  assert.equal(errs([{ op: "update", collection: "initiatives", doc_id: "c2", data: { num: 4 } }, seq(5)], { m: mirror([{ id: "c2", ...card }]), state: { cardSeq: 4 } }), "", "a backfill numbers an old card");
  assert.match(errs([seq(1)]), /next is a whole number above 1/);
  assert.match(errs([{ op: "delete", collection: "meta", doc_id: CARD_SEQ }]), /never deleted/);
});

test("the gate remembers the card counter the board applied, and keeps the higher one on save", () => {
  assert.equal(afterWrite({}, [seq(8)]).cardSeq, 8);
  assert.equal(afterWrite({ cardSeq: 9 }, [seq(8)]).cardSeq, 9);
  assert.equal(afterWrite({ threadSeq: 4 }, [seq(8)]).threadSeq, 4, "the thread counter is its own");
  assert.deepEqual(keepCounter({ cardSeq: 3, threadSeq: 9 }, { cardSeq: 5, threadSeq: 2 }), { cardSeq: 5, threadSeq: 9 });
});

test("card-ids: open and recent cards numbered in the order made; numbered ones keep theirs; old closed ones left out", () => {
  const now = NOW;
  const cards = [
    { id: "b", status: "active", createdAt: now - 2 * H },
    { id: "a", status: "active", createdAt: now - 5 * H },
    { id: "old", status: "done", createdAt: now - 99 * 864e5, doneAt: now - 60 * 864e5 },
    { id: "recent", status: "done", createdAt: now - 9 * 864e5, doneAt: now - 3 * 864e5 },
    { id: "has", status: "active", num: 4, createdAt: now - 6 * H },
  ];
  const r = allocate({ cards, seq: { next: 3 }, now, days: 30 });
  assert.deepEqual(r.batches, [[
    { op: "update", collection: "initiatives", doc_id: "recent", data: { num: 5 } },
    { op: "update", collection: "initiatives", doc_id: "a", data: { num: 6 } },
    { op: "update", collection: "initiatives", doc_id: "b", data: { num: 7 } },
    { op: "update", collection: "meta", doc_id: CARD_SEQ, data: { next: 8 } },
  ]]);
  assert.equal(allocate({ cards: [{ id: "x", status: "active" }] }).batches[0][1].op, "set", "the first counter is made");
  assert.deepEqual(allocate({ cards: [{ id: "x", status: "active", num: 1 }], seq: { next: 2 } }).batches, []);
});
