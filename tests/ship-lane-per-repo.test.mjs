// #C975: each repository has its own ship lane. A board card at ship is the landing job's (scripts/board-land.mjs, #C967) while the job's report is
// fresh; Release is woken for it only when the job refused that exact tip. A product card stays Release's. Must still allow, each a test: a product
// card's landing wakes Release whatever the report says; with no report, a stale one or a future one (the job is not running) Release lands board
// cards by hand as before; a refused board tip wakes Release; a board card with no full sha wakes Release.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnsOf, landingFrom, LAND_REPORT_FILE, LAND_REPORT_FRESH_MS, dispatchRun } from "../collector/store-dispatch.mjs";
import { launchdPlist, JOBS, OUTER_EXTRA_SEC } from "../collector/probe-run.mjs";
import { LAND_TIP_SEC, LAND_MARGIN_SEC } from "../worker/probe-jobs.mjs";
import { landRun } from "../scripts/board-land.mjs";

const SHA = "a".repeat(40), OTHER = "b".repeat(40), NOW = Date.parse("2026-11-13T08:00:00.000Z");
const card = (repo) => ({ id: "c1", num: 1, owner_role: "Builder", review_level: "Full", ...(repo === undefined ? {} : { repo }) });
const ev = (over = {}) => ({ phase: "ship", onMain: false, headSha: SHA, headSha12: SHA.slice(0, 12), repoFull: "acme/flight-board", headBranch: "build/x", signed: ["checker", "security"], ...over });
const roles = (t) => t.map((x) => `${x.role}:${x.step}`);
const fresh = (refused = []) => landingFrom({ at: NOW - 60e3, landed: [], refused: refused.map((sha) => ({ branch: "build/x", sha, cards: ["c1"], reasons: ["r"] })), waiting: [] }, NOW);

test("a board card at ship is the landing job's while its report is fresh: no Release turn", () => {
  for (const repo of ["flight-board", "board"]) assert.deepEqual(turnsOf(card(repo), ev(), { landing: fresh() }), [], repo);
  assert.deepEqual(turnsOf(card("flight-board"), ev(), { landing: fresh([OTHER]) }), [], "another tip refused: this one is still the job's");
});

test("must still allow: a refused board tip wakes Release to land it by hand", () => {
  assert.deepEqual(roles(turnsOf(card("flight-board"), ev(), { landing: fresh([SHA]) })), ["Release:land"]);
});

test("must still allow: a product card's landing is Release's whatever the landing report says", () => {
  for (const repo of [undefined, null, "", "shop-site"]) assert.deepEqual(roles(turnsOf(card(repo), ev(), { landing: fresh() })), ["Release:land"], String(repo));
});

test("must still allow: no report, a stale one or a future one: Release lands board cards by hand, as before", () => {
  assert.deepEqual(roles(turnsOf(card("flight-board"), ev())), ["Release:land"], "no landing context");
  for (const report of [null, {}, { at: "x" }, { at: NOW - LAND_REPORT_FRESH_MS - 1 }, { at: NOW + 61e3 }, "text"]) {
    const l = landingFrom(report, NOW);
    assert.equal(l.fresh, false, JSON.stringify(report));
    assert.deepEqual(roles(turnsOf(card("flight-board"), ev(), { landing: l })), ["Release:land"], JSON.stringify(report));
  }
  assert.equal(landingFrom({ at: NOW - LAND_REPORT_FRESH_MS }, NOW).fresh, true, "exactly LAND_REPORT_FRESH_MS (25 minutes) is still fresh");
  assert.equal(landingFrom({ at: NOW + 60e3 }, NOW).fresh, true, "a minute's clock leeway");
});

test("must still allow: a board card with no full sha in its evidence wakes Release (the job's refusal could not be matched)", () => {
  assert.deepEqual(roles(turnsOf(card("flight-board"), ev({ headSha: undefined }), { landing: fresh() })), ["Release:land"]);
});

test("landingFrom keeps only 40-hex refused shas, and only from a fresh report", () => {
  const l = landingFrom({ at: NOW, refused: [{ sha: SHA }, { sha: "short" }, { sha: SHA.toUpperCase() }, null, { sha: 5 }] }, NOW);
  assert.deepEqual([...l.refused], [SHA]);
  assert.deepEqual([...landingFrom({ at: NOW - LAND_REPORT_FRESH_MS - 1, refused: [{ sha: SHA }] }, NOW).refused], []);
});

test("the dispatch run reads land-report.json beside its other files: a fresh report keeps Release asleep for a board card", () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-lane-"));
  try {
    const view = (repo) => ({ evidence: { agents: { value: { Builder: { state: "idle", since: NOW - 3600e3 }, Release: { state: "idle", since: NOW - 3600e3 } }, readAt: NOW }, "cards.c1": { value: ev() } }, cards: [{ ...card(repo), updated_at: NOW - 3600e3 }], asks: [] });
    const roster = ["Builder", "Release", "Manager"];
    const releaseItems = (repo) => dispatchRun(view(repo), { dir, roster, lead: "Manager", now: NOW }).items.filter((i) => /Release/.test(JSON.stringify(i)));
    writeFileSync(join(dir, LAND_REPORT_FILE), JSON.stringify({ at: NOW - 60e3, landed: [], refused: [], waiting: [] }));
    assert.equal(releaseItems("flight-board").length, 0, "the job's lane");
    rmSync(join(dir, LAND_REPORT_FILE));
    rmSync(join(dir, "dispatch-state.json"), { force: true });
    assert.ok(releaseItems("flight-board").length > 0, "no report: Release");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the land job's launchd plist runs board-land.mjs with only --config: no --job argument", () => {
  const PIN = "c".repeat(40), script = `/h/.flight-board/install/${PIN}/scripts/board-land.mjs`;
  const p = launchdPlist({ job: "land", label: "com.flight-board.store.land", nodePath: "/usr/bin/node", script, args: ["--config", "/h/board.config.json"], logPath: "/h/land.log" });
  assert.doesNotMatch(p, /--job/);
  assert.match(p, new RegExp(`<string>/h/\\.flight-board/install/${PIN}/scripts/board-land\\.mjs</string><string>--config</string><string>/h/board\\.config\\.json</string></array>`));
  assert.match(p, new RegExp(`<key>StartInterval</key><integer>${JOBS.land.intervalSec}</integer>`));
  assert.match(launchdPlist({ job: "dispatch", label: "x", nodePath: "n", script: "s", logPath: "l" }), /<string>--job<\/string><string>dispatch<\/string>/, "the probe's jobs keep --job");
});

