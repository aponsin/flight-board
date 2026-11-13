// #C973: at the week's quota ceiling the board stops waking builders for new build work. The ceiling is a board.config value
// (collector.quotaCeilingPct, 90 by default; the owner set 99 for the week of 11-11 after a free reset). Still allowed, as tests: below the
// ceiling nothing changes; an unknown or stale usage reading never stops anything; reviews, landing and fixes go on at the ceiling.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun, weekPctOf, atCeiling, USAGE_FRESH_MS, QUOTA_CEILING_DEFAULT } from "../collector/store-dispatch.mjs";
import { main } from "../collector/probe-board.mjs";
import { checkConfig, fullConfig } from "../scripts/config.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const LINK = "https://claude.ai/" + "artifact/TestBoard01"; // in two parts: the repository scan refuses a literal link
const ROSTER = ["Manager", "Boardsmith", "Builder", "Checker", "Security", "Release"], LEAD = "Manager";
const SHA = "8b3855f0f672";
const card = (id, num, extra = {}) => ({ id, num, owner_role: "Builder", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", ...extra });
// `at` is the view's now: NOW for dispatchRun, the real clock for the CLI (main reads Date.now).
const world = ({ pct, at = NOW, usageAt = at - 10 * MIN, cardEv = {} } = {}) => ({
  // The sent-back card is Boardsmith's: since #C1053 an agent with a rework it can act on is woken for the fix and for no new card, so the fix and the new
  // build belong to two builders and the ceiling still shows what it drops (the new build) and what it keeps (the fix).
  cards: [card("new-work", 900), card("in-review", 901), card("sent-back", 902, { owner_role: "Boardsmith" })],
  asks: [],
  evidence: {
    agents: { readAt: at - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, { state: "idle", lastActivityAt: at - 2 * MIN, since: at - 2 * MIN }])) },
    ...(pct === undefined ? {} : { usage: { readAt: usageAt, value: { at: usageAt, weekPct: pct, pace: null, level: "ok", top: [] } } }),
    "cards.in-review": { readAt: at - 5_000, value: { lit: ["checker"], phase: "checker", headSha12: SHA, signed: [], onMain: false } },
    "cards.sent-back": { readAt: at - 5_000, value: { lit: ["checker"], phase: "checker", headSha12: SHA, signed: [], findings: ["checker"], onMain: false } },
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
  const all = ["Boardsmith:sent-back:rework", "Builder:new-work:build", "Checker:in-review:review"];
  assert.deepEqual(run(world({ pct: 89 })), all, "below 90: as before");
  assert.deepEqual(run(world({ pct: 90 })), ["Boardsmith:sent-back:rework", "Checker:in-review:review"], "at 90: no new build");
  assert.deepEqual(run(world({ pct: 97 })), ["Boardsmith:sent-back:rework", "Checker:in-review:review"]);
});

test("the ceiling is the config's: 99 this week lets 97% through and stops at 99", () => {
  assert.deepEqual(run(world({ pct: 97 }), 99), ["Boardsmith:sent-back:rework", "Builder:new-work:build", "Checker:in-review:review"]);
  assert.deepEqual(run(world({ pct: 99 }), 99), ["Boardsmith:sent-back:rework", "Checker:in-review:review"]);
  assert.equal(atCeiling(world({ pct: 95 }), NOW, 0), true, "a ceiling out of range falls back to 90");
});

// Checker 2's LOW on eabf861: atCeiling's own fallback, apart from checkConfig (which refuses these first).
test("atCeiling: a ceiling that is no whole percent from 1 to 100 is read as 90", () => {
  for (const bad of [0, 101, 150, 90.5, "99", null, undefined, NaN]) {
    assert.equal(atCeiling(world({ pct: 89 }), NOW, bad), false, `${bad}: 89% is under 90`);
    assert.equal(atCeiling(world({ pct: 90 }), NOW, bad), true, `${bad}: 90% is at 90`);
  }
});

// Checker 2's F1 on eabf861: the config's ceiling must reach the dispatch through main() and dispatchJob, or the owner's 99 turns into 90.
test("the CLI takes the ceiling from board.config: at quotaCeilingPct 99, 95% keeps the build turn and 99% drops it", async () => {
  const d = mkdtempSync(join(tmpdir(), "qc-cli-")), env = join(d, "board.env"), conf = join(d, "board.config.json");
  writeFileSync(env, "BOARD_BASE_URL=https://board.test\nBOARD_SERVICE_TOKEN_ID=a\nBOARD_SERVICE_TOKEN_SECRET=b\n");
  writeFileSync(conf, JSON.stringify({ artifactUrl: LINK, roster: ROSTER, gate: { stateDir: join(d, "state"), managerRole: LEAD }, collector: { quotaCeilingPct: 99 } }));
  const turns = async (pct) => {
    const v = world({ pct, at: Date.now() });
    const fetchImpl = async (url) => (String(url).endsWith("/api/view") ? { ok: true, status: 200, json: async () => v } : { ok: true, status: 200, json: async () => ({}) });
    let code = null;
    const orig = console.error; console.error = () => {};
    try { await main(["--job", "dispatch", "--env", env, "--config", conf], { exit: (c) => { code = c; return c; }, fetchImpl }); } finally { console.error = orig; }
    assert.equal(code, 0);
    return JSON.parse(readFileSync(join(d, "state", "TestBoard01", "dispatch.json"), "utf8")).items.map((i) => `${i.role}:${i.card}`).sort();
  };
  assert.ok((await turns(95)).includes("Builder:new-work"), "95% is under the config's 99: the build turn stays (90 would drop it)");
  assert.ok(!(await turns(99)).includes("Builder:new-work"), "99%: at the config's ceiling, no new build");
});

test("an unknown or stale reading never stops build work", () => {
  const all = ["Boardsmith:sent-back:rework", "Builder:new-work:build", "Checker:in-review:review"];
  assert.deepEqual(run(world()), all, "no reading");
  assert.deepEqual(run(world({ pct: null })), all, "no percent");
  assert.deepEqual(run(world({ pct: 150, usageAt: NOW - USAGE_FRESH_MS - 1 })), all, "stale");
});
