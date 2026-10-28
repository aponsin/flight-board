// Ship times can't go missing (#C397, the owner in #T1035): a card went live with no tests/deploy minutes when Release
// skipped copying them onto its live step. (1) The collector reads the team repository's release log (RELEASE-TIMES.md on
// main, collector.releaseTimes) and puts each version's two CI times in derived/all; the page shows them for a card
// whose live step has none. (2) A card live 15+ minutes (nudges.shipTimesMin) with neither raises a NUDGE for the lead to
// forward to whoever shipped it.
import test from "node:test";
import assert from "node:assert/strict";
import { releaseTimes } from "../collector/facts.mjs";
import { nudges } from "../collector/nudges.mjs";
import { fullConfig, checkConfig } from "../scripts/config.mjs";
import { loadBoard, step } from "./harness.mjs";

const T = 1_800_000_000_000, MIN = 60e3, HOUR = 36e5;
const LOG = [
  "# Release times",
  "",
  "| Date | Version | Go-ahead | Live | Minutes | Notes |",
  "|---|---|---|---|---|---|",
  "| 2026-10-13 | v0.16.3 | 09:07 | 09:20 | 13 | npm run ship: dev run 9.8 min, main run 2.8 min; main was d0925ff; demos/pro@3a14d0a; live |",
  "| 2026-10-10 | v0.12.4–v0.12.6 | 09:40–10:00 | 09:48 | ~10 each | claims fix; main about 2.2 min each |",
  "| 2026-10-28 | v1.158.13 | 00:27 | 00:35 | 8 | npm run ship: candidate run 4.2 min, main run 2.8 min; main was ca6883a; demos/cwm-owner-text@337e308; live |",
  "| 2026-10-28 | v1.158.14 | 00:40 | 00:47 | 7 | npm run ship: candidate run 3.8 min, main run 1.8 min; main was 1a2b3c4; build/photos-lightbox@d2c6280; live |",
].join("\n");

test("the release log: each version's candidate (or dev) run is testsMin, its main run deployMin; other rows are skipped", () => {
  const asked = [];
  const git = (args) => { asked.push(args); return LOG; };
  assert.deepEqual(releaseTimes(git, "origin/main", "docs/RELEASE-TIMES.md"), {
    "0.16.3": { testsMin: 9.8, deployMin: 2.8 },
    "1.158.13": { testsMin: 4.2, deployMin: 2.8 },
    "1.158.14": { testsMin: 3.8, deployMin: 1.8 },
  });
  assert.deepEqual(asked, [["show", "origin/main:docs/RELEASE-TIMES.md"]], "one read, of main's copy");
  assert.deepEqual(releaseTimes(() => { throw new Error("no such path"); }, "origin/main", "docs/RELEASE-TIMES.md"), {}, "no log: none");
  assert.deepEqual(releaseTimes(() => LOG, "origin/main", ""), {}, "no path configured: none, and nothing read");
  const many = ["| a | b |", ...Array.from({ length: 300 }, (_, k) => `| d | v1.0.${k} | x | y | 7 | candidate run 4 min, main run 2 min |`)].join("\n");
  const kept = releaseTimes(() => many, "origin/main", "x.md");
  assert.equal(Object.keys(kept).length, 100, "the newest 100 versions only");
  assert.ok(kept["1.0.299"] && !kept["1.0.199"]);
});

test("its config: a relative path in the repository (docs/RELEASE-TIMES.md by default), and 15 minutes before the nudge", () => {
  assert.equal(fullConfig({}).collector.releaseTimes, "docs/RELEASE-TIMES.md");
  assert.equal(fullConfig({}).nudges.shipTimesMin, 15);
  assert.deepEqual(checkConfig({ collector: { releaseTimes: "RELEASE-TIMES.md" }, nudges: { shipTimesMin: 20 } }), []);
  assert.deepEqual(checkConfig({ collector: { releaseTimes: "" } }), [], "empty: off");
  for (const bad of ["/etc/passwd", "../x.md", "docs/../../x", "-p", "a\nb", "x:y"]) assert.deepEqual(checkConfig({ collector: { releaseTimes: bad } }), ["collector.releaseTimes: a path inside the repository, or empty"], bad);
  assert.deepEqual(checkConfig({ nudges: { shipTimesMin: 0 } }), ["nudges.shipTimesMin: a positive number"]);
});

const config = fullConfig({ owner: "Sam" });
const card = (id, extra = {}) => ({ id, num: 397, size: "S", status: "done", ...extra });
const live = (init, at, extra = {}) => ({ id: `${init}-live-${at}`, init, phase: "live", kind: "end", who: "Release", version: "v1.158.15", at, ...extra });
const run = (docs, { now = T, times = {}, state = {} } = {}) => nudges({ config, docs: { initiatives: [], waiting: [], messages: [], steps: [], ctx: [], ...docs }, now, state, releaseTimes: times });

