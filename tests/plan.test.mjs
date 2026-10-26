// Board v3, step 1: the plan's nodes and every card's link to one (gate/plan.mjs, through the gate's checkWrites).
// Fictional board and plan.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { checkWrites } from "../gate/rules.mjs";
import { planWriteErrors, planMirrorErrors, initiativePlanErrors } from "../gate/plan.mjs";

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01" });
const lead = { role: "Manager", manager: true };
const builder = { role: "Builder", manager: false };
const now = Date.now() - 1234;
const node = (over = {}) => ({ parent: null, order: 1, text: "Open the shop", kind: "objective", ...over });
const set = (id, data, collection = "plan") => ({ op: "set", collection, doc_id: id, data });
const upd = (id, data, collection = "plan") => ({ op: "update", collection, doc_id: id, data });
const has = (errs, part) => assert.ok(errs.some((e) => e.includes(part)), `"${part}" in: ${errs.join(" | ")}`);
const card = { name: "X", size: "S", status: "active", level: "Quick", plannedVersion: "1.0.0", etaLive: Date.now() + 6e5, nextNote: "n", nextNoteAt: now };
const mirror = (plan, initiatives = []) => ({ docs: { plan, initiatives, waiting: [], ideas: [], messages: [], derived: [] } });

test("a node: the lead's alone, its fields checked, never deleted", () => {
  const w = (x, who = lead) => planWriteErrors(x, { who, config });
  assert.deepEqual(w(set("obj-shop", node())), []);
  assert.deepEqual(w(set("step-sign", node({ parent: "obj-shop", kind: "step", order: 2, outcome: "A sign up", measure: "1 sign", due: "2030-01-31", waitsOn: ["the printer"], note: "n" }))), []);
  has(w(set("obj-shop", node()), builder), "only Manager writes the plan");
  has(w({ op: "delete", collection: "plan", doc_id: "obj-shop" }), "never deleted");
  has(w(set("Bad Id", node())), "a node id");
  has(w(set("obj-shop", { parent: null, order: 1 })), "a node needs text");
  has(w(set("obj-shop", { text: "x", kind: "objective", order: 1 })), "a node needs parent");
  has(w(set("obj-shop", node({ kind: "task" }))), "kind: one of objective, milestone, step");
  has(w(set("obj-shop", node({ order: "1" }))), "order: a number");
  has(w(set("obj-shop", node({ due: "Jan 31" }))), "due: YYYY-MM-DD");
  has(w(set("obj-shop", node({ colour: "red" }))), 'unknown field "colour"');
  has(w(set("obj-shop", node({ parent: "obj-shop" }))), "its own parent");
  has(w(set("obj-shop", node({ text: "x".repeat(201) }))), "text: 1 to 200");
  has(w(set("obj-shop", node({ waitsOn: "the printer" }))), "waitsOn");
  has(w(upd("obj-shop", { text: { __delete__: true } })), "text can't be removed");
  has(w(upd("obj-shop", { state: "done" })), "declared with evidence");
  assert.deepEqual(w(upd("obj-shop", { state: "done", evidence: "the sign is up (photo in the thread)" })), []);
  has(w(upd("obj-shop", { state: "blocked" })), "the collector works out the rest");
  has(w(upd("obj-shop", { replacedBy: "obj-shop-2" })), "says why");
  has(w(upd("obj-shop", { replacedBy: "obj-shop-2", why: "w" })), "changedAt");
  assert.deepEqual(w(upd("obj-shop", { replacedBy: "obj-shop-2", why: "the owner moved the date", changedAt: now, decisionThread: "w-date" })), []);
  has(w(upd("obj-shop", { replacedBy: "obj-shop", why: "w", changedAt: now })), "the node that replaces it");
});

