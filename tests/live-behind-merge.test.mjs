// #C1376 (Director's audit #C1375, case 4): the version rule of #C1278 looked for the version commit with `git log --first-parent --ancestry-path sha..live`. For a card whose commit
// reached main INSIDE a group (under the group's head, which main merged), that search returned nothing, so the card could never read live (#C1315, #C1320 to #C1323, #C1333,
// #C1224; fixture d5af0dd8 under group head c6b160f0). The version is now the first commit on main's first-parent line that contains the card's commit.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cardState } from "../collector/state.mjs";

const cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
const PATTERN = "^v(\\d+\\.\\d+\\.\\d+)\\b";

// main: base, v1.0.1 (an earlier ship). A group branch with two commits: `card` (the card's) and `head` (a later groupmate's). `shape` says how they reach main:
//   "direct":      main merges `card` itself (the card is the merged head), then the version commit
//   "behind":      main merges `head`, which sits above `card` (the card is behind the merge), then the version commit
//   "unversioned": as behind, with no version commit after the merge
// `liveAt` is the live commit: the version commit ("version") or the merge ("merge").
function read({ shape, liveAt = "version" }) {
  const dir = mkdtempSync(join(tmpdir(), "fb-behind-")), git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "gc.auto", "0");
    const commit = (name, msg) => { writeFileSync(join(dir, name), name + "\n"); git("add", "-A"); git("commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };
    const base = commit("a.txt", "base");
    const v0 = commit("b.txt", "v1.0.1: admin/an-older-card@" + base);
    git("checkout", "-q", "-b", "admin/c-card", v0);
    const card = commit("c.txt", "The card's work\n\nBoard-Id: c-card");
    git("checkout", "-q", "-b", "admin/g-mate", card);
    const head = commit("d.txt", "A groupmate's work, above it");
    git("checkout", "-q", "main");
    const merging = shape === "direct" ? card : head;
    git("merge", "-q", "--no-ff", "-m", "Merge commit '" + merging + "' into dev", merging);
    const merged = git("rev-parse", "HEAD");
    let version = null;
    if (shape !== "unversioned") { writeFileSync(join(dir, "ver.txt"), "1.0.2\n"); git("add", "-A"); git("commit", "-q", "-m", "v1.0.2: admin/g-mate@" + head); version = git("rev-parse", "HEAD"); }
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
    git("update-ref", "refs/remotes/origin/admin/c-card", card);
    const T = Date.now(), live = liveAt === "merge" || !version ? merged : version;
    const tips = [{ branch: "admin/c-card", sha: card, at: T, message: "The card's work\n\nBoard-Id: c-card" }, { branch: "main", sha: git("rev-parse", "HEAD"), at: T - 1000, message: "main" }];
    return cardState({ id: "c-card", num: 1315, level: "Quick", phase: "ship" }, { git: (args) => git(...args), remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips, live, versionPattern: PATTERN, shippedPattern: "([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})" }, cfg, T);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a commit main merged directly reads live with the version after it (as before)", () => {
  const r = read({ shape: "direct" });
  assert.equal(r.phase, "live");
  assert.equal(r.liveVersion, "1.0.2");
});

test("a commit behind a merge (under the group head main merged) reads live with the first version commit that contains it", () => {
  const r = read({ shape: "behind" });
  assert.equal(r.phase, "live");
  assert.equal(r.liveVersion, "1.0.2");
});

test("a commit in no version yet stays at ship with no version: no version commit at all, or live is the merge and the version commit is not in it", () => {
  const none = read({ shape: "unversioned" });
  assert.equal(none.phase, "ship");
  assert.equal(none.liveVersion, null);
  const merged = read({ shape: "behind", liveAt: "merge" });
  assert.equal(merged.phase, "ship");
  assert.equal(merged.liveVersion, null);
});

test("the version found is the first one after the commit, not an earlier one under it", () => {
  assert.notEqual(read({ shape: "behind" }).liveVersion, "1.0.1");
});
