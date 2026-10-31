// A tip that moved on after its card shipped reads as the shipped commit, "extra commits after ship", never a review
// reopened (#C527: #C521's card stayed open: its branch got a dev merge and a blank line after the signed commit shipped,
// and ship cleanup deletes only a branch whose tip is the shipped commit). Fixtures shaped like that branch: no Board-Id
// trailer, main's line names "<branch>@<sha>". Fictional repository and names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { collect, inRepo } from "../collector/collect.mjs";
import { remoteHeads } from "../collector/facts.mjs";
import { cardState } from "../collector/state.mjs";
import { shippedBase, isShipOf, AFTER_SHIP_MAX, fetchBranches } from "../collector/after-ship.mjs";

const T0 = 1_790_000_000, PATTERN = "([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})", NOTES = "refs/notes/flight-board/checker";
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "fb-after-ship-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  const commit = (t, file, line, msg) => { at = T0 + t; appendFileSync(join(work, file), line + "\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  const merge = (t, what, msg) => { at = T0 + t; g(["merge", "-q", "--no-ff", "-m", msg, what]); return g(["rev-parse", "HEAD"]).trim(); };
  const sign = (sha) => g(["notes", `--ref=${NOTES}`, "add", "-m", "PASS", sha]);
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  return { dir, g, commit, merge, sign, sync, git: (args) => g(args), main: () => g(["rev-parse", "main"]).trim() };
}

// #C521's shape: dev moves on; admin/stale-fix is signed at `shipped` and goes out as "v1.2.1: admin/stale-fix@<sha>";
// then the branch merges dev and adds a blank line (2 first-parent commits after ship).
function c521({ trailer = false } = {}) {
  const r = repo();
  r.g(["checkout", "-qb", "dev"]); r.commit(5, "dev.md", "dev work", "dev work");
  r.g(["checkout", "-q", "main"]); r.g(["checkout", "-qb", "admin/stale-fix"]);
  r.commit(10, "fix.md", "the fix", "A failed publish says when" + (trailer ? "\n\nBoard-Id: stale-fix" : ""));
  const shipped = r.commit(20, "fix.md", "the findings fix", "Findings: the article" + (trailer ? "\n\nBoard-Id: stale-fix" : ""));
  r.sign(shipped);
  r.g(["checkout", "-q", "main"]); r.merge(30, shipped, `v1.2.1: admin/stale-fix@${shipped.slice(0, 8)}`);
  r.g(["checkout", "-q", "admin/stale-fix"]); r.merge(40, "dev", "Merge dev into admin/stale-fix");
  const tip = r.commit(50, "CHANGELOG.md", "", "blank line before 1.2.1 after merging dev");
  r.g(["checkout", "-q", "main"]);
  r.sync();
  return { r, shipped, tip };
}
const card = (id) => ({ id, status: "active", level: "Quick", size: "S", phase: "checker" });
const team = (r) => fullConfig({ owner: "Sam", collector: { repoPath: r.dir, notes: { checker: "refs/notes/checker" }, deployWorkflow: "CI", shippedPattern: PATTERN } });
const AFTER = /admin\/stale-fix has 2 extra commits after ship \(tip [0-9a-f]{8}\): not a new review/;

