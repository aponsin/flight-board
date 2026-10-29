// A branch left behind by a rebase or a cherry-pick never holds a card open (#C412, Manager: six live cards read open;
// the gate refused #C395, "3 branches, done-list-search-v319 is behind", and #C401, "keeper-pickup-once is behind").
// When every commit a branch has beyond main is already on main as the same patch, the card's change is the one on main.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { collect, inRepo, settledTips } from "../collector/collect.mjs";
import { remoteHeads } from "../collector/facts.mjs";
import { headsFor } from "../collector/derive.mjs";

const T0 = 1_790_000_000;
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "fb-settled-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  const commit = (t, file, line, msg) => { at = T0 + t; appendFileSync(join(work, file), line + "\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  const pick = (t, sha) => { at = T0 + t; g(["cherry-pick", "-x", sha]); return g(["rev-parse", "HEAD"]).trim(); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  return { dir, g, commit, pick, sync, git: (args) => g(args), main: () => g(["rev-parse", "main"]).trim() };
}
const card = (id) => ({ id, status: "active", level: "Quick", size: "S" });
const board = (r) => fullConfig({ owner: "Sam", collector: { repos: [{ name: "board", path: r.dir, notes: { checker: "refs/notes/checker" }, idPrefixes: ["done-", "keeper-"] }] } });

// #C395: done-list-search (0cc1959, on the old base), done-list-search-v319 (7f8ec6d, rebased on v3.19), and
// done-list-search-v320 (5c782c5, rebased on v3.20), which went to main; the first two are left behind.
function c395() {
  const r = repo();
  r.g(["checkout", "-qb", "done-list-search"]);
  const old = r.commit(10, "done.js", "the Done search", "A search box on the Done list\n\nBoard-Id: done-list-search");
  r.g(["checkout", "-q", "main"]); r.commit(20, "base.md", "v3.19", "v3.19");
  r.g(["checkout", "-qb", "done-list-search-v319"]); r.pick(30, old);
  r.g(["checkout", "-q", "main"]); r.commit(40, "base.md", "v3.20", "v3.20");
  r.g(["checkout", "-qb", "done-list-search-v320"]); const shipped = r.pick(50, old);
  r.g(["checkout", "-q", "main"]); r.g(["merge", "-q", "--ff-only", "done-list-search-v320"]);
  r.sync();
  return { r, shipped };
}
// #C401: keeper-pickup-once (35982b6-like and c70dfb1-like, then de67dea, on the old base) and v320/keeper-pickup-once
// (the same two cherry-picked onto the v3.20 stack), which went to main.
function c401() {
  const r = repo();
  r.g(["checkout", "-qb", "keeper-pickup-once"]);
  const a = r.commit(10, "keeper.md", "pick up once", "The keeper picks up once\n\nBoard-Id: keeper-pickup-once");
  const b = r.commit(20, "keeper.md", "self-resets too", "A self-reset is picked up too\n\nBoard-Id: keeper-pickup-once");
  r.g(["checkout", "-q", "main"]); r.commit(30, "base.md", "ship times guard", "ship times guard");
  r.g(["checkout", "-qb", "v320/keeper-pickup-once"]); r.pick(40, a); const shipped = r.pick(50, b);
  r.g(["checkout", "-q", "main"]); r.g(["merge", "-q", "--ff-only", "v320/keeper-pickup-once"]);
  r.sync();
  return { r, shipped };
}

