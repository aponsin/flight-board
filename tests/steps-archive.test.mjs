// #C210: closed cards' steps move into timings/<card id>.steps; the page counts a closed card's steps from both places.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBoard, step } from "./harness.mjs";
import { plan } from "../scripts/steps-archive.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { writeErrors } from "../gate/rules.mjs";

const DAY = 864e5;
const NOW = 1_800_000_000_000;
const T = NOW - 3 * DAY;
let n = 0;
const s = (init, phase, who, kind, at, extra) => ({ id: `${init}-${phase}-${kind}-${at}-${n++}`, ...step(init, phase, who, kind, at, extra) });
const shipped = (id, at = T) => [
  s(id, "build", "Builder", "start", at), s(id, "build", "Builder", "start", at + 5), s(id, "build", "Builder", "end", at + 10),
  s(id, "test", "Builder", "start", at + 10), s(id, "test", "Builder", "end", at + 20),
  s(id, "checker", "Checker", "end", at + 30), s(id, "ship", "Release", "start", at + 40, { wait: "busy" }), s(id, "ship", "Release", "end", at + 50, { wait: "busy" }),
  s(id, "ship", "Release", "start", at + 50), s(id, "live", "Release", "end", at + 60, { version: "1.2.3", testsMin: 6.6, deployMin: 2.4 }),
];
const card = (id, fields = {}) => ({ id, level: "Quick", customerText: false, skip: ["plan"], status: "done", name: id, ...fields });
const shown = (b, c) => { const i = b.enrich(c); return JSON.stringify(["status", "phase", "doneAt", "version", "shipDetail", "phaseLog", "skip"].map((k) => i[k])); };
const apply = (steps, timings, batches) => {
  const flat = batches.flat();
  const gone = new Set(flat.filter((w) => w.op === "delete").map((w) => w.doc_id));
  const docs = new Map(timings.map((t) => [t.id, t]));
  for (const w of flat) if (w.collection === "timings") docs.set(w.doc_id, { id: w.doc_id, ...w.data });
  return { steps: steps.filter((x) => !gone.has(x.id)), timings: [...docs.values()] };
};

test("the page shows a closed card the same after the archive as before it", () => {
  const steps = shipped("x");
  const b = loadBoard();
  b.state.waiting = [];
  b.state.steps = steps;
  const c = card("x", { phaseLog: [{ phase: "plan", who: "Manager", start: T - 9, end: T - 1 }] });
  const before = shown(b, c);
  const after = apply(steps, [], plan({ cards: [c], steps, now: NOW }).batches);
  assert.equal(after.steps.length, 0);
  b.state.steps = after.steps;
  b.state.timings = after.timings;
  assert.equal(shown(b, c), before);
  assert.equal(b.enrich(c).shipDetail, "tests 7 min · deploy 2 min");
});

test("a step logged after the archive still counts, and a rerun keeps it (Checker)", () => {
  const steps = shipped("x");
  const first = apply(steps, [], plan({ cards: [card("x")], steps, now: NOW }).batches);
  const lateStep = s("x", "checker", "Checker", "start", T + 25);
  const all = [...steps, lateStep];
  const b = loadBoard();
  b.state.waiting = [];
  b.state.steps = all;
  const want = shown(b, card("x"));
  b.state.steps = [...first.steps, lateStep];
  b.state.timings = first.timings;
  assert.equal(shown(b, card("x")), want, "the late step counts beside the archived ones");
  const again = plan({ cards: [card("x")], steps: [lateStep], timings: first.timings, now: NOW });
  assert.deepEqual(again.batches, [], "the late step is not in the archive, so it is never deleted");
  assert.deepEqual(again.late, [lateStep.id]);
});

