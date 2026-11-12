// #C973: at the week's quota ceiling the board stops waking builders for new build work. The ceiling is a board.config value
// (collector.quotaCeilingPct, 90 by default; the owner set 99 for the week of 11-11 after a free reset). Still allowed, as tests: below the
// ceiling nothing changes; an unknown or stale usage reading never stops anything; reviews, landing and fixes go on at the ceiling.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun, weekPctOf, atCeiling, USAGE_FRESH_MS, QUOTA_CEILING_DEFAULT } from "../collector/store-dispatch.mjs";
import { checkConfig, fullConfig } from "../scripts/config.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Builder", "Checker", "Security", "Release"], LEAD = "Manager";
const SHA = "8b3855f0f672";
const idle = { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN };
const card = (id, num, extra = {}) => ({ id, num, owner_role: "Builder", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", ...extra });
const world = ({ pct, usageAt = NOW - 10 * MIN, cardEv = {} } = {}) => ({
  cards: [card("new-work", 900), card("in-review", 901), card("sent-back", 902)],
  asks: [],
  evidence: {
    agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle])) },
    ...(pct === undefined ? {} : { usage: { readAt: usageAt, value: { at: usageAt, weekPct: pct, pace: null, level: "ok", top: [] } } }),
    "cards.in-review": { readAt: NOW - 5_000, value: { lit: ["checker"], phase: "checker", headSha12: SHA, signed: [], onMain: false } },
    "cards.sent-back": { readAt: NOW - 5_000, value: { lit: ["checker"], phase: "checker", headSha12: SHA, signed: [], findings: ["checker"], onMain: false } },
    ...cardEv,
  },
});
const run = (v, ceiling) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "qc-")), roster: ROSTER, lead: LEAD, now: NOW, ...(ceiling === undefined ? {} : { ceiling }) }).items.map((i) => `${i.role}:${i.card}:${i.step}`).sort();

test("the config: quotaCeilingPct is a whole percent from 1 to 100, 90 by default", () => {
  assert.equal(fullConfig({}).collector.quotaCeilingPct, 90);
  assert.equal(QUOTA_CEILING_DEFAULT, 90);
  assert.deepEqual(checkConfig({ collector: { quotaCeilingPct: 99 } }), []);
  for (const bad of [0, 101, 90.5, "90", null]) assert.match(checkConfig({ collector: { quotaCeilingPct: bad } }).join(), /quotaCeilingPct/, String(bad));
});

test("weekPctOf: a fresh reading's percent; a missing, null, stale or future one is unknown", () => {
  assert.equal(weekPctOf(world({ pct: 91 }), NOW), 91);
  assert.equal(weekPctOf(world(), NOW), null, "no usage reading");
  assert.equal(weekPctOf(world({ pct: null }), NOW), null, "the probe had no quota to work from (today's live reading)");
  assert.equal(weekPctOf(world({ pct: 95, usageAt: NOW - USAGE_FRESH_MS - 1 }), NOW), null, "stale");
  assert.equal(weekPctOf(world({ pct: 95, usageAt: NOW + 5 * MIN }), NOW), null, "from the future");
});

test("at the ceiling no builder is woken for new build work; reviews and the fix of a sent-back card go on", () => {
  const all = ["Builder:new-work:build", "Builder:sent-back:rework", "Checker:in-review:review"];
  assert.deepEqual(run(world({ pct: 89 })), all, "below 90: as before");
  assert.deepEqual(run(world({ pct: 90 })), ["Builder:sent-back:rework", "Checker:in-review:review"], "at 90: no new build");
  assert.deepEqual(run(world({ pct: 97 })), ["Builder:sent-back:rework", "Checker:in-review:review"]);
});

test("the ceiling is the config's: 99 this week lets 97% through and stops at 99", () => {
  assert.deepEqual(run(world({ pct: 97 }), 99), ["Builder:new-work:build", "Builder:sent-back:rework", "Checker:in-review:review"]);
  assert.deepEqual(run(world({ pct: 99 }), 99), ["Builder:sent-back:rework", "Checker:in-review:review"]);
  assert.equal(atCeiling(world({ pct: 95 }), NOW, 0), true, "a ceiling out of range falls back to 90");
});

test("an unknown or stale reading never stops build work", () => {
  const all = ["Builder:new-work:build", "Builder:sent-back:rework", "Checker:in-review:review"];
  assert.deepEqual(run(world()), all, "no reading");
  assert.deepEqual(run(world({ pct: null })), all, "no percent");
  assert.deepEqual(run(world({ pct: 150, usageAt: NOW - USAGE_FRESH_MS - 1 })), all, "stale");
});