for (const [name, make, id, branches] of [["#C395", c395, "done-list-search", 3], ["#C401", c401, "keeper-pickup-once", 2]]) {
  test(`${name}: its old branches read as the commit on main; one tip, installed reads live, no 'is behind'`, () => {
    const { r, shipped } = make();
    try {
      const tips = headsFor(id, remoteHeads(r.git, "origin").filter((h) => h.branch !== "main"));
      assert.equal(tips.length, branches, "the branches are all there, as on the real repository");
      const settled = settledTips(r.git, "origin", "main", tips);
      assert.deepEqual(settled.map((h) => h.sha), [shipped], "every one is the shipped commit, counted once");
      const config = board(r);
      const d = inRepo(card(id), config.collector.repos[0], { git: r.git, installed: r.main() }, config, 1, new Set([id]));
      assert.equal(d.phase, "live", d.evidence);
      assert.doesNotMatch(d.evidence, /is behind/);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
}

test("the team's repository too (collect): #C401's state, deployed, reads live with no 'split' line", () => {
  const { r } = c401();
  try {
    const config = fullConfig({ owner: "Sam", collector: { repoPath: r.dir, notes: { checker: "refs/notes/checker" }, deployWorkflow: "CI" } });
    const { doc, conflicts } = collect({ config, cards: [card("keeper-pickup-once")], git: r.git, gh: () => JSON.stringify([{ headSha: r.main() }]), now: 1 });
    assert.equal(doc.cards["keeper-pickup-once"].phase, "live", doc.cards["keeper-pickup-once"].evidence);
    assert.ok(!conflicts.some((l) => /2 branches/.test(l)), conflicts.join("\n"));
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a branch with a commit of its own (a '+') still holds the card back, as before", () => {
  const { r } = c401();
  try {
    r.g(["checkout", "-q", "keeper-pickup-once"]);
    r.commit(60, "keeper.md", "a rework not on main", "rework\n\nBoard-Id: keeper-pickup-once");
    r.sync();
    const config = board(r);
    const d = inRepo(card("keeper-pickup-once"), config.collector.repos[0], { git: r.git, installed: r.main() }, config, 1, new Set(["keeper-pickup-once"]));
    assert.notEqual(d.phase, "live");
    assert.match(d.evidence, /keeper-pickup-once is behind/);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("with the shipped branch deleted, the left-behind one is read from main, and the evidence says so", () => {
  const { r } = c401();
  try {
    r.g(["push", "-q", "origin", "--delete", "v320/keeper-pickup-once"]); r.g(["fetch", "-q", "--prune", "origin"]);
    const config = board(r);
    const d = inRepo(card("keeper-pickup-once"), config.collector.repos[0], { git: r.git, installed: r.main() }, config, 1, new Set(["keeper-pickup-once"]));
    assert.equal(d.phase, "live", d.evidence);
    assert.match(d.evidence, /keeper-pickup-once was rebased: its change is on main as [0-9a-f]{12}/);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a branch already on main (nothing beyond it) is left as it is", () => {
  const { r, shipped } = c395();
  try {
    const tip = remoteHeads(r.git, "origin").find((h) => h.branch === "done-list-search-v320");
    assert.deepEqual(settledTips(r.git, "origin", "main", [tip]), [tip]);
    assert.equal(tip.sha, shipped);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

// #C433 (#C400 open for a day): a restack moved a hunk's context (main's 0a30d65 against the READY c3d3220: the same
// lines added, a neighbouring DECISIONS line changed in between), so git's patch-id, and git cherry, read the READY as
// never landed. The same files and changed lines (changeId) are the same change.
function moved() {
  const r = repo();
  writeFileSync(join(r.dir, "repo", "notes.md"), "a\nb\nc\nd\ne\n"); r.g(["add", "-A"]); r.g(["commit", "-qm", "notes"]);
  r.g(["checkout", "-qb", "ctx-card"]);
  writeFileSync(join(r.dir, "repo", "notes.md"), "a\nb\nNEW\nc\nd\ne\n"); r.g(["add", "-A"]); r.g(["commit", "-qm", "the change\n\nBoard-Id: ctx-card"]);
  const ready = r.g(["rev-parse", "HEAD"]).trim();
  r.g(["checkout", "-q", "main"]);
  writeFileSync(join(r.dir, "repo", "notes.md"), "A\nb\nc\nd\ne\n"); r.g(["add", "-A"]); r.g(["commit", "-qm", "another card's context line"]);
  writeFileSync(join(r.dir, "repo", "notes.md"), "A\nb\nNEW\nc\nd\ne\n"); r.g(["add", "-A"]); r.g(["commit", "-qm", "the change, restacked"]);
  const shipped = r.g(["rev-parse", "HEAD"]).trim();
  r.sync();
  return { r, ready, shipped };
}

test("#C433: a READY whose change landed with other context lines (git cherry says '+') reads as the commit on main", () => {
  const { r, ready, shipped } = moved();
  try {
    assert.match(r.g(["cherry", "origin/main", ready]), /^\+ /, "git's patch-id differs: the case #C400 was in");
    const tip = remoteHeads(r.git, "origin").find((h) => h.branch === "ctx-card");
    const [t] = settledTips(r.git, "origin", "main", [tip]);
    assert.deepEqual([t.sha, t.settled, t.branch], [shipped, "ctx-card", "main"]);
    const config = board(r);
    const d = inRepo(card("ctx-card"), config.collector.repos[0], { git: r.git, installed: r.main() }, config, 1, new Set(["ctx-card"]));
    assert.equal(d.phase, "live", d.evidence);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("#C433: another changed line, even one character, is another change: the card stays held", () => {
  const { r } = moved();
  try {
    r.g(["checkout", "-q", "ctx-card"]);
    writeFileSync(join(r.dir, "repo", "notes.md"), "a\nb\nNEW!\nc\nd\ne\n"); r.g(["add", "-A"]); r.g(["commit", "-qm", "a rework\n\nBoard-Id: ctx-card"]);
    r.sync();
    const tip = remoteHeads(r.git, "origin").find((h) => h.branch === "ctx-card");
    assert.deepEqual(settledTips(r.git, "origin", "main", [tip]), [tip]);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});