test("shippedBase: the tip's newest commit on main, when main names this branch at it; 2 commits after", () => {
  const { r, shipped, tip } = c521();
  try {
    assert.deepEqual(shippedBase(r.git, "origin/main", tip, { id: "stale-fix", branch: "admin/stale-fix", pattern: PATTERN }), { sha: shipped, extra: 2 });
    assert.equal(shippedBase(r.git, "origin/main", tip, { id: "stale-fix", branch: "admin/other", pattern: PATTERN }), null, "main names another branch at it");
    assert.equal(shippedBase(r.git, "origin/main", tip, { id: "stale-fix", branch: "admin/stale-fix", pattern: "" }), null, "no pattern and no trailer: nothing says it's the card's");
    assert.equal(shippedBase(r.git, "origin/main", shipped, { id: "stale-fix", branch: "admin/stale-fix", pattern: PATTERN }), null, "a tip on main stays as it is");
    assert.equal(shippedBase(r.git, "origin/main", "--all", { id: "stale-fix", branch: "admin/stale-fix", pattern: PATTERN }), null, "never an option");
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("the team's repository (collect): the card reads live by its shipped commit, and the evidence names the extra commits", () => {
  const { r, shipped } = c521();
  try {
    const { doc, conflicts } = collect({ config: team(r), cards: [card("stale-fix")], git: r.git, gh: () => JSON.stringify([{ headSha: r.main() }]), now: 1 });
    const d = doc.cards["stale-fix"];
    assert.equal(d.phase, "live", d.evidence);
    assert.equal(d.head, shipped);
    assert.match(d.evidence, AFTER);
    assert.ok(!conflicts.some((l) => /stale-fix/.test(l) && /checker|build/.test(l.split("repository says")[1] ?? "")), conflicts.join("\n"));
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("another repository (inRepo): with a Board-Id trailer and no pattern, the same", () => {
  const { r, shipped } = c521({ trailer: true });
  try {
    const config = fullConfig({ owner: "Sam", collector: { repos: [{ name: "board", path: r.dir, notes: { checker: "refs/notes/checker" }, idPrefixes: ["stale-"] }] } });
    const d = inRepo(card("stale-fix"), config.collector.repos[0], { git: r.git, installed: r.main() }, config, 1, new Set(["stale-fix"]));
    assert.equal(d.phase, "live", d.evidence);
    assert.equal(d.head, shipped);
    assert.match(d.evidence, AFTER);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("the minute probe (cardState) reads the shipped commit too, with its sign-off", () => {
  const { r, shipped } = c521();
  try {
    const config = team(r);
    const repoObj = { git: r.git, gh: null, remote: "origin", main: "main", notes: { checker: NOTES }, tips: remoteHeads(r.git, "origin"), live: r.main(), versionPattern: null, shippedPattern: PATTERN };
    const s = cardState({ ...card("stale-fix"), num: 521 }, repoObj, config, 1);
    assert.deepEqual([s.phase, s.headSha12, s.signed, s.onMain], ["live", shipped.slice(0, 12), ["checker"], true]);
    const before = cardState({ ...card("stale-fix"), num: 521 }, { ...repoObj, shippedPattern: "" }, config, 1);
    assert.equal(before.phase, "build", "without the rule, the later tip reads unreviewed: the bug");
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a new card cut from another card's signed, shipped commit stays in build (a sign-off alone is not the card's)", () => {
  const { r, shipped } = c521();
  try {
    r.g(["checkout", "-q", "main"]); r.g(["checkout", "-qb", "admin/next-card"]);
    r.commit(60, "next.md", "new work", "new work");
    r.g(["checkout", "-q", "main"]); r.sync();
    const config = team(r);
    assert.ok(r.g(["merge-base", "--is-ancestor", shipped, "origin/main"]) === "", "the fork point's line carries the signed commit");
    assert.equal(isShipOf(r.git, "origin/main", r.main(), { id: "next-card", branch: "admin/next-card", pattern: PATTERN }), false);
    const { doc } = collect({ config, cards: [card("next-card")], git: r.git, gh: () => JSON.stringify([{ headSha: r.main() }]), now: 1 });
    assert.equal(doc.cards["next-card"].phase, "build", doc.cards["next-card"].evidence);
    assert.doesNotMatch(doc.cards["next-card"].evidence, /after ship/);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a rework after the ship (#C224) is new work: a commit after it with the card's Board-Id keeps the tip's phase", () => {
  const { r } = c521();
  try {
    r.g(["checkout", "-q", "admin/stale-fix"]);
    r.commit(60, "fix.md", "the rework", "The rework\n\nBoard-Id: stale-fix");
    const blank = r.commit(70, "CHANGELOG.md", "", "a blank line");
    r.g(["checkout", "-q", "main"]); r.sync();
    assert.equal(shippedBase(r.git, "origin/main", blank, { id: "stale-fix", branch: "admin/stale-fix", pattern: PATTERN }), null, "a READY rework under the tip: not after-ship");
    const { doc } = collect({ config: team(r), cards: [card("stale-fix")], git: r.git, gh: () => JSON.stringify([{ headSha: r.main() }]), now: 1 });
    assert.equal(doc.cards["stale-fix"].head, blank);
    assert.doesNotMatch(doc.cards["stale-fix"].evidence, /after ship/);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a sign-off on the later tip is no new work: #C521's tip was re-signed by two reviews the bug asked", () => {
  const { r, shipped, tip } = c521();
  try {
    r.sign(tip);
    r.sync();
    assert.deepEqual(shippedBase(r.git, "origin/main", tip, { id: "stale-fix", branch: "admin/stale-fix", pattern: PATTERN }), { sha: shipped, extra: 2 });
    const { doc } = collect({ config: team(r), cards: [card("stale-fix")], git: r.git, gh: () => JSON.stringify([{ headSha: r.main() }]), now: 1 });
    assert.equal(doc.cards["stale-fix"].phase, "live", doc.cards["stale-fix"].evidence);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a shipped commit more than AFTER_SHIP_MAX first-parent commits back is not looked for", () => {
  const { r, shipped } = c521();
  try {
    r.g(["checkout", "-q", "admin/stale-fix"]);
    // 2 after ship already (the merge and the blank line): AFTER_SHIP_MAX - 1 more is one past the limit.
    for (let k = 0; k < AFTER_SHIP_MAX - 1; k++) r.commit(100 + k, "CHANGELOG.md", `line ${k}`, `more ${k}`);
    const far = r.g(["rev-parse", "HEAD"]).trim();
    assert.equal(shippedBase(r.git, "origin/main", far, { id: "stale-fix", branch: "admin/stale-fix", pattern: PATTERN }), null);
    r.g(["reset", "-q", "--hard", "HEAD~1"]);
    assert.equal(shippedBase(r.git, "origin/main", r.g(["rev-parse", "HEAD"]).trim(), { id: "stale-fix", branch: "admin/stale-fix", pattern: PATTERN })?.sha, shipped);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("isShipOf: main must name this exact branch at this commit; a branch that ends the same, or another commit, isn't it", () => {
  const { r, shipped } = c521();
  try {
    const one = { id: "stale-fix", branch: "admin/stale-fix", pattern: PATTERN };
    assert.equal(isShipOf(r.git, "origin/main", shipped, one), true);
    assert.equal(isShipOf(r.git, "origin/main", shipped, { ...one, branch: "stale-fix" }), false, "'stale-fix@' is in 'admin/stale-fix@': the group must be the whole name");
    assert.equal(isShipOf(r.git, "origin/main", r.g(["rev-parse", "origin/main^2~1"]).trim(), one), false, "a commit main never named for the branch");
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a tip already on main is left as it is, even right after a named ship", () => {
  const { r, shipped } = c521();
  try {
    r.g(["checkout", "-q", "-b", "admin/on-main", shipped]);
    const next = r.commit(60, "fix.md", "on main too", "a commit main takes");
    r.g(["checkout", "-q", "main"]); r.merge(70, next, "take it");
    r.sync();
    assert.equal(shippedBase(r.git, "origin/main", next, { id: "stale-fix", branch: "admin/stale-fix", pattern: PATTERN }), null);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("the clones' branch fetch prunes: a branch deleted on the remote is gone after the next fetch (Manager on #C521)", () => {
  const { r, tip } = c521();
  try {
    assert.deepEqual(fetchBranches("origin"), ["fetch", "-q", "--prune", "origin"]);
    r.g(["push", "-q", "origin", "--delete", "admin/stale-fix"]);
    r.g(["update-ref", "refs/remotes/origin/admin/stale-fix", tip]);
    r.g(["fetch", "-q", "origin"]);
    assert.ok(remoteHeads(r.git, "origin").some((h) => h.branch === "admin/stale-fix"), "a plain fetch keeps it: the bug");
    r.g(fetchBranches("origin"));
    assert.ok(!remoteHeads(r.git, "origin").some((h) => h.branch === "admin/stale-fix"));
    for (const f of ["collector/collect.mjs", "collector/state.mjs"]) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      assert.doesNotMatch(src, /\["fetch", "-q", (?:config\.collector\.remote|r\.remote \?\? "origin"|remote)\]/, `${f}: every branch fetch goes through fetchBranches`);
    }
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});
