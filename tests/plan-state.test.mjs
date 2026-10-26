// Board v3, step 2: the plan's states, worked out by the collector (collector/plan-state.mjs). Fictional plan.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { derivePlan } from "../collector/plan-state.mjs";
import { collect } from "../collector/collect.mjs";

const config = fullConfig({ owner: "Sam" });
const now = Date.parse("2030-01-10T12:00:00Z");
const node = (id, over = {}) => ({ id, parent: "obj-shop", order: 1, kind: "step", text: id, ...over });
const obj = (over = {}) => ({ id: "obj-shop", parent: null, order: 1, kind: "objective", text: "Open the shop", due: "2030-01-20", ...over });
const card = (id, over = {}) => ({ id, plan: "step-sign", status: "active", size: "S", ...over });
const run = (nodes, cards = [], extra = {}) => derivePlan({ nodes, cards, config, now, ...extra });
const st = (r, id) => r.nodes[id].state;

test("a step: done when its cards are live or done, active while one is open, next without any", () => {
  assert.equal(st(run([obj(), node("step-sign")]), "step-sign"), "next", "no card, nothing it waits on");
  assert.equal(st(run([obj(), node("step-sign")], [card("sign-a")]), "step-sign"), "active");
  assert.deepEqual(run([obj(), node("step-sign")], [card("sign-a")]).nodes["step-sign"].cards, ["sign-a"]);
  assert.equal(st(run([obj(), node("step-sign")], [card("sign-a", { status: "done" })]), "step-sign"), "done");
  const live = run([obj(), node("step-sign")], [card("sign-a")], { derived: { "sign-a": { phase: "live" } } });
  assert.equal(st(live, "step-sign"), "done", "live by the evidence, even if the card is still marked active");
  assert.equal(st(run([obj(), node("step-sign")], [card("sign-a", { status: "done" }), card("sign-b")]), "step-sign"), "active", "one open card: not done yet");
  assert.equal(st(run([obj(), node("step-sign")], [card("sign-a", { status: "dropped" })]), "step-sign"), "next", "a dropped card counts neither way");
  assert.equal(st(run([obj(), node("step-sign")], [card("sign-a", { status: "paused" })]), "step-sign"), "next", "a parked card isn't work in progress");
  assert.equal(st(run([obj(), node("step-sign", { state: "done", evidence: "the sign is up" })]), "step-sign"), "done", "declared by the lead");
  assert.equal(run([obj(), node("step-sign", { state: "done", evidence: "e" })]).nodes["step-sign"].declared, true);
});

test("gated: on a node or card not done, on any other waitsOn text, or on an open ask to the owner", () => {
  const r = run([obj(), node("step-paint"), node("step-sign", { waitsOn: ["step-paint", "printer-fix", "the landlord's yes"] })], [card("printer-fix", { plan: "step-paint", who: "Builder" })]);
  assert.equal(st(r, "step-sign"), "gated");
  assert.deepEqual(r.nodes["step-sign"].gates, [{ on: "step-paint", kind: "node" }, { on: "printer-fix", kind: "card", who: "Builder" }, { on: "the landlord's yes", kind: "text" }]);
  const met = run([obj(), node("step-paint"), node("step-sign", { waitsOn: ["step-paint", "printer-fix"] })], [card("printer-fix", { plan: "step-paint", status: "done" })]);
  assert.equal(st(met, "step-sign"), "next", "both met: next");
  const ask = { id: "ask-1", initiative: "sign-a", since: now - 36e5, done: false };
  const gatedCard = run([obj(), node("step-sign")], [card("sign-a", { status: "paused" })], { waiting: [ask] });
  assert.deepEqual(gatedCard.nodes["step-sign"].gates, [{ on: "ask-1", kind: "ask", who: "Sam", since: now - 36e5 }]);
  assert.equal(st(run([obj(), node("step-sign")], [card("sign-a", { status: "paused" })], { waiting: [{ ...ask, done: true }] }), "step-sign"), "next", "an answered ask gates nothing");
  assert.equal(st(run([obj(), node("step-sign", { waitsOn: ["the landlord's yes"] })], [card("sign-a")]), "step-sign"), "active", "work going on wins over a gate");
});

