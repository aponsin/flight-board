// #C897: which reviews a card needs comes from the files its branch touches, not from a level or skip typed at card time. A typed field can
// only raise a review. With no table or no diff, the typed rule decides as before. Real git; fictional repository, paths and names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig, checkConfig } from "../scripts/config.mjs";
import { cardState, branchPaths } from "../collector/state.mjs";
import { patternRe, pathPhases, reviewsFromPaths, reviewPathsErrors } from "../collector/review-paths.mjs";
import { reviewsFor, derivePhase } from "../collector/derive.mjs";
import { turnsOf } from "../collector/store-dispatch.mjs";

const T0 = 1_790_000_000;
const NOTES = { language: "refs/notes/linguist", design: "refs/notes/designer", checker: "refs/notes/checker", security: "refs/notes/security" };
const PHASES = [["plan", "Plan"], ["build", "Build"], ["test", "Test"], ["language", "Linguist"], ["design", "Design"], ["checker", "Checker"], ["security", "Security"], ["ship", "Ship"], ["live", "Live"]];
const SKIPS = [{ phase: "security", unlessLevel: "Full" }, { phase: "language", whenFalse: "customerText" }, { phase: "design", unlessTrue: "lookChange" }];
const TABLE = {
  language: ["lib/core/labels.js", "sites/**", "lib/render/**"],
  design: ["assets/css/**", "page/**"],
  security: ["worker/**", "hooks/**", ".claude/settings*.json"],
};
const cfg = fullConfig({ owner: "Sam", phases: PHASES, skips: SKIPS, collector: { repoPath: "/x", notes: NOTES, reviewPaths: TABLE } });

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-paths-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${T0} +0000`, GIT_AUTHOR_DATE: `${T0} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  // A branch for card `id` that changes `files`; main then moves on with a file of its own, which the branch's diff must not count.
  const branch = (id, files) => {
    g(["checkout", "-qb", id]);
    for (const f of files) { mkdirSync(dirname(join(work, f)), { recursive: true }); writeFileSync(join(work, f), `${id}\n`); }
    const msg = `Work\n\nBoard-Id: ${id}`;
    g(["add", "-A"]); g(["commit", "-qm", msg]);
    const sha = g(["rev-parse", "HEAD"]).trim();
    g(["checkout", "-q", "main"]);
    mkdirSync(join(work, "worker"), { recursive: true }); writeFileSync(join(work, "worker", `main-${id}.js`), "main\n"); g(["add", "-A"]); g(["commit", "-qm", `main moves (${id})`]);
    g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]);
    return { sha, msg };
  };
  const read = (card, files, extra = {}) => {
    const { sha, msg } = branch(card.id, files);
    const repo = { git: (args) => g(args), remote: "origin", main: "main", notes: NOTES, live: null, versionPattern: null, reviewPaths: TABLE, tips: [{ branch: "main", sha: "x", at: T0, message: "" }, { branch: `origin/${card.id}`, sha, at: (T0 + 10) * 1000, message: msg }], ...extra };
    return cardState({ phase: "plan", num: 897, ...card }, repo, cfg, T0 * 1000);
  };
  return { read };
}

test("a scripts-only diff gets neither Linguist nor Designer, even on a Full card with no skip (#C894)", () => {
  const st = scratch().read({ id: "only-scripts", level: "Full" }, ["scripts/lib/ship.mjs"]);
  assert.equal(st.phase, "checker");
  assert.deepEqual(st.waitingFor, ["checker", "security"], "Full still raises Security; no language or design");
});

test("a labels diff gets Linguist", () => {
  const st = scratch().read({ id: "labels", level: "Quick" }, ["lib/core/labels.js"]);
  assert.equal(st.phase, "language");
  assert.deepEqual(st.waitingFor, ["language", "checker"]);
});

test("a Worker-route diff gets Security even when the card says Quick (#C903), and the dispatch sends Security beside Checker", () => {
  const st = scratch().read({ id: "new-route", level: "Quick", customerText: false }, ["worker/routes/new.js"]);
  assert.deepEqual(st.waitingFor, ["checker", "security"]);
  const turns = turnsOf({ id: "new-route", owner_role: "Builder", review_level: "Quick" }, st);
  assert.deepEqual(turns.map((t) => t.role), ["Checker", "Security"]);
});

test("a page diff gets Designer; a look change typed on a scripts card raises it; a skip cannot lower a review the paths call for", () => {
  const s = scratch();
  assert.deepEqual(s.read({ id: "page-css", level: "Quick" }, ["page/board.template.html"]).waitingFor, ["design", "checker"]);
  assert.deepEqual(s.read({ id: "typed-look", level: "Quick", lookChange: true }, ["scripts/x.mjs"]).waitingFor, ["design", "checker"]);
  assert.deepEqual(s.read({ id: "typed-text", level: "Quick", customerText: true }, ["scripts/y.mjs"]).waitingFor, ["language", "checker"]);
  assert.deepEqual(s.read({ id: "skip-lower", level: "Quick", skip: ["security", "language"] }, ["worker/a.js", "sites/a/site.json"]).waitingFor, ["language", "checker", "security"]);
});

