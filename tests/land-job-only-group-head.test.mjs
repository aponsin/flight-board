// #C1138 (11-16 late: flight-board main was 32438ae1, #C1126's tip, before G10 landed as a group): nothing pushed to main. The landing job (scripts/board-land.mjs, the LaunchAgent every
// 10 minutes) landed #C1126 alone: every card of G10 that existed was signed, so none was held "group" (#C1119), and the job tried the single signed tip before the group's head was built.
// Groups land whole: the probe's holds file now also says, for each card of a group, the other members still to land (`groups`), and the job lands a tip only when it carries all of them,
// that is, only the group's head. A card with no group, or one whose group has no other member left, lands as before.
import test from "node:test";
import assert from "node:assert/strict";
import { landPlan, landRun } from "../scripts/board-land.mjs";
import { landHoldsFile } from "../collector/store-dispatch.mjs";

const NOW = 1_800_000_000_000;
const card = (id, over = {}) => ({ id, batch: "g-one", owner_role: "Boardsmith", ...over });
const ev = (phase, extra = {}) => ({ value: { phase, lit: [phase], ...extra } });
const view = (cards, phases = {}) => ({ cards, evidence: Object.fromEntries(Object.entries(phases).map(([id, p]) => [`cards.${id}`, typeof p === "string" ? ev(p) : p])) });
const file = (v) => landHoldsFile(v, NOW);
const ok = { checker: "PASS Full at abc", security: "SECURE at abc" };
const sha = (n) => String(n).padStart(40, "0");
const head = (n, over = {}) => ({ branch: `build/card-${n}`, sha: sha(n), notes: ok, cards: [`card-${n}`], onMain: false, forward: true, ahead: 1, dataLines: 0, ...over });
const allSigned = view([card("card-1"), card("card-2"), card("card-3")], { "card-1": "ship", "card-2": "ship", "card-3": "ship" });

test("the holds file lists, for each card of a group, the other members still to land; a card with no group or no other member is not listed", () => {
  assert.deepEqual(file(allSigned).groups, { "card-1": ["card-2", "card-3"], "card-2": ["card-1", "card-3"], "card-3": ["card-1", "card-2"] });
  assert.deepEqual(file(allSigned).cards, { "card-1": "", "card-2": "", "card-3": "" }, "every member signed: none is held, the groups list is what stops a lone tip");
  assert.deepEqual(file(view([card("solo", { batch: null }), card("also", { batch: "" })], { solo: "ship", also: "ship" })).groups, {}, "no group: nothing listed");
  assert.deepEqual(file(view([card("a")], { a: "ship" })).groups, {}, "a group of one");
});

test("a member that is dropped, closed, live or on main is not one still to land; a paused or blocked one still is", () => {
  const v = view([card("a"), card("b", { dropped: 1 }), card("c", { done_at: NOW - 1000 }), card("d"), card("e"), card("f", { paused: 1 })], { a: "ship", b: "build", c: "build", d: "live", e: { value: { phase: "ship", lit: ["ship"], onMain: true } }, f: "build" });
  assert.deepEqual(file(v).groups.a, ["f"], "only the paused f is still to land beside a");
  assert.deepEqual(file(v).groups.f, ["a"]);
  assert.equal(Object.hasOwn(file(v).groups, "b"), false, "a dropped card is not listed itself");
  assert.equal(Object.hasOwn(file(v).groups, "d"), false, "nor one that has landed");
});

test("the plan: one signed card's tip waits while its group has other members to land, naming them; the group's head, which carries them all, is tried", () => {
  const holds = file(allSigned);
  const plan = landPlan({ heads: [head(1), head(2), head(9, { branch: "build/g-group", cards: ["card-1", "card-2", "card-3"], ahead: 6 })], holds, now: NOW });
  assert.deepEqual(plan.try.map((h) => h.branch), ["build/g-group"]);
  assert.deepEqual(plan.waiting.map((w) => w.branch).sort(), ["build/card-1", "build/card-2"]);
  assert.match(plan.waiting.find((w) => w.branch === "build/card-1").why, /^its group is not whole: this tip lacks card-2, card-3,/);
  // a head that carries only part of the group still waits
  const part = landPlan({ heads: [head(8, { branch: "build/part", cards: ["card-1", "card-2"], ahead: 4 })], holds, now: NOW });
  assert.deepEqual(part.try, []);
  assert.match(part.waiting[0].why, /lacks card-3,/);
});

test("the plan keeps today's rule for everything else: no group, a group of one, an older file with no groups key, a malformed one", () => {
  const solo = file(view([card("card-1", { batch: null })], { "card-1": "ship" }));
  assert.deepEqual(landPlan({ heads: [head(1)], holds: solo, now: NOW }).try.map((h) => h.branch), ["build/card-1"]);
  const old = { at: NOW - 1000, cards: { "card-1": "", "card-2": "" } }; // a probe from before this card: no groups
  assert.deepEqual(landPlan({ heads: [head(1)], holds: old, now: NOW }).try.map((h) => h.branch), ["build/card-1"]);
  for (const groups of [null, [], "x", 5, { "card-1": "card-2" }, { "card-1": [5, "bad id!", null] }]) {
    const odd = { at: NOW - 1000, cards: { "card-1": "", "card-2": "" }, groups };
    assert.deepEqual(landPlan({ heads: [head(1)], holds: odd, now: NOW }).try.map((h) => h.branch), ["build/card-1"], JSON.stringify(groups));
  }
  // the other waits still say their own reasons first
  const held = { at: NOW - 1000, cards: { "card-1": "paused", "card-2": "" }, groups: { "card-1": ["card-2"] } };
  assert.match(landPlan({ heads: [head(1)], holds: held, now: NOW }).waiting[0].why, /^held: card-1 \(paused\)/);
});

test("a long list of missing members is cut in the reason", () => {
  const ids = Array.from({ length: 9 }, (_, i) => `m-${i}`);
  const holds = { at: NOW - 1000, cards: Object.fromEntries(["card-1", ...ids].map((c) => [c, ""])), groups: { "card-1": ids } };
  const why = landPlan({ heads: [head(1)], holds, now: NOW }).waiting[0].why;
  assert.match(why, /lacks m-0, m-1, m-2, m-3, m-4, m-5 and 3 more,/);
});

test("the job end to end: with every card of the group signed it releases nothing for a lone tip, and lands the group head", () => {
  const calls = [];
  const release = (s, dry) => { calls.push(`${s.slice(-1)}${dry ? " dry" : " real"}`); return { code: 0, text: "" }; };
  const holds = file(allSigned);
  const lone = landRun({ readFacts: () => ({ heads: [head(1), head(2), head(3)] }), readHolds: () => holds, release, now: NOW });
  assert.deepEqual(calls, [], "nothing released: no lone tip of the group goes out");
  assert.deepEqual(lone.landed, []);
  assert.equal(lone.waiting.length, 3);
  const landed = new Set();
  const withHead = landRun({ readFacts: () => ({ heads: [head(1, { onMain: landed.has("h") }), head(9, { branch: "build/g-group", cards: ["card-1", "card-2", "card-3"], ahead: 6, onMain: landed.has("h") })] }), readHolds: () => holds,
    release: (s, d) => { const x = release(s, d); if (!d) landed.add("h"); return x; }, now: NOW });
  assert.deepEqual(withHead.landed.map((l) => l.branch), ["build/g-group"]);
  assert.deepEqual(calls, ["9 dry", "9 real"], "the head's dry run, then the real landing");
});