test("parents: done when everything below is, active when anything below is, gated when all that's left is gated", () => {
  const ms = { id: "ms-front", parent: "obj-shop", order: 1, kind: "milestone", text: "The front" };
  const kids = [node("step-sign", { parent: "ms-front" }), node("step-door", { parent: "ms-front", order: 2 })];
  assert.equal(st(run([obj(), ms, ...kids], [card("sign-a"), card("door-a", { plan: "step-door", status: "done" })]), "ms-front"), "active");
  const done = run([obj(), ms, ...kids], [card("sign-a", { status: "done" }), card("door-a", { plan: "step-door", status: "done" })]);
  assert.equal(st(done, "ms-front"), "done");
  assert.equal(st(done, "obj-shop"), "done");
  assert.equal(done.objectives["obj-shop"].chip, "done");
  const gated = run([obj(), ms, kids[0], { ...kids[1], waitsOn: ["the landlord's yes"] }], [card("sign-a", { status: "done" })]);
  assert.equal(st(gated, "ms-front"), "gated");
  assert.equal(gated.objectives["obj-shop"].chip, "blocked", "every node left is gated");
});

test("a replaced node stays, marked replaced, and leaves the bar; its replacement counts", () => {
  const r = run([obj(), node("step-sign", { replacedBy: "step-neon", why: "neon is cheaper", changedAt: now - 1 }), node("step-neon", { order: 2 })], [card("neon-a", { plan: "step-neon", status: "done" })]);
  assert.deepEqual(r.nodes["step-sign"], { state: "replaced", replacedBy: "step-neon" });
  assert.deepEqual([r.objectives["obj-shop"].done, r.objectives["obj-shop"].total], [1, 1]);
  assert.equal(st(r, "obj-shop"), "done", "the replaced node doesn't hold the objective open");
});

test("the objective's bar and chip: done over all, on track or at risk against its due day from the size medians", () => {
  const nodes = [obj(), node("step-sign"), node("step-door", { order: 2 }), node("step-light", { order: 3 })];
  const cards = [card("sign-a", { status: "done" }), card("door-a", { plan: "step-door", size: "L" })];
  const r = run(nodes, cards);
  // Left: door (one L card, 6 h) and light (no card: the M median, 3.5 h).
  assert.deepEqual(r.objectives["obj-shop"], { done: 1, total: 3, hoursLeft: 9.5, chip: "on-track" });
  assert.equal(run([obj({ due: "2030-01-10" }), ...nodes.slice(1)], cards).objectives["obj-shop"].chip, "on-track", "9.5 h left, 12 h to the end of the day");
  const evening = derivePlan({ nodes: [obj({ due: "2030-01-10" }), ...nodes.slice(1)], cards, config, now: Date.parse("2030-01-10T18:00:00Z") });
  assert.equal(evening.objectives["obj-shop"].chip, "at-risk", "9.5 h left, 6 h to the end of the day (UTC)");
  assert.equal(run([obj({ due: undefined }), ...nodes.slice(1)], cards).objectives["obj-shop"].chip, null, "no due day: no chip");
  assert.deepEqual(run([obj()]).objectives["obj-shop"], { done: 0, total: 0, hoursLeft: 0, chip: null }, "nothing below it yet: no chip (Checker)");
  assert.equal(run([obj({ replacedBy: "obj-new", why: "w", changedAt: 1 }), { ...obj(), id: "obj-new" }]).objectives["obj-shop"], undefined, "a replaced objective has no bar");
});

test("broken plans never hang the walk: a loop, a missing parent, a node waiting on itself", () => {
  const r = run([node("a", { parent: "b" }), node("b", { parent: "a" }), node("c", { parent: "gone", waitsOn: ["c"] })]);
  assert.deepEqual(Object.keys(r.nodes).sort(), ["a", "b", "c"]);
  assert.equal(st(r, "c"), "next");
  assert.deepEqual(run([]), { at: now, nodes: {}, objectives: {} });
});

test("collect() puts the plan's states in derived/all only when the board has a plan", () => {
  const git = () => "", gh = () => "[]";
  assert.equal(collect({ config, cards: [], git, gh, now }).doc.plan, undefined);
  const doc = collect({ config, cards: [card("sign-a")], git, gh, now, plan: [obj(), node("step-sign")], waiting: [] }).doc;
  assert.equal(doc.plan.nodes["step-sign"].state, "active");
  assert.equal(doc.plan.at, now);
});
