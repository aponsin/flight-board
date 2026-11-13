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
import { launchdPlist, JOBS } from "../collector/probe-run.mjs";

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
  assert.equal(landingFrom({ at: NOW - LAND_REPORT_FRESH_MS }, NOW).fresh, true, "exactly 10 minutes is still fresh");
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
  const p = launchdPlist({ job: "land", label: "com.flight-board.store.land", nodePath: "/usr/bin/node", script: "/h/.flight-board/current/scripts/board-land.mjs", args: ["--config", "/h/board.config.json"], logPath: "/h/land.log" });
  assert.doesNotMatch(p, /--job/);
  assert.match(p, /<string>\/h\/\.flight-board\/current\/scripts\/board-land\.mjs<\/string><string>--config<\/string><string>\/h\/board\.config\.json<\/string><\/array>/);
  assert.match(p, new RegExp(`<key>StartInterval</key><integer>${JOBS.land.intervalSec}</integer>`));
  assert.match(launchdPlist({ job: "dispatch", label: "x", nodePath: "n", script: "s", logPath: "l" }), /<string>--job<\/string><string>dispatch<\/string>/, "the probe's jobs keep --job");
});