test("a node with cards is replaced, never edited; a replacement stays; parents and replacements exist", () => {
  const m = mirror([{ id: "obj-shop", ...node() }, { id: "old", ...node({ text: "Old", replacedBy: "obj-shop", why: "w", changedAt: 1 }) }], [{ id: "c1", plan: "obj-shop" }]);
  const w = (x, batch = [x]) => planMirrorErrors(x, { mirror: m, batch });
  has(w(upd("obj-shop", { text: "Open two shops" })), "replace the node");
  has(w(upd("obj-shop", { outcome: "Two" })), "replace the node");
  has(w(set("obj-shop", node({ text: "Open two shops" }))), "replace the node");
  has(w(set("obj-shop", node({ outcome: "x" }))), "outcome");
  assert.deepEqual(w(upd("obj-shop", { order: 3, due: "2030-02-01" })), [], "other fields may change");
  assert.deepEqual(w(set("obj-shop", node({ order: 5 }))), [], "the same text and outcome");
  const free = mirror([{ id: "obj-shop", ...node() }]);
  assert.deepEqual(planMirrorErrors(upd("obj-shop", { text: "Open two shops" }), { mirror: free, batch: [] }), [], "no cards yet: edit freely");
  has(w(upd("old", { replacedBy: "other" })), "a replacement stays");
  has(w(upd("old", { replacedBy: { __delete__: true } })), "a replacement stays");
  has(w(upd("obj-shop", { replacedBy: "obj-new", why: "w", changedAt: now })), "no node obj-new");
  const replace = [upd("obj-shop", { replacedBy: "obj-new", why: "w", changedAt: now }), set("obj-new", node({ text: "Open two shops", order: 2 }))];
  for (const x of replace) assert.deepEqual(planMirrorErrors(x, { mirror: m, batch: replace }), [], "a replace in one call");
  has(w(set("step-x", node({ parent: "nowhere", kind: "step" }))), "parent: no node nowhere");
  assert.deepEqual(planMirrorErrors(upd("obj-shop", { text: "x" }), { mirror: { docs: { initiatives: [{ id: "c1", plan: "obj-shop" }] } }, batch: [] }), [], "no plan in the export: skipped");
});

test("every new card names a live plan node; a card naming one names a real one", () => {
  const m = mirror([{ id: "obj-shop", ...node() }, { id: "old", ...node({ replacedBy: "obj-shop", why: "w", changedAt: 1 }) }, { id: "keep-lights-on", ...node({ order: 99, text: "Keep the lights on" }) }]);
  const w = (x, batch = [x], mir = m) => initiativePlanErrors(x, { mirror: mir, batch });
  has(w(set("c1", card, "initiatives")), "no plan: link the card");
  assert.deepEqual(w(set("c1", { ...card, plan: "obj-shop" }, "initiatives")), []);
  assert.deepEqual(w(set("c1", { ...card, plan: "keep-lights-on" }, "initiatives")), []);
  assert.deepEqual(w(set("c1", { ...card, status: "done" }, "initiatives")), [], "a done card set whole is left alone");
  assert.deepEqual(w(upd("c1", { nextNote: "x" }, "initiatives")), [], "an update of an old card without plan passes (until Manager maps it)");
  has(w(upd("c1", { plan: "nowhere" }, "initiatives")), "no node nowhere");
  has(w(upd("c1", { plan: "old" }, "initiatives")), "replaced by obj-shop: link to that");
  has(w(upd("c1", { plan: { __delete__: true } }, "initiatives")), "plan can't be removed");
  has(w(upd("c1", { plan: 7 }, "initiatives")), "plan: a node id");
  const both = [set("step-new", node({ parent: "obj-shop", kind: "step" })), set("c2", { ...card, plan: "step-new" }, "initiatives")];
  assert.deepEqual(w(both[1], both), [], "a node made in the same call");
  assert.deepEqual(w(set("c1", { ...card, plan: "anything" }, "initiatives"), undefined, { docs: {} }), [], "no plan in the export: only the link's presence is checked");
});

test("through the gate: the lead writes the plan, a Builder's card needs its link, the Collector writes none of it", () => {
  const m = mirror([{ id: "keep-lights-on", ...node({ text: "Keep the lights on" }) }]);
  const run = (writes, who) => checkWrites(writes, { config, who, now, state: {}, mirror: m }).errors;
  assert.deepEqual(run([set("obj-shop", node())], lead), []);
  has(run([set("obj-shop", node())], builder), "plan/obj-shop: only Manager writes the plan");
  has(run([{ op: "delete", collection: "plan", doc_id: "keep-lights-on" }], lead), "never deleted");
  has(run([set("c1", card, "initiatives")], lead), "initiatives/c1: no plan");
  assert.deepEqual(run([set("c1", { ...card, plan: "keep-lights-on", num: 1 }, "initiatives"), set("cardSeq", { next: 2 }, "meta")], builder), []);
  has(run([set("obj-shop", node())], { role: "Collector", manager: false }), "only sets derived/all");
  const linked = mirror([{ id: "obj-shop", ...node() }], [{ id: "c1", plan: "obj-shop" }]);
  has(checkWrites([upd("obj-shop", { text: "Open two shops" })], { config, who: lead, now, state: {}, mirror: linked }).errors, "plan/obj-shop: text: 1 initiative(s) link here");
});
