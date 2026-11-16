// #C1098 (11-16: the dispatch sent #C1091 v2 and #C1096 v2, flight-board code, to Checker, who woke for nothing and passed them on each time): the lane split gives the
// board's own code reviews to Checker 2 and the product's to Checker. The checker phase's reviewer is the role the config's collector.reviewers names for the card's
// repository ("flight-board" is the board's own: no repo word, or a BOARD_REPO_WORDS word); a repository with no entry keeps the phase's lane.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { dispatchJob } from "../collector/probe-board.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchInput, dispatchRun, reviewerFor } from "../collector/store-dispatch.mjs";
import { dispatchLine } from "../gate/reset.mjs";
import { checkConfig, fullConfig } from "../scripts/config.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Checker", "Checker 2", "Security", "Release"], LEAD = "Manager";
const REVIEWERS = { "flight-board": "Checker 2" };
const idle = () => ({ state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN });
const sha = (n) => String(n).padStart(12, "a").slice(0, 12);
// Cards pushed at the checker phase, each with its own commit: { number: repo word }.
const world = (cards, reviewClaims = []) => {
  const rows = [], evidence = { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle()])) } };
  for (const [n, repo] of Object.entries(cards)) {
    const id = `c${n}-thing`;
    rows.push({ id, num: Number(n), owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo, });
    evidence[`cards.${id}`] = { readAt: NOW - 5_000, value: { lit: ["checker"], phase: "checker", headSha12: sha(n), signed: [] } };
  }
  return { cards: rows, asks: [], evidence, reviewClaims };
};
const run = (v, reviewers, roster = ROSTER, log = () => {}) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "c1098-")), roster, lead: LEAD, now: NOW, reviewers, log }).items;
const who = (items) => Object.fromEntries(items.map((i) => [i.num, i.role]));

test("with no reviewers map every checker review is Checker's, as before", () => {
  const v = world({ 1: "", 2: "flight-board", 3: "product-app" });
  assert.deepEqual(who(run(v, null)), { 1: "Checker", 2: "Checker", 3: "Checker" });
  assert.deepEqual(who(run(v, {})), { 1: "Checker", 2: "Checker", 3: "Checker" });
});

