// #C988: a session that can call get_usage (the context keeper, each run) writes the week's "Weekly · all models" percent to the store with
// the week_usage tool; the dispatch's quota stop and the Plan week tile (#C842's line) prefer it to the probe's estimate while it is under an
// hour old, and read an older one as unknown (no stop, a warning). Must still allow, as tests: no reading yet (no stop); a reading under the
// ceiling; the ceiling from board.config (99 this week, 90 normally). Fictional cards and times.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { loadNames } from "./harness.mjs";
import { writeWeekUsage, writeEvidence, readView } from "../worker/board-store.mjs";
import { probeDoc } from "../worker/compat-view.mjs";
import worker, { TOOLS } from "../worker/board-worker.mjs";
import { dispatchRun, weekPctOf } from "../collector/store-dispatch.mjs";
import { weekUsageValue, sessionWeek, withSessionWeek, SESSION_WEEK_FRESH_MS, WEEK_USAGE_KEY } from "../collector/week-usage.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3, HOUR = 3600e3, DAY = 24 * HOUR;
const RESET = NOW + 3 * DAY + 18 * HOUR, RESET_ISO = new Date(RESET).toISOString();
const ROSTER = ["Manager", "Builder", "Checker"], LEAD = "Manager";
const card = (id, num) => ({ id, num, owner_role: "Builder", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "" });
// est: the probe's estimate (evidence.usage weekPct); week: a session's reading { pct, at, resetsAt }.
const world = ({ est, week } = {}) => ({
  now: NOW,
  cards: [card("new-work", 900), card("in-review", 901)],
  asks: [],
  evidence: {
    agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN }])) },
    ...(est === undefined ? {} : { usage: { readAt: NOW - 2 * MIN, value: { at: NOW - 2 * MIN, weekPct: est, pace: 90, level: "ok", top: [] } } }),
    ...(week === undefined ? {} : { [WEEK_USAGE_KEY]: { readAt: week.at ?? NOW - 10 * MIN, value: { pct: week.pct, resetsAt: week.resetsAt ?? RESET, by: "Manager" } } }),
    "cards.in-review": { readAt: NOW - 5_000, value: { lit: ["checker"], phase: "checker", headSha12: "8b3855f0f672", signed: [], onMain: false } },
  },
});
const go = (v, ceiling) => {
  const lines = [];
  const items = dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "c988-")), roster: ROSTER, lead: LEAD, now: NOW, log: (l) => lines.push(l), ...(ceiling === undefined ? {} : { ceiling }) }).items.map((i) => `${i.role}:${i.card}:${i.step}`).sort();
  return { items, lines };
};
const ALL = ["Builder:new-work:build", "Checker:in-review:review"], STOPPED = ["Checker:in-review:review"];

test("the tool: offered to agents (both connector doors), takes percent and resets_at only", () => {
  const t = TOOLS.find((x) => x.name === "week_usage");
  assert.deepEqual(t.roles, ["agent"]);
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ["percent", "resets_at"]);
  assert.deepEqual(t.inputSchema.required, ["percent", "resets_at"]);
  assert.equal(t.inputSchema.additionalProperties, false);
});

test("a write stores { pct, resetsAt, by } under usage.week, by the role the caller names (a claim on the shared door); the view carries it", async () => {
  const db = makeDb();
  assert.deepEqual(await writeWeekUsage(db, NOW, "Manager", { percent: 85, resets_at: RESET_ISO }), { ok: true });
  const v = await readView(db, NOW);
  assert.deepEqual(v.evidence[WEEK_USAGE_KEY].value, { pct: 85, resetsAt: RESET, by: "Manager" });
  assert.equal(v.evidence[WEEK_USAGE_KEY].readAt, NOW);
  await writeWeekUsage(db, NOW + MIN, "Manager", { percent: 86, resets_at: RESET_ISO });
  assert.equal((await readView(db, NOW + MIN)).evidence[WEEK_USAGE_KEY].value.pct, 86, "a newer reading replaces the last");
});

test("every wrong write is refused by name and stores nothing", async () => {
  const db = makeDb();
  for (const bad of [{ percent: 85.5, resets_at: RESET_ISO }, { percent: -1, resets_at: RESET_ISO }, { percent: 101, resets_at: RESET_ISO }, { percent: "85", resets_at: RESET_ISO },
    { percent: 85, resets_at: "soon" }, { percent: 85, resets_at: RESET }, { percent: 85, resets_at: new Date(NOW - MIN).toISOString() }, { percent: 85, resets_at: new Date(NOW + 9 * DAY).toISOString() }, {}]) {
    const r = await writeWeekUsage(db, NOW, "Manager", bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.refused.rule, "week-usage-shape", JSON.stringify(bad));
  }
  assert.equal((await readView(db, NOW)).evidence[WEEK_USAGE_KEY], undefined);
  assert.ok(weekUsageValue({ percent: 0, resets_at: RESET_ISO }, NOW, "Builder").value, "0% is a reading (a fresh week)");
  assert.ok(weekUsageValue({ percent: 100, resets_at: RESET_ISO }, NOW, "Builder").value);
});