test("main's own commits after the branch left it do not count (main...tip)", () => {
  // every branch() call moves main with a worker/ file: a scripts branch must still not need Security
  const st = scratch().read({ id: "behind-main", level: "Quick" }, ["scripts/z.mjs"]);
  assert.deepEqual(st.waitingFor, ["checker"]);
});

test("no table, or a diff git cannot read: the typed rule decides as before", () => {
  const s = scratch();
  assert.deepEqual(s.read({ id: "no-table", level: "Full" }, ["scripts/a.mjs"], { reviewPaths: null }).waitingFor, ["language", "checker", "security"]);
  // a git that cannot diff gives no paths, and no paths is the typed rule
  const broken = { reviewPaths: TABLE, git: (args) => { if (args[0] === "diff") throw new Error("no"); return ""; } };
  assert.equal(branchPaths(broken, "origin/main", "a".repeat(40)), null);
  assert.equal(branchPaths({ ...broken, reviewPaths: null }, "origin/main", "a".repeat(40)), null, "no table: git is not asked");
  assert.equal(branchPaths(broken, "origin/main", "--output=x"), null, "only a full sha goes to git");
  const typed = reviewsFromPaths({ level: "Quick" }, cfg, reviewsFor({ level: "Quick" }, cfg), TABLE, null);
  assert.deepEqual(typed, ["language", "checker"]);
});

test("the pure rule: patterns, phases the table names and does not, raises only", () => {
  assert.ok(patternRe("worker/**").test("worker/a/b.js"));
  assert.ok(patternRe("lib/render/*.js").test("lib/render/a.js"));
  assert.ok(!patternRe("lib/render/*.js").test("lib/render/x/a.js"));
  assert.ok(!patternRe("a.js").test("aXjs"), "a dot is a dot");
  assert.ok(!patternRe("worker/**").test("not-worker/a.js"), "anchored");
  assert.deepEqual([...pathPhases(TABLE, ["sites/a/site.json", "worker/x.js"])].sort(), ["language", "security"]);
  // checker is not in the table: the typed rule keeps it, and a typed skip of it still counts
  assert.deepEqual(reviewsFromPaths({ level: "Quick" }, cfg, ["checker"], TABLE, ["docs/x.md"]), ["checker"]);
  assert.deepEqual(reviewsFromPaths({ level: "Quick", skip: ["checker"] }, cfg, [], TABLE, ["docs/x.md"]), []);
  // derive.mjs reads facts.needs the same way the probe does
  const d = derivePhase({ id: "d" }, { head: { branch: "b", sha: "a".repeat(40), message: "x\n\nBoard-Id: d" }, signed: new Set(["checker"]), onMain: false, needs: ["checker"] }, cfg);
  assert.equal(d.phase, "ship");
});

test("Security LOW on 532b9f8: Security and Checker are raise-only; only the flag-gated reviews (language, design) can be lowered by the paths", () => {
  const s = scratch();
  // a card with no level: the typed rule gives Security, and a docs-only diff does not take it away
  assert.deepEqual(s.read({ id: "no-level-docs" }, ["docs/notes.md"]).waitingFor, ["checker", "security"]);
  // a table that names checker can add nothing to it and never drops it
  const withChecker = { ...TABLE, checker: ["worker/**"] };
  assert.deepEqual(reviewsFromPaths({ level: "Quick" }, cfg, ["language", "checker"], withChecker, ["docs/x.md"]), ["checker"]);
  // the flag-gated reviews still go when the paths miss them (#C894)
  assert.deepEqual(reviewsFromPaths({ level: "Full" }, cfg, ["language", "checker", "security"], TABLE, ["scripts/a.mjs"]), ["checker", "security"]);
});

