// #C1119: the land job lands a group only when every card of it is signed. On 11-16 at 5:35 pm the job landed #C863 alone the moment it was fully signed, with
// its group (G17) mostly unbuilt; the only stop was a hand-written waiting_on on each signed card. The probe's holds file now holds a grouped card ("group")
// while another card of its group is open and not yet signed; the job (scripts/board-land.mjs, unchanged) already waits for any hold, so the group lands
// whole once the last card is signed. A card with no group lands as before; a dropped or closed member does not block.
import test from "node:test";
import assert from "node:assert/strict";
import { landRun } from "../scripts/board-land.mjs";
import { landHoldsFile } from "../collector/store-dispatch.mjs";

const NOW = 1_800_000_000_000;
const card = (id, over = {}) => ({ id, batch: "g-one", owner_role: "Boardsmith", ...over });
const ev = (phase) => ({ value: { phase, lit: [phase] } });
const view = (cards, phases = {}) => ({ cards, evidence: Object.fromEntries(Object.entries(phases).map(([id, p]) => [`cards.${id}`, ev(p)])) });
const holds = (v) => landHoldsFile(v, NOW).cards;

test("a signed card in a group with an unsigned member is held 'group'; the unsigned member itself is not (it cannot land yet anyway)", () => {
  const h = holds(view([card("a"), card("b")], { a: "ship", b: "checker" }));
  assert.deepEqual(h, { a: "group", b: "" });
});

test("two members both still in review hold each other; a member not yet pushed (no reading at all) blocks like an unsigned one", () => {
  assert.deepEqual(holds(view([card("a"), card("b")], { a: "checker", b: "security" })), { a: "group", b: "group" });
  assert.deepEqual(holds(view([card("a"), card("b")], { a: "ship" })), { a: "group", b: "" }, "b has no reading: nothing pushed");
  assert.deepEqual(holds(view([card("a"), card("b")], { a: "ship", b: "build" })), { a: "group", b: "" });
});

test("once every member is signed (ship) or landed (live), none is held", () => {
  assert.deepEqual(holds(view([card("a"), card("b"), card("c")], { a: "ship", b: "ship", c: "live" })), { a: "", b: "", c: "" });
  assert.deepEqual(holds(view([card("a")], { a: "ship" })), { a: "" }, "a group of one");
});

test("a card with no group is never held for another card's review, and does not hold a group", () => {
  assert.deepEqual(holds(view([card("solo", { batch: null }), card("also", { batch: "" }), card("a"), card("b")], { solo: "ship", also: "checker", a: "ship", b: "ship" })), { solo: "", also: "", a: "", b: "" });
  assert.deepEqual(holds(view([card("solo", { batch: undefined }), card("a")], { solo: "checker", a: "ship" })), { solo: "", a: "" }, "an unsigned card with no group does not hold a grouped one");
});

test("a dropped member and a closed member do not block; a paused or blocked one does (it is open)", () => {
  assert.deepEqual(holds(view([card("a"), card("b", { dropped: 1 }), card("c", { done_at: NOW - 1000 })], { a: "ship", b: "build", c: "build" })), { a: "", b: "dropped", c: "" });
  assert.equal(holds(view([card("a"), card("b", { paused: 1 })], { a: "ship", b: "build" })).a, "group", "a paused member is still to land");
});

test("groups are independent, and a card's own hold names itself first", () => {
  const h = holds(view([card("a"), card("b"), card("x", { batch: "g-two" }), card("y", { batch: "g-two", paused: 1 })], { a: "ship", b: "checker", x: "ship", y: "ship" }));
  assert.deepEqual(h, { a: "group", b: "", x: "", y: "paused" }, "g-two is whole, and a paused card says paused, not group");
  assert.equal(holds(view([card("a", { waiting_on: "Manager" }), card("b")], { a: "ship", b: "build" })).a, "waiting_on", "the first word that applies");
  assert.equal(holds(view([card("a", { waiting_on: "Release" }), card("b")], { a: "ship", b: "build" })).a, "group", "a landing-role waiting_on is no hold, so the group word shows");
});

test("a view with no evidence, no cards or a bad shape holds nothing and does not throw", () => {
  assert.deepEqual(holds({}), {});
  assert.deepEqual(holds({ cards: [card("a"), card("b")] }), { a: "group", b: "group" }, "no evidence: nothing is signed, the safe side");
  assert.deepEqual(holds({ cards: [card("a")], evidence: [] }), { a: "" }, "a group of one with no reading is whole by itself");
  assert.deepEqual(holds({ cards: [null, { id: 5 }, card("a")], evidence: "x" }), { a: "" });
});

// The job itself, fed from the holds file the probe would write.
const ok = { checker: "PASS Full at abc", security: "SECURE at abc" };
const sha = (n) => String(n).padStart(40, "0");
const head = (n, over = {}) => ({ branch: `build/card-${n}`, sha: sha(n), notes: ok, cards: [`card-${n}`], onMain: false, forward: true, ahead: 1, dataLines: 0, ...over });

test("the land job does not land a signed card whose group has an unsigned member, and says why; with the group whole it lands them in one run", () => {
  const calls = [];
  const release = (s, dry) => { calls.push(`${s.slice(-1)}${dry ? " dry" : " real"}`); return { code: 0, text: "" }; };
  const logs = [];
  const open = holds(view([card("card-1"), card("card-2")], { "card-1": "ship", "card-2": "checker" }));
  const r1 = landRun({ readFacts: () => ({ heads: [head(1)] }), readHolds: () => ({ at: NOW - 1000, cards: open }), release, now: NOW, log: (l) => logs.push(l) });
  assert.deepEqual(calls, [], "nothing released");
  assert.deepEqual(r1.landed, []);
  assert.equal(r1.waiting.length, 1);
  assert.match(r1.waiting[0].why, /held: card-1 \(group\)/);
  const landed = new Set();
  const whole = holds(view([card("card-1"), card("card-2")], { "card-1": "ship", "card-2": "ship" }));
  const r2 = landRun({ readFacts: () => ({ heads: [head(1, { onMain: landed.has(1) }), head(2, { onMain: landed.has(2), ahead: 2 })] }), readHolds: () => ({ at: NOW - 1000, cards: whole }),
    release: (s, d) => { const x = release(s, d); if (!d) { landed.add(1); landed.add(2); } return x; }, now: NOW });
  assert.deepEqual(r2.landed.map((l) => l.branch), ["build/card-2"], "the whole group: the line's tip lands both in one run");
  assert.deepEqual(r2.waiting, []);
});

test("a card with no group lands as today while a group waits", () => {
  const calls = [];
  const holdsNow = holds(view([card("card-1", { batch: null }), card("card-2"), card("card-3")], { "card-1": "ship", "card-2": "ship", "card-3": "checker" }));
  const r = landRun({ readFacts: () => ({ heads: [head(1), head(2)] }), readHolds: () => ({ at: NOW - 1000, cards: holdsNow }), release: (s, d) => { calls.push(`${s.slice(-1)}${d ? " dry" : " real"}`); return { code: 0, text: "" }; }, now: NOW });
  assert.deepEqual(calls, ["1 dry", "1 real"], "the grouped card-2 waits, the loose card-1 lands");
  assert.deepEqual(r.waiting.map((w) => w.branch), ["build/card-2"]);
});