test("the probe can't write the sessions' key through the evidence endpoint", async () => {
  const db = makeDb();
  const r = await writeEvidence(db, NOW, "probe", WEEK_USAGE_KEY, { pct: 1, resetsAt: RESET, by: "probe" });
  assert.equal(r.ok, false);
  assert.equal((await readView(db, NOW)).evidence[WEEK_USAGE_KEY], undefined);
});

test("sessionWeek: fresh under an hour; stale past it, from the future, or from a week that reset; none when absent", () => {
  assert.equal(sessionWeek(world({ week: { pct: 85 } }), NOW).state, "fresh");
  assert.equal(sessionWeek(world({ week: { pct: 85, at: NOW - SESSION_WEEK_FRESH_MS } }), NOW).state, "fresh", "exactly an hour is still fresh");
  assert.equal(sessionWeek(world({ week: { pct: 85, at: NOW - SESSION_WEEK_FRESH_MS - 1 } }), NOW).state, "stale");
  assert.equal(sessionWeek(world({ week: { pct: 85, at: NOW + 5 * MIN } }), NOW).state, "stale", "from the future");
  assert.equal(sessionWeek(world({ week: { pct: 85, resetsAt: NOW - MIN } }), NOW).state, "stale", "the week it was read in has reset");
  assert.equal(sessionWeek(world(), NOW).state, "none");
  assert.equal(sessionWeek(world({ week: { pct: 150 } }), NOW).state, "none", "a value of no shape is no reading");
});

test("must allow: no reading yet stops nothing", () => {
  assert.deepEqual(go(world()).items, ALL, "no session reading, no estimate");
  assert.deepEqual(go(world({ est: null })).items, ALL, "no session reading, an estimate with no percent");
});

test("must allow: a fresh reading under the ceiling stops nothing; at it, new build work stops", () => {
  assert.deepEqual(go(world({ week: { pct: 89 } })).items, ALL);
  assert.deepEqual(go(world({ week: { pct: 90 } })).items, STOPPED);
});

test("must allow: the ceiling is board.config's: 99 this week lets 97% through and stops at 99; 90 normally", () => {
  assert.deepEqual(go(world({ week: { pct: 97 } }), 99).items, ALL);
  assert.deepEqual(go(world({ week: { pct: 99 } }), 99).items, STOPPED);
  assert.deepEqual(go(world({ week: { pct: 97 } }), 90).items, STOPPED);
});

test("the session's reading wins over the estimate both ways (the estimate read 28% while Claude showed 39%)", () => {
  assert.equal(weekPctOf(world({ est: 28, week: { pct: 91 } }), NOW), 91);
  assert.deepEqual(go(world({ est: 28, week: { pct: 91 } })).items, STOPPED, "the estimate under, Claude over: stop");
  assert.deepEqual(go(world({ est: 95, week: { pct: 50 } })).items, ALL, "the estimate over, Claude under: no stop");
});