// Checker F1 on 532b9f8: the collector's own derive (collect.mjs inRepo and the team repository's read) must read the same reviews as the probe,
// or the page shows a card the probe holds at Security as "Queued for board release".
test("the collector's derive agrees with the probe: a Quick card changing a Worker route, Checker signed, waits at security, not 'release'", async () => {
  const { inRepo, withNeeds } = await import("../collector/collect.mjs");
  const dir = mkdtempSync(join(tmpdir(), "fb-paths-collect-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${T0} +0000`, GIT_AUTHOR_DATE: `${T0} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  g(["checkout", "-qb", "new-route"]);
  mkdirSync(join(work, "worker", "routes"), { recursive: true }); writeFileSync(join(work, "worker", "routes", "x.js"), "x\n");
  g(["add", "-A"]); g(["commit", "-qm", "A route\n\nBoard-Id: new-route"]);
  const sha = g(["rev-parse", "HEAD"]).trim();
  g(["push", "-q", "--all", "origin"]); g(["fetch", "-q", "origin"]);
  // the collector reads its notes under refs/notes/flight-board/ (localNotes): Checker signs there
  g(["notes", "--ref=refs/notes/flight-board/checker", "add", "-m", "PASS", sha]);
  const r = { name: "board", path: work, notes: NOTES, reviewPaths: TABLE };
  const card = { id: "new-route", num: 903, level: "Quick", customerText: false };
  const d = inRepo(card, r, { git: (a) => g(a), installed: null }, cfg, T0 * 1000);
  assert.equal(d.phase, "security", JSON.stringify(d));
  assert.equal(d.wait, undefined, "not queued for a release: Security has not signed");
  // without the table, the typed rule: Quick, Checker signed, so ship, queued for a release (as before)
  const typed = inRepo(card, { ...r, reviewPaths: undefined }, { git: (a) => g(a), installed: null }, cfg, T0 * 1000);
  assert.equal(typed.phase, "ship"); assert.equal(typed.wait, "release");
  // the probe reads the same card the same way
  const local = { language: "refs/notes/flight-board/linguist", design: "refs/notes/flight-board/designer", checker: "refs/notes/flight-board/checker", security: "refs/notes/flight-board/security" };
  const probe = cardState({ ...card, phase: "plan" }, { git: (a) => g(a), remote: "origin", main: "main", notes: local, live: null, versionPattern: null, reviewPaths: TABLE, tips: [{ branch: "main", sha: "x", at: T0, message: "" }, { branch: "origin/new-route", sha, at: (T0 + 10) * 1000, message: "A route\n\nBoard-Id: new-route" }] }, cfg, T0 * 1000);
  assert.equal(probe.phase, d.phase, "probe and collector agree");
  // the team's own repository (collect()'s phaseOf), the second path: the same card, the same answer
  const { collect } = await import("../collector/collect.mjs");
  const teamCfg = fullConfig({ owner: "Sam", phases: PHASES, skips: SKIPS, collector: { repoPath: work, notes: NOTES, reviewPaths: TABLE } });
  const team = collect({ config: teamCfg, cards: [{ ...card, status: "active", phase: "build" }], git: (a) => g(a), gh: () => "[]", now: 5 }).doc.cards["new-route"];
  assert.equal(team.phase, "security", JSON.stringify(team));
  assert.equal(team.wait, undefined);
  const teamTyped = collect({ config: fullConfig({ owner: "Sam", phases: PHASES, skips: SKIPS, collector: { repoPath: work, notes: NOTES } }), cards: [{ ...card, status: "active", phase: "build" }], git: (a) => g(a), gh: () => "[]", now: 5 }).doc.cards["new-route"];
  assert.equal(teamTyped.phase, "ship", "no table: the typed rule, as before");
  // withNeeds leaves a head on main, no table, or no head alone
  const f = { head: { sha }, onMain: false, signed: new Set() };
  assert.equal(withNeeds(card, cfg, { ...f, onMain: true }, (a) => g(a), "origin/main", TABLE).needs, undefined);
  assert.equal(withNeeds(card, cfg, f, (a) => g(a), "origin/main", null).needs, undefined);
  assert.deepEqual(withNeeds(card, cfg, f, (a) => g(a), "origin/main", TABLE).needs, ["checker", "security"]);
});

test("the config check: reviewPaths names review phases with path patterns, for the team's repository and another", () => {
  const base = { owner: "Sam", phases: PHASES, collector: { repoPath: "/x", notes: NOTES } };
  assert.deepEqual(checkConfig({ ...base, collector: { ...base.collector, reviewPaths: TABLE } }), []);
  assert.ok(checkConfig({ ...base, collector: { ...base.collector, reviewPaths: { live: ["x"] } } }).some((e) => /reviewPaths\.live/.test(e)));
  assert.ok(checkConfig({ ...base, collector: { ...base.collector, reviewPaths: { security: ["../x"] } } }).length);
  assert.ok(checkConfig({ ...base, collector: { ...base.collector, reviewPaths: { security: "worker/**" } } }).length);
  assert.ok(checkConfig({ ...base, collector: { ...base.collector, reviewPaths: ["worker/**"] } }).length);
  const other = { name: "board", path: "/y", notes: { checker: "refs/notes/checker", security: "refs/notes/security" } };
  assert.deepEqual(checkConfig({ ...base, collector: { ...base.collector, repos: [{ ...other, reviewPaths: { security: ["worker/**"] } }] } }), []);
  assert.ok(checkConfig({ ...base, collector: { ...base.collector, repos: [{ ...other, reviewPaths: { language: ["x"] } }] } }).some((e) => /repos\[0\]\.reviewPaths\.language/.test(e)), "a phase that repository has no notes for");
  assert.deepEqual(reviewPathsErrors(undefined, ["checker"]), []);
  for (const bad of ["-x", "a b", "a;b", "a\nb", ""]) assert.ok(reviewPathsErrors({ checker: [bad] }, ["checker"]).length, JSON.stringify(bad));
});