test("a flight-board card at the checker phase wakes Checker 2, a product card wakes Checker; a card with no repo word and the board's other words are the board's", () => {
  const v = world({ 1: "", 2: "flight-board", 3: "board", 4: "product-app" });
  assert.deepEqual(who(run(v, REVIEWERS)), { 1: "Checker 2", 2: "Checker 2", 3: "Checker 2", 4: "Checker" });
  const line = dispatchLine(run(world({ 7: "flight-board" }), REVIEWERS)[0]);
  assert.match(line, /^DISPATCH #C7 at checker: [0-9a-f]{12}; it is pushed; review it .*\(Checker 2's turn;/);
});

test("a map for a product repository sends that repository's reviews to its role; a repository with no entry keeps Checker", () => {
  const v = world({ 1: "flight-board", 2: "product-app", 3: "other" });
  assert.deepEqual(who(run(v, { "flight-board": "Checker 2", "product-app": "Checker" })), { 1: "Checker 2", 2: "Checker", 3: "Checker" });
});

test("the review queue is the reviewer's own: Checker 2's line lists the board's cards, Checker's lists the product's", () => {
  const v = world({ 1: "flight-board", 2: "product-app", 3: "flight-board" });
  assert.deepEqual(dispatchInput(v, NOW, { lead: LEAD, reviewers: REVIEWERS, roster: ROSTER }).queues, { "Checker 2": [1, 3], Checker: [2] });
  const items = run(v, REVIEWERS);
  assert.deepEqual(items.find((i) => i.num === 1).queue, [1, 3]);
  assert.deepEqual(items.find((i) => i.num === 2).queue, [2]);
});

test("a role the roster does not hold is ignored, so a card is never left with a reviewer nobody wakes; the log says so", () => {
  const v = world({ 1: "flight-board" });
  const lines = [];
  assert.deepEqual(who(run(v, { "flight-board": "Checker 9" }, ROSTER, (l) => lines.push(l))), { 1: "Checker" });
  assert.ok(lines.some((l) => /collector\.reviewers names Checker 9 for flight-board, which is not on the roster/.test(l)), lines.join("\n"));
  assert.equal(reviewerFor({ repo: "" }, REVIEWERS, ROSTER), "Checker 2");
  assert.equal(reviewerFor({ repo: "" }, REVIEWERS, ["Checker"]), undefined);
  for (const bad of [null, [], "x", { "flight-board": 7 }]) assert.equal(reviewerFor({ repo: "" }, bad, ROSTER), undefined);
});

test("a tip a checker already holds a claim on wakes no second one, Checker 2 included", () => {
  const v = world({ 1: "flight-board" }, [{ sha: `${sha(1)}${"0".repeat(28)}`, card_id: "c1-thing", checker: "Checker 2", claimed_at: NOW - MIN }]);
  assert.deepEqual(run(v, REVIEWERS), []);
  assert.deepEqual(who(run(world({ 1: "flight-board" }), REVIEWERS)), { 1: "Checker 2" }, "with no claim it wakes");
});

test("collector.reviewers in the config: a map of repository words to role names, empty by default", () => {
  assert.deepEqual(fullConfig({}).collector.reviewers, {});
  const bad = (reviewers) => checkConfig({ collector: { reviewers } }).filter((e) => /reviewers/.test(e));
  assert.deepEqual(bad({ "flight-board": "Checker 2" }), []);
  assert.deepEqual(bad({}), []);
  for (const v of [["Checker 2"], "Checker 2", { "flight-board": 2 }, { "flight board": "Checker 2" }, { "flight-board": "x\ny" }]) assert.equal(bad(v).length, 1, JSON.stringify(v));
});

// Checker 2's F1 MEDIUM on e04e356f: dispatchJob (the CLI's path) must hand the config's reviewers to dispatchRun, or the map never reaches dispatch.json.
test("dispatchJob passes collector.reviewers through: the written dispatch.json has the review turn for Checker 2", async () => {
  const v = world({ 1: "flight-board", 2: "product-app" });
  const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => (String(url).endsWith("/api/view") ? v : {}) });
  const dir = mkdtempSync(join(tmpdir(), "c1098-job-"));
  const job = (reviewers) => dispatchJob({ base: "https://board.test", headers: {}, fetchImpl, dir, roster: ROSTER, lead: LEAD, reviewers, pairCovers: [], now: () => NOW });
  await job(REVIEWERS);
  const written = JSON.parse(readFileSync(join(dir, "dispatch.json"), "utf8")).items;
  assert.deepEqual(who(written), { 1: "Checker 2", 2: "Checker" });
  await job(null);
  assert.deepEqual(who(JSON.parse(readFileSync(join(dir, "dispatch.json"), "utf8")).items), { 1: "Checker", 2: "Checker" }, "with no map it is Checker's, as before");
});

// Checker 2's F3 LOW on e04e356f: the reviewer applies to the checker phase only, and a map that is an array is no map.
test("the reviewer is given to the checker phase only: a flight-board card at another phase keeps its own role", () => {
  const v = world({ 1: "flight-board" });
  v.evidence["cards.c1-thing"].value = { lit: ["checker", "security"], phase: "security", headSha12: sha(1), signed: ["checker"] };
  const without = who(run(v, null)), withMap = who(run(v, REVIEWERS));
  assert.deepEqual(withMap, without, "the map changes nothing outside the checker phase");
  assert.deepEqual(withMap, { 1: "Security" }, "the security review stays Security's, not the checker phase's reviewer");
});

test("an array for collector.reviewers is no map: every review stays Checker's and the run does not stop", () => {
  const v = world({ 1: "flight-board" });
  assert.deepEqual(who(run(v, ["Checker 2"])), { 1: "Checker" });
  assert.deepEqual(who(run(v, [{ "flight-board": "Checker 2" }])), { 1: "Checker" });
});