test("a stop between batches: the leftover archived steps count once, and a rerun only deletes what is archived", () => {
  const steps = shipped("x");
  const { batches } = plan({ cards: [card("x")], steps, now: NOW });
  const timings = [{ id: "x", ...batches[0][0].data }];
  const b = loadBoard();
  b.state.waiting = [];
  b.state.steps = steps;
  const want = shown(b, card("x"));
  b.state.steps = steps.slice(0, 3);
  b.state.timings = timings;
  assert.equal(shown(b, card("x")), want);
  const again = plan({ cards: [card("x")], steps: steps.slice(0, 3), timings, now: NOW });
  assert.deepEqual(again.batches.flat().map((w) => w.op + " " + w.doc_id), steps.slice(0, 3).map((x) => "delete " + x.id));
});

test("an open card's timings never count (Security): a stray timings doc can't make it look shipped", () => {
  const b = loadBoard();
  b.state.waiting = [];
  b.state.steps = [s("o", "build", "Builder", "start", T)];
  b.state.timings = [{ id: "o", steps: shipped("o") }];
  const i = b.enrich(card("o", { status: "active" }));
  assert.equal(i.status, "active");
  assert.equal(i.phase, "build");
});

test("plan: only cards closed --days ago or more; open and recent ones keep their steps", () => {
  const steps = [...shipped("old"), ...shipped("new", NOW - 3600e3), ...shipped("open"), s("bare", "build", "Builder", "start", T)];
  const cards = [card("old"), card("new"), card("open", { status: "active" }), card("dropped", { status: "dropped", dropReason: "no" }), card("bare", { status: "dropped", dropReason: "no" })];
  const { batches, ids } = plan({ cards, steps, now: NOW });
  assert.deepEqual(ids, ["old", "bare"]);
  const w = batches.flat();
  assert.deepEqual(w.filter((x) => x.collection === "timings").map((x) => x.doc_id), ["old", "bare"]);
  assert.equal(w.filter((x) => x.op === "delete").length, 11);
  assert.ok(w.every((x) => x.op === "delete" ? x.collection === "steps" : x.collection === "timings" && x.op === "set"), "it writes timings and deletes steps, nothing else");
  assert.deepEqual(plan({ cards, steps, now: NOW, days: 0 }).ids, ["old", "new", "bare"]);
});

test("plan: each card's timings come before its first delete, batches of at most 49, every step in the archive", () => {
  const many = Array.from({ length: 70 }, (_, k) => s("big", "build", "Builder", k % 2 ? "end" : "start", T + k));
  const { batches } = plan({ cards: [card("big"), card("x")], steps: [...many, ...shipped("x")], now: NOW });
  assert.ok(batches.every((b) => b.length <= 49));
  const flat = batches.flat();
  for (const id of ["big", "x"]) {
    const t = flat.findIndex((w) => w.collection === "timings" && w.doc_id === id);
    const first = flat.findIndex((w) => w.op === "delete" && w.doc_id.startsWith(`${id}-`));
    assert.ok(t >= 0 && t < first, id);
  }
  assert.equal(flat.find((w) => w.doc_id === "big").data.steps.length, 70);
});

test("the gate: only the lead writes timings or deletes steps (Security, Checker)", () => {
  const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01" });
  const now = 1_792_998_566_220;
  const agent = { role: "Builder", manager: false }, lead = { role: "Manager", manager: true };
  const forge = { op: "set", collection: "timings", doc_id: "card-a", data: { steps: [], at: now } };
  const erase = { op: "delete", collection: "steps", doc_id: "x-checker-start-1" };
  assert.match(writeErrors(forge, { config, who: agent, now: now })[0] ?? "", /^only Manager archives steps/);
  assert.match(writeErrors({ ...forge, op: "delete", data: undefined }, { config, who: agent, now: now })[0] ?? "", /only Manager archives steps/);
  assert.match(writeErrors(erase, { config, who: agent, now: now })[0] ?? "", /^only Manager deletes steps/);
  assert.deepEqual(writeErrors(forge, { config, who: lead, now: now }), []);
  assert.deepEqual(writeErrors(erase, { config, who: lead, now: now }), []);
  assert.deepEqual(writeErrors({ op: "set", collection: "steps", doc_id: "x-build-start-1", data: step("x", "build", "Builder", "start", now - 1) }, { config, who: agent, now: now }), [], "agents still log steps");
});
