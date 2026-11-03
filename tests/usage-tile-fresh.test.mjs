// #C623: the Plan week tile read 24% while the real figure was 31% and showed no age: the spend script ran once a day. The probe
// now reads it every five minutes, the state says when the numbers are of (usage.asOf), and the page shows that age and greys the
// tile past 15 minutes.
import test from "node:test";
import assert from "node:assert/strict";
import { usageReading } from "../collector/readings.mjs";
import { stateErrors, pickState } from "../collector/state-schema.mjs";
import { buildState, USAGE_EVERY_MS } from "../collector/state.mjs";
import { changeKey } from "../worker/state-worker.mjs";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const roster = ["Manager"];
const rows = [{ source: "Manager", share: 1 }];

test("the probe reads the spend script every five minutes, well inside the page's 15", () => {
  assert.equal(USAGE_EVERY_MS, 5 * MIN);
});

test("usageReading carries asOf only when it is a time that has passed", () => {
  assert.equal(usageReading({ rows, roster, plan: null, now: T, asOf: T - 4 * MIN }).asOf, T - 4 * MIN);
  for (const bad of [null, undefined, 0, -5, T + 1, 1.5, "x"]) assert.ok(!("asOf" in usageReading({ rows, roster, plan: null, now: T, asOf: bad })), String(bad));
  assert.ok(!("asOf" in usageReading({ rows, roster, plan: null, now: T })), "a caller from before it");
});

test("the state schema: usage.asOf is an optional time; a state without it still fits; a bad one is refused and never passes", () => {
  const base = { id: "b", now: T, probe: null, pageVersion: null, cards: {}, agents: {} };
  const withAsOf = buildState({ ...base, usage: usageReading({ rows, roster, plan: null, now: T, asOf: T - 3 * MIN }) });
  assert.deepEqual(stateErrors(withAsOf), []);
  assert.equal(pickState(withAsOf).usage.asOf, T - 3 * MIN, "it reaches the Worker's copy");
  const without = buildState({ ...base, usage: usageReading({ rows, roster, plan: null, now: T }) });
  assert.deepEqual(stateErrors(without), []);
  assert.ok(stateErrors({ ...withAsOf, usage: { ...withAsOf.usage, asOf: "yesterday" } }).some((e) => /usage\.asOf/.test(e)));
  assert.ok(stateErrors({ ...withAsOf, usage: { ...withAsOf.usage, asOf: -1 } }).some((e) => /usage\.asOf/.test(e)));
});

test("the Worker stores a new state when the usage reading is of a newer run, not only when the heartbeat falls due", () => {
  const mk = (asOf) => buildState({ id: "b", now: T, probe: null, pageVersion: null, cards: {}, agents: {}, usage: usageReading({ rows, roster, plan: null, now: T, asOf }) });
  assert.notEqual(changeKey(mk(T - 9 * MIN)), changeKey(mk(T - 4 * MIN)));
  assert.equal(changeKey(mk(T - 4 * MIN)), changeKey(mk(T - 4 * MIN)));
});

// ---- the page
const page = (probe) => {
  const b = loadNames(["liveUsage", "planTile", "planAge", "PLAN_STALE", "set:(p)=>{probe=p}"]);
  b.set(probe);
  return b;
};
const NOW = Date.now();
const live = (usage) => ({ v: 1, board: { at: NOW }, cards: {}, agents: {}, usage });
const use = (extra) => ({ at: NOW, weekPct: 31, pace: 140, level: "amber", top: [{ src: "Manager", pct: 40 }], ...extra });

test("the tile says how old its numbers are", () => {
  const html = page(live(use({ asOf: NOW - 4 * MIN }))).planTile();
  assert.match(html, /as of 4 min ago/);
  assert.match(html, /class="tot plan amber"/, "fresh: its colour from the level");
  assert.match(html, /31%/);
  assert.match(html, /data-plan-at="/);
});

test("past 15 minutes the tile is grey, whatever its level, and still says its age", () => {
  const b = page(live(use({ asOf: NOW - 16 * MIN, level: "red" })));
  const html = b.planTile();
  assert.match(html, /class="tot plan stale"/);
  assert.doesNotMatch(html, /plan red|plan amber/);
  assert.match(html, /as of 16 min ago/);
  assert.match(html, /31%/, "the number stays, so the owner can see what it was");
  assert.match(page(live(use({ asOf: NOW - 15 * MIN + 5e3 }))).planTile(), /class="tot plan amber"/, "just under 15 minutes: not yet");
});

test("a state with no asOf (a probe from before) is aged by the probe's own clock, and a future asOf is ignored", () => {
  assert.match(page(live(use({ at: NOW - 2 * MIN }))).planTile(), /as of 2 min ago/);
  assert.match(page(live(use({ asOf: NOW + 60 * MIN }))).planTile(), /class="tot plan amber"/);
  assert.equal(page(live(use({ asOf: NOW - 3 * MIN }))).liveUsage(NOW).asOf, NOW - 3 * MIN);
});
