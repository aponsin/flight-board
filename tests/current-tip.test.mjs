// #C237: a card's phase comes from its branch's current tip, and a card is one branch.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { headsFor } from "../collector/derive.mjs";
import { collect, tipsOnly } from "../collector/collect.mjs";

const PATTERN = "([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})";
const T0 = 1_790_000_000; // seconds; every commit's time is set, so "newest" never rests on the clock

// A scratch repository whose commits carry the times given (seconds after T0).
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "fb-tip-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  const commit = (t, file, msg) => { at = T0 + t; writeFileSync(join(work, file), msg + "\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  const merge = (t, branch, msg) => { at = T0 + t; g(["merge", "-q", "--no-ff", "-m", msg, branch]); return g(["rev-parse", "HEAD"]).trim(); };
  const sync = () => { g(["push", "-q", "--all", "origin"]); g(["push", "-q", "origin", "refs/notes/*:refs/notes/*"]); g(["fetch", "-q", "--prune", "origin"]); g(["fetch", "-q", "origin", "+refs/notes/*:refs/notes/flight-board/*"]); };
  commit(0, "a.md", "start");
  return { dir, g, commit, merge, sync, git: (args) => g(args), at: (t) => (T0 + t) * 1000 };
}
const cfg = (r) => fullConfig({ owner: "Sam", collector: { repoPath: r.dir, notes: { checker: "refs/notes/checker" }, deployWorkflow: "CI", shippedPattern: PATTERN } });
const deployedAt = (sha) => () => JSON.stringify([{ headSha: sha }]);

test("commit A shipped in 1.113, tip B on the same branch unshipped: the phase is B's and there is no version (#C224)", () => {
  const r = repo();
  try {
    r.g(["checkout", "-qb", "build/tip-card"]);
    const a = r.commit(10, "t.md", "first try\n\nBoard-Id: tip-card");
    const b = r.commit(20, "t.md", "the rework\n\nBoard-Id: tip-card");
    // The release (later than B) shipped A only, and named it.
    r.g(["checkout", "-q", "main"]); r.g(["checkout", "-qb", "rel", a]); r.g(["checkout", "-q", "main"]);
    r.merge(30, "rel", `v1.113.0: build/tip-card@${a.slice(0, 8)}`);
    r.g(["branch", "-qD", "rel"]);
    r.sync();
    const main = r.g(["rev-parse", "main"]).trim();
    const { doc } = collect({ config: cfg(r), cards: [{ id: "tip-card", status: "active", level: "Quick" }], git: r.git, gh: deployedAt(main), now: 1 });
    const d = doc.cards["tip-card"];
    assert.equal(d.head, b, "the branch's tip, never the older commit the release named");
    assert.equal(d.phase, "checker", "B is READY (its trailer), not signed yet");
    assert.equal(d.version, undefined);
    assert.equal(d.branches, undefined, "one branch");
    // Once the branch is deleted, the shipped commit is all there is: it counts again.
    r.g(["push", "-q", "origin", "--delete", "build/tip-card"]); r.g(["fetch", "-q", "--prune", "origin"]);
    const gone = collect({ config: cfg(r), cards: [{ id: "tip-card", status: "active", level: "Quick" }], git: r.git, gh: deployedAt(main), now: 1 }).doc.cards["tip-card"];
    assert.equal(gone.head, a);
    assert.equal(gone.phase, "live");
    assert.equal(gone.version, "1.113.0");
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("tipsOnly: a shipped head counts only for a branch gone from the remote", () => {
  const remote = [{ branch: "build/x", sha: "b", at: 1 }];
  assert.deepEqual(tipsOnly(remote, [{ branch: "build/x", sha: "a", at: 9 }, { branch: "build/y", sha: "c", at: 2 }]), [{ branch: "build/y", sha: "c", at: 2 }]);
});

test("headsFor: each of the card's branches once, at its newest tip, by trailer or by name", () => {
  const heads = [
    { branch: "build/x", sha: "1", at: 1, message: "" },
    { branch: "build/x", sha: "2", at: 5, message: "" },
    { branch: "fix/other", sha: "3", at: 3, message: "fix\n\nBoard-Id: x" },
    { branch: "build/y", sha: "4", at: 9, message: "y\n\nBoard-Id: y" },
  ];
  assert.deepEqual(headsFor("x", heads).map((h) => h.sha), ["2", "3"]);
  assert.deepEqual(headsFor("z", heads), []);
});

test("a card on two branches: the least advanced one sets its phase, the card names it, and the collector says to split (1b)", () => {
  const r = repo();
  try {
    r.g(["checkout", "-qb", "build/two-card"]);
    const a = r.commit(10, "t.md", "first\n\nBoard-Id: two-card");
    r.g(["checkout", "-q", "main"]); r.merge(20, "build/two-card", "Merge two-card");
    r.commit(21, "v.md", `v1.2.0: build/two-card@${a.slice(0, 8)}`);
    r.g(["checkout", "-qb", "fix/two-card-again", "main"]);
    const b = r.commit(30, "u.md", "again\n\nBoard-Id: two-card");
    r.g(["checkout", "-q", "main"]);
    r.sync();
    const main = r.g(["rev-parse", "main"]).trim();
    const { doc, conflicts } = collect({ config: cfg(r), cards: [{ id: "two-card", status: "active", level: "Quick" }], git: r.git, gh: deployedAt(main), now: 1 });
    const d = doc.cards["two-card"];
    assert.equal(d.head, b);
    assert.equal(d.phase, "checker", "live on one branch, waiting for review on the other: not live");
    assert.deepEqual(d.branches.sort(), ["build/two-card", "fix/two-card-again"]);
    assert.equal(d.behind, "fix/two-card-again");
    assert.match(d.evidence, /2 branches, fix\/two-card-again is behind/);
    assert.ok(conflicts.some((l) => /^two-card: 2 branches \(.*\): one card is one branch; split the rework into a sub-card$/.test(l)), conflicts.join("\n"));
    // Every tip deployed: live.
    r.merge(40, "fix/two-card-again", "Merge again"); r.commit(41, "w.md", `v1.3.0: fix/two-card-again@${b.slice(0, 8)}`);
    r.sync();
    const main2 = r.g(["rev-parse", "main"]).trim();
    const both = collect({ config: cfg(r), cards: [{ id: "two-card", status: "active", level: "Quick" }], git: r.git, gh: deployedAt(main2), now: 1 }).doc.cards["two-card"];
    assert.equal(both.phase, "live");
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("main and a ship run's candidate branch are never a card's branch, whatever their tip says", () => {
  const r = repo();
  try {
    r.g(["checkout", "-qb", "build/ff-card"]);
    const a = r.commit(10, "t.md", "work\n\nBoard-Id: ff-card");
    r.g(["checkout", "-q", "main"]); r.g(["merge", "-q", "--ff-only", "build/ff-card"]);
    r.g(["checkout", "-qb", "build/ship-v1.4.0"]); r.g(["checkout", "-q", "main"]);
    r.sync();
    const config = fullConfig({ owner: "Sam", collector: { repoPath: r.dir, notes: { checker: "refs/notes/checker" }, deployWorkflow: "CI", shippedPattern: PATTERN, candidatePattern: "^build/ship-v" } });
    const { doc, conflicts } = collect({ config, cards: [{ id: "ff-card", status: "active", level: "Quick" }], git: r.git, gh: deployedAt(a), now: 1 });
    assert.equal(doc.cards["ff-card"].branches, undefined, "main fast-forwarded to the card's tip is not a second branch");
    assert.equal(doc.cards["ff-card"].phase, "live");
    assert.deepEqual(conflicts, []);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});
