// #C210: closed cards' steps move into timings/<card id>; the page shows the same card from either.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBoard, step } from "./harness.mjs";
import { plan, phaseLog } from "../scripts/steps-archive.mjs";

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

test("the page shows a closed card the same from its archived timings as from its steps", () => {
  const steps = shipped("x");
  const b = loadBoard();
  b.state.waiting = [];
  b.state.steps = steps;
  const before = b.enrich(card("x", { phaseLog: [{ phase: "plan", who: "Manager", start: T - 9, end: T - 1 }] }));
  const { batches } = plan({ cards: [card("x")], steps, now: NOW });
  const timings = batches.flat().find((w) => w.collection === "timings");
  b.state.steps = [];
  b.state.timings = [{ id: "x", ...timings.data }];
  const after = b.enrich(card("x", { phaseLog: [{ phase: "plan", who: "Manager", start: T - 9, end: T - 1 }] }));
  for (const k of ["status", "phase", "doneAt", "version", "shipDetail", "phaseLog", "skip"]) assert.equal(JSON.stringify(after[k]), JSON.stringify(before[k]), k);
  assert.equal(after.shipDetail, "tests 7 min · deploy 2 min");
});

test("once a card has its timings, its leftover steps no longer count (a stop between batches)", () => {
  const steps = shipped("x");
  const b = loadBoard();
  b.state.waiting = [];
  b.state.timings = [{ id: "x", phaseLog: phaseLog(steps).log, live: true, doneAt: T + 60 }];
  b.state.steps = steps.slice(0, 3);
  assert.equal(b.enrich(card("x")).phaseLog.length, phaseLog(steps).log.length);
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
  const bare = w.find((x) => x.doc_id === "bare");
  assert.equal(bare.data.live, undefined, "a dropped card never went live");
});

test("plan: each card's timings come before its first delete, batches of at most 49, the steps kept in the archive", () => {
  const many = Array.from({ length: 70 }, (_, k) => s("big", "build", "Builder", k % 2 ? "end" : "start", T + k));
  const { batches } = plan({ cards: [card("big"), card("x")], steps: [...many, ...shipped("x")], now: NOW });
  assert.ok(batches.every((b) => b.length <= 49));
  const flat = batches.flat();
  for (const id of ["big", "x"]) {
    const t = flat.findIndex((w) => w.collection === "timings" && w.doc_id === id);
    const first = flat.findIndex((w) => w.op === "delete" && w.doc_id.startsWith(`${id}-`));
    assert.ok(t >= 0 && t < first, id);
  }
  const big = flat.find((w) => w.doc_id === "big");
  assert.equal(big.data.steps.length, 70);
  assert.ok(big.data.steps.every((x) => x.id && x.init === "big"));
});

test("plan: run again after a stop, a card with its timings gets only its remaining deletes", () => {
  const steps = shipped("x");
  const { batches } = plan({ cards: [card("x")], steps: steps.slice(4), timings: [{ id: "x" }], now: NOW });
  assert.deepEqual(batches.flat().map((w) => w.op), Array(steps.length - 4).fill("delete"));
  assert.deepEqual(plan({ cards: [card("x")], steps: [], now: NOW }).batches, []);
});