// #C1144 (Checker 2's LOW on #C1140): launchdPlist builds the land job's plist only for the pinned install, so a pack that rebuilds the agents cannot put it back on the link.
test("the land job's launchd plist is refused for the linked copy, a checkout, a short or non-hex pin, or another file; other jobs are not held to it", () => {
  const land = (script) => () => launchdPlist({ job: "land", label: "l", nodePath: "n", script, args: ["--config", "/c"], logPath: "/l" });
  const refused = /runs only from a pinned install/;
  assert.throws(land("/h/.flight-board/current/scripts/board-land.mjs"), refused, "the linked copy");
  assert.throws(land("/h/Code/flight-board/scripts/board-land.mjs"), refused, "a checkout");
  assert.throws(land(`/h/.flight-board/install/${"c".repeat(39)}/scripts/board-land.mjs`), refused, "a short pin");
  assert.throws(land(`/h/.flight-board/install/${"g".repeat(40)}/scripts/board-land.mjs`), refused, "a pin that is not hex");
  assert.throws(land(`/h/.flight-board/install/${"c".repeat(40)}/scripts/board-release.mjs`), refused, "another file of the pin");
  assert.throws(land(undefined), refused, "no script");
  // Checker 2's nit: the pattern is anchored at its END, so a path that only STARTS right does not pass
  assert.throws(land(`/h/.flight-board/install/${"c".repeat(40)}/scripts/board-land.mjs.old`), refused, "a suffix after board-land.mjs");
  assert.throws(land(`/h/.flight-board/install/${"c".repeat(40)}/scripts/board-land.mjs/x`), refused, "a folder below it");
  assert.throws(land(`/h/.flight-board/install/${"c".repeat(40)}/scripts/board-land.mjs\n/x`), refused, "a newline then more");
  assert.doesNotThrow(land(`/h/.flight-board/install/${"c".repeat(40)}/scripts/board-land.mjs`));
  assert.doesNotThrow(() => launchdPlist({ job: "dispatch", label: "x", nodePath: "n", script: "/x/probe.mjs", logPath: "l" }), "the probe's jobs are not held to the land rule");
});

// Checker 2's F1 on e03bb4be: the alarm ends node, not the release tool it spawned, so a landing cut by the alarm pushes on as an orphan while the
// next run starts. A scheduled run starts a tip only while a whole landing fits, and the numbers leave room for one.
test("F1: the land cadence fits a whole carried landing (the suite twice) before its alarm, and the report outlives a slow run", () => {
  assert.ok(LAND_TIP_SEC >= 2 * 150 + 30, "one tip: the suite in the dry run and the real run, about 125 s each on 11-12, plus fetches and page builds");
  assert.ok(JOBS.land.limitSec - LAND_MARGIN_SEC >= LAND_TIP_SEC, "a run can always take one whole tip");
  assert.ok(JOBS.land.intervalSec >= JOBS.land.limitSec, "launchd starts no run before the last one's limit");
  assert.ok(LAND_REPORT_FRESH_MS > (JOBS.land.intervalSec + JOBS.land.limitSec + OUTER_EXTRA_SEC) * 1000, "the report is still fresh when the next one is written");
});

test("F1: landRun starts a tip only while a whole landing fits; the rest wait for the next run, named in waiting", () => {
  const head = (n) => ({ branch: `build/t${n}`, sha: String(n).repeat(40), notes: { checker: "PASS", security: "SECURE" }, cards: [`c${n}`], onMain: false, forward: true, ahead: 5 - n });
  const holds = { at: NOW, cards: { c1: "", c2: "", c3: "" } };
  let t = 0;
  const calls = [];
  const release = (sha, dry) => { calls.push([sha.slice(0, 1), dry]); t += 200e3; return { code: dry ? 0 : 1, text: "Not released\n- refused" }; };
  const r = landRun({ readFacts: () => ({ heads: [head(1), head(2), head(3)] }), readHolds: () => holds, release, now: NOW, clock: () => t, budgetMs: (JOBS.land.limitSec - LAND_MARGIN_SEC) * 1000, tipMs: LAND_TIP_SEC * 1000 });
  assert.deepEqual(calls, [["1", true], ["1", false]], "after one tip (400 s) a second would not fit in 570 s");
  assert.deepEqual(r.waiting.map((w) => w.branch), ["build/t2", "build/t3"]);
  assert.match(r.waiting[0].why, /next run/);
  t = 0; calls.length = 0;
  landRun({ readFacts: () => ({ heads: [head(1), head(2)] }), readHolds: () => holds, release, now: NOW, clock: () => t });
  assert.equal(calls.length, 4, "a hand run (no budget) tries every tip, as before");
});