test("an hour-old reading is unknown: no stop, even with an estimate over the ceiling, and a warning in the log", () => {
  const old = world({ est: 95, week: { pct: 95, at: NOW - SESSION_WEEK_FRESH_MS - MIN } });
  assert.equal(weekPctOf(old, NOW), null);
  const r = go(old);
  assert.deepEqual(r.items, ALL);
  assert.ok(r.lines.some((l) => /warning: the session's week reading is 61 min old/.test(l)), r.lines.join("\n"));
  assert.ok(!go(world({ week: { pct: 50 } })).lines.some((l) => /warning/.test(l)), "a fresh reading warns nothing");
});

test("with no session reading ever written, the estimate still counts (as before #C988)", () => {
  assert.deepEqual(go(world({ est: 95 })).items, STOPPED);
  assert.deepEqual(go(world({ est: 50 })).items, ALL);
});

test("#C842's line: the Plan week tile shows Claude's percent from a fresh reading, its pace and level, and says where it came from", () => {
  const tile = probeDoc(world({ est: 28, week: { pct: 39 } })).usage;
  assert.equal(tile.weekPct, 39);
  assert.equal(tile.src, "session");
  assert.equal(tile.srcAt, NOW - 10 * MIN);
  // 3 d 18 h left of 7 d: 3 d 6 h gone (0.4643 of the week); 39% over that is a pace of 84%.
  assert.equal(tile.pace, 84);
  assert.equal(tile.level, "ok");
  assert.equal(withSessionWeek(tile, world({ week: { pct: 95 } }), NOW).level, "red", "95% at under half the week is past the red pace");
  const est = probeDoc(world({ est: 28, week: { pct: 39, at: NOW - 2 * HOUR } })).usage;
  assert.equal(est.weekPct, 28, "a stale reading leaves the estimate on the tile");
  assert.equal(est.src, undefined);
  assert.equal(probeDoc(world({ week: { pct: 39 } })).usage, undefined, "no probe tile, nothing to put the reading on");
});

// Through the doors themselves: the shared door with `as` (the keeper writes as Manager) and Manager's own; the writer is the door's.
test("end to end: week_usage through the shared door and Manager's door stores the reading with the door's writer", async () => {
  const hash = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const S = "s".repeat(43), M = "m".repeat(43);
  const env = { DB: makeDb(), CONNECTOR_HASH: await hash(S), MANAGER_CONNECTOR_HASH: await hash(M) };
  const call = async (secret, args) => (await (await worker.fetch(new Request(`https://board.test/mcp/${secret}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "week_usage", arguments: args } }) }), env, null, NOW, async () => null)).json()).result;
  assert.equal((await call(S, { as: "Manager", percent: 85, resets_at: RESET_ISO })).isError, false);
  assert.deepEqual((await readView(env.DB, NOW)).evidence[WEEK_USAGE_KEY].value, { pct: 85, resetsAt: RESET, by: "Manager" });
  assert.equal((await call(S, { as: "Builder", percent: 86, resets_at: RESET_ISO })).isError, false);
  assert.equal((await readView(env.DB, NOW)).evidence[WEEK_USAGE_KEY].value.by, "Builder", "the writer is the role that called");
  assert.equal((await call(M, { percent: 87, resets_at: RESET_ISO })).isError, false);
  assert.equal((await readView(env.DB, NOW)).evidence[WEEK_USAGE_KEY].value.by, "Manager");
  assert.equal((await call(S, { as: "Builder", percent: 101, resets_at: RESET_ISO })).isError, true, "a refused write says so");
  assert.equal((await readView(env.DB, NOW)).evidence[WEEK_USAGE_KEY].value.pct, 87, "and stores nothing");
});

// The page: a tile from a session reads "Plan week", as Claude shows it; the estimate keeps "(est.)" and its scope line; no other src passes.
test("the page: src session drops (est.) and says as Claude shows it; the estimate is labelled as before", () => {
  const b = loadNames(["liveUsage", "planTile", "planAge", "PLAN_STALE", "set:(p)=>{probe=p}"]);
  const t0 = Date.now(), tile = (extra) => ({ v: 1, board: { at: t0 }, cards: {}, agents: {}, usage: { at: t0, asOf: t0 - MIN, weekPct: 85, pace: 120, level: "ok", top: [], ...extra } });
  b.set(tile({ src: "session" }));
  let html = b.planTile();
  assert.match(html, /<div class="l">Plan week<\/div>/);
  assert.match(html, /as Claude shows it/);
  assert.match(html, /85%/);
  assert.doesNotMatch(html, /est\.|this Mac/);
  for (const src of [undefined, "probe", "<b>x</b>"]) {
    b.set(tile(src === undefined ? {} : { src }));
    html = b.planTile();
    assert.match(html, /Plan week \(est\.\)/, String(src));
    assert.match(html, /this Mac's Claude Code only/, String(src));
    assert.doesNotMatch(html, /<b>x/, "no src text reaches the page");
  }
});

// Security's FINDINGS on 833c7b5: a guard refusing a lower percent was worse than none. Each write replaces the last, so a bad write (a 100 with
// the stored reset time, or a low one) lasts only until the keeper's next true reading.
test("each write replaces the last: a bad 100 does not lock out the keeper's true, lower reading, and a low one is replaced by the next", async () => {
  const db = makeDb();
  await writeWeekUsage(db, NOW, "Manager", { percent: 85, resets_at: RESET_ISO });
  assert.deepEqual(await writeWeekUsage(db, NOW + MIN, "Builder", { percent: 100, resets_at: RESET_ISO }), { ok: true });
  assert.deepEqual(await writeWeekUsage(db, NOW + 2 * MIN, "Manager", { percent: 86, resets_at: RESET_ISO }), { ok: true }, "the keeper's true reading goes in");
  assert.equal((await readView(db, NOW + 2 * MIN)).evidence[WEEK_USAGE_KEY].value.pct, 86);
  assert.deepEqual(await writeWeekUsage(db, NOW + 3 * MIN, "Builder", { percent: 5, resets_at: RESET_ISO }), { ok: true });
  assert.deepEqual(await writeWeekUsage(db, NOW + 4 * MIN, "Manager", { percent: 87, resets_at: RESET_ISO }), { ok: true });
  assert.equal((await readView(db, NOW + 4 * MIN)).evidence[WEEK_USAGE_KEY].value.pct, 87);
  assert.equal(weekUsageValue({ percent: 10, resets_at: RESET_ISO }, NOW, "Builder").value?.pct, 10, "the rule takes no stored value");
});