test("a card live 15+ minutes with no ship times, on its live step or in the log, nudges the lead to forward to its shipper", () => {
  const c = card("ship-times-guard");
  assert.deepEqual(run({ initiatives: [c], steps: [live(c.id, T - 14 * MIN)] }).lines, [], "14 minutes: not yet");
  assert.deepEqual(run({ initiatives: [c], steps: [live(c.id, T - 16 * MIN)] }).lines, [
    "NUDGE ship-times-guard (#C397): live in v1.158.15 for 16 min with no ship times; forward:",
    "NUDGE forward to Release: ship times for v1.158.15 (#C397): add testsMin and deployMin to its live step, or its row to the release log",
  ]);
  assert.deepEqual(run({ initiatives: [c], steps: [live(c.id, T - 16 * MIN, { testsMin: 4.2, deployMin: 1.8 })] }).lines, [], "on its live step");
  assert.deepEqual(run({ initiatives: [c], steps: [live(c.id, T - 16 * MIN)] }, { times: { "1.158.15": { testsMin: 4, deployMin: 2 } } }).lines, [], "in the log");
  assert.deepEqual(run({ initiatives: [c], steps: [live(c.id, T - 30 * HOUR)] }).lines, [], "live over a day ago: history, not a nudge");
  assert.deepEqual(run({ initiatives: [c], steps: [live(c.id, T - 16 * MIN, { who: "Owner" })] }).lines.slice(1), ["NUDGE forward to Owner: ship times for v1.158.15 (#C397): add testsMin and deployMin to its live step, or its row to the release log"], "whoever shipped it");
  const once = run({ initiatives: [c], steps: [live(c.id, T - 16 * MIN)] });
  assert.deepEqual(run({ initiatives: [c], steps: [live(c.id, T - 16 * MIN)] }, { now: T + 10 * MIN, state: once.state }).lines, [], "once, then the quiet period");
});

// Checker's FINDINGS on aaa3add: live steps that can't carry CI times nudged too.
const late = T - 16 * MIN;
test("a live start step is no ship: no nudge, even with its end step missing", () => {
  const c = card("ship-times-guard");
  assert.deepEqual(run({ initiatives: [c], steps: [live(c.id, late, { kind: "start" })] }).lines, []);
  assert.deepEqual(run({ initiatives: [c], steps: [live(c.id, late - MIN), live(c.id, late, { kind: "start", who: "Ops" })] }).lines.slice(1), ["NUDGE forward to Release: ship times for v1.158.15 (#C397): add testsMin and deployMin to its live step, or its row to the release log"], "a later start step doesn't hide the end step's ship");
});

test("a live step with no version, or one versionPattern doesn't take, is no ship (an install, a review): no nudge", () => {
  const c = card("ship-times-guard");
  for (const version of [undefined, "", "v3.20", "1.158.15", "installed"]) assert.deepEqual(run({ initiatives: [c], steps: [live(c.id, late, { version, who: "Security" })] }).lines, [], String(version));
});

test("a card in another repository has no release log: no nudge", () => {
  const repos = [{ name: "board", idPrefixes: ["board-"] }];
  const other = fullConfig({ owner: "Sam", collector: { repos } });
  const go = (k) => nudges({ config: other, docs: { initiatives: [k], waiting: [], messages: [], steps: [live(k.id, late)], ctx: [] }, now: T, state: {} }).lines;
  assert.deepEqual(go(card("board-keeper")), [], "by id prefix");
  assert.deepEqual(go(card("keeper-fix", { repo: "board" })), [], "by its repo field");
  assert.equal(go(card("photos-lightbox")).length, 2, "the team's own repository still nudges");
});

test("the page shows the log's times for a card whose live step has none, and no 'no ship times' then", () => {
  const b = loadBoard();
  b.state.steps = [step("x", "ship", "Release", "start", T), step("x", "live", "Release", "end", T + 1, { version: "v1.158.13" })];
  b.state.waiting = [];
  b.state.derived = [{ id: "all", cards: {}, releaseTimes: { "1.158.13": { testsMin: 4.2, deployMin: 2.8 } } }];
  const i = b.gates(b.enrich({ id: "x", level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X" }));
  assert.equal(i.shipDetail, "tests 4 min · deploy 3 min");
  assert.ok(![...b.gaps(i, { done: true })].includes("no ship times"));
  b.state.derived = [{ id: "all", cards: {}, releaseTimes: { "1.158.12": { testsMin: 4.5, deployMin: 1.8 } } }];
  const j = b.gates(b.enrich({ id: "x", level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X" }));
  assert.ok([...b.gaps(j, { done: true })].includes("no ship times"), "another version's row is not its times");
});
