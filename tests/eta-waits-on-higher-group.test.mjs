// #C1099 (11-16: the board showed G6 (#C990, #C997, Boardsmith) "Live in 54 min" and G10 (first in the owner's order, also Boardsmith) "1 h 52 min"; the owner read it
// as the order not being respected): an agent works its groups in the owner's order, so a group's live time starts no earlier than every higher group that shares an agent
// with it. And a build start with no work seen since (nothing pushed) is a clock that has not run: its median is all still to come.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const NAMES = ["groupEtas", "groupList", "groupFacts", "groupOrderRows", "groupRankOf", "groupCmp", "derivedEta", "PHASES", "MIN_LEFT", "enrich", "gates"];
function board(order = []) {
  const els = {}, el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", value: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }) });
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(NAMES, { document, fetch: async () => ({ ok: true }), setTimeout: () => 0 });
  Object.assign(b.state, { initRaw: [], initiatives: [], steps: [], waiting: [], derived: [], messages: [], threads: [], meta: [{ id: "groupOrder", rows: order.map((batch, k) => ({ batch, pos: k + 1 })) }] });
  return b;
}
const MIN = 60e3, NOW = 1_800_000_000_000;
// A card whose ETA is the declared one (etaLive), the fallback when nothing derives one: the groups' own times are then exactly what the test says.
const card = (id, num, batch, etaLive, fields = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "checker", who: "Boardsmith", batch, etaLive, createdAt: NOW + num * MIN, ...fields });
const etas = (b, cards, order) => { b.state.meta[0].rows = order.map((batch, k) => ({ batch, pos: k + 1 })); const m = b.groupEtas(b.groupList(cards)); return Object.fromEntries([...m]); };

test("a lower group of the same agent is never live before the higher one: its time comes out after it", () => {
  const b = board();
  const g10 = card("a", 1, "g10-small-rules", NOW + 112 * MIN), g6 = card("b", 2, "g6-probe", NOW + 54 * MIN);
  const e = etas(b, [g6, g10], ["g10-small-rules", "g6-probe"]);
  assert.equal(e["g10-small-rules"], NOW + 112 * MIN, "the higher group keeps its own time");
  assert.equal(e["g6-probe"], NOW + 112 * MIN + b.MIN_LEFT, "the lower one is lifted to just after it");
  assert.ok(e["g6-probe"] > e["g10-small-rules"]);
});

test("a lower group already later than the higher one keeps its own time", () => {
  const b = board();
  const e = etas(b, [card("a", 1, "g10-x", NOW + 60 * MIN), card("b", 2, "g6-y", NOW + 300 * MIN)], ["g10-x", "g6-y"]);
  assert.equal(e["g6-y"], NOW + 300 * MIN);
});

test("only a group that shares an agent with it counts: another agent's groups do not move it", () => {
  const b = board();
  const e = etas(b, [card("a", 1, "g10-x", NOW + 200 * MIN, { who: "Builder" }), card("b", 2, "g6-y", NOW + 50 * MIN, { who: "Boardsmith" })], ["g10-x", "g6-y"]);
  assert.equal(e["g6-y"], NOW + 50 * MIN);
  const mixed = etas(b, [card("a", 1, "g10-x", NOW + 200 * MIN, { who: "Builder" }), card("c", 3, "g10-x", NOW + 100 * MIN, { who: "Boardsmith" }), card("b", 2, "g6-y", NOW + 50 * MIN, { who: "Boardsmith" })], ["g10-x", "g6-y"]);
  assert.equal(mixed["g6-y"], NOW + 200 * MIN + b.MIN_LEFT, "a group with one card of the agent counts, at its own latest time");
});

test("the order is the owner's: the higher group is the one placed first, not the one with the smaller number", () => {
  const b = board();
  const cards = [card("a", 1, "g6-y", NOW + 54 * MIN), card("b", 2, "g10-x", NOW + 112 * MIN)];
  assert.equal(etas(b, cards, ["g6-y", "g10-x"])["g10-x"], NOW + 112 * MIN, "g6 first: g10 is later anyway");
  assert.equal(etas(b, cards, ["g10-x", "g6-y"])["g6-y"], NOW + 112 * MIN + b.MIN_LEFT, "g10 first: g6 goes after it");
});

test("a chain of groups for one agent goes one after another; a group with no time of its own stays without one, and does not lift the next", () => {
  const b = board();
  const e = etas(b, [card("a", 1, "g1-a", NOW + 100 * MIN), card("b", 2, "g2-b", NOW + 10 * MIN), card("c", 3, "g3-c", NOW + 20 * MIN)], ["g1-a", "g2-b", "g3-c"]);
  assert.equal(e["g2-b"], NOW + 100 * MIN + b.MIN_LEFT);
  assert.equal(e["g3-c"], NOW + 100 * MIN + 2 * b.MIN_LEFT, "after the adjusted time of the group before it");
  const none = etas(b, [card("a", 1, "g1-a", undefined), card("b", 2, "g2-b", NOW + 10 * MIN)], ["g1-a", "g2-b"]);
  assert.equal(none["g1-a"], null);
  assert.equal(none["g2-b"], NOW + 10 * MIN);
});

// The build clock: a build start with no work seen (noWork) has not been running.
test("a build start with nothing pushed since counts as no time spent: the build median is still all to come, however old the start", () => {
  const b = board();
  const P = b.PHASES.map(([k]) => k), med = Object.fromEntries(P.map((k) => [k, 10 * MIN]));
  const old = { id: "x", num: 5, status: "active", phase: "build", who: "Boardsmith", size: "S", phaseLog: [{ phase: "build", who: "Boardsmith", start: NOW - 5 * 24 * 60 * MIN }], skip: [] };
  const stale = b.derivedEta(old, med, NOW);
  const fresh = b.derivedEta({ ...old, noWork: NOW - 5 * 24 * 60 * MIN }, med, NOW);
  assert.equal(fresh - stale, 5 * MIN, "the stale clock leaves MIN_LEFT of the build; no work seen leaves the whole 10 minutes");
  const worked = b.derivedEta({ ...old, noWork: undefined }, med, NOW);
  assert.equal(worked, stale, "once work is seen the clock is the phase log's as before");
});
