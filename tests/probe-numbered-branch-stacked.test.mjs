// #C1204, Checker 2's M1 and L1 on 29216693: a branch cut on another card's signed, unshipped tip and named for the new card by number must not read that tip's sign-offs as the
// card's (it is work started: build, no sign-offs), and the weekly sweep of shipped branches must not list the numbered branch of an open card. Real git; fictional names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cardState, byNumberOnly as probeByNumberOnly } from "../collector/state.mjs";
import { shippedBranchesWrite } from "../collector/shipped-branches.mjs";

const T = 1_800_000_000_000;
const head = (sha, branch, message, at = 1) => ({ sha, branch, message, at });
const config = { phases: [["plan"], ["build"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-numbered-"));
  const g = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]);
  g(["commit", "-q", "--allow-empty", "-m", "base"]);
  DIRS.set(g, dir);
  return g;
}
const DIRS = new WeakMap();
const dirOf = (g) => DIRS.get(g);

test("a branch cut on another card's signed tip and named for this card by number reads build with no sign-offs; its own commit then reads normally", () => {
  const g = scratch();
  g(["switch", "-q", "-c", "build/first-card"]);
  g(["commit", "-q", "--allow-empty", "-m", "#C1195: the first card"]);
  const first = g(["rev-parse", "HEAD"]).trim();
  g(["notes", "--ref=refs/notes/checker", "add", "-m", "PASS", first]); g(["notes", "--ref=refs/notes/security", "add", "-m", "SECURE", first]);
  g(["update-ref", "refs/remotes/origin/main", "main"]);
  const notes = { checker: "refs/notes/checker", security: "refs/notes/security" };
  const card = { id: "next-thing", num: 1196, level: "Full", phase: "plan" };
  const repoAt = (sha, message) => ({ git: g, remote: "origin", main: "main", notes, tips: [{ branch: "build/c1196-next-thing", sha, at: T, message }, { branch: "main", sha: "x", at: T, message: "" }], live: null, versionPattern: null });
  const s = cardState(card, repoAt(first, "#C1195: the first card"), config, T);
  assert.equal(s.phase, "build"); assert.deepEqual(s.signed, []); assert.equal(s.onMain, false);
  g(["switch", "-q", "-c", "build/c1196-next-thing"]);
  writeFileSync(join(dirOf(g), "own.md"), "x\n"); g(["add", "-A"]);
  g(["commit", "-q", "-m", "#C1196 (Role): the next card\n\nBoard-Id: next-thing"]);
  const own = g(["rev-parse", "HEAD"]).trim();
  const t = cardState(card, repoAt(own, "#C1196 (Role): the next card\n\nBoard-Id: next-thing"), config, T);
  assert.equal(t.headSha, own); assert.equal(t.phase, "checker"); assert.deepEqual(t.signed, []);
});

test("byNumberOnly: only a head found by its number alone and not the card's own commit", () => {
  const card = { id: "next-thing", num: 1196 };
  for (const f of [probeByNumberOnly]) {
    assert.equal(f(card, head("1", "build/c1196-next-thing", "#C1195: another card")), true);
    assert.equal(f(card, head("2", "build/c1196-next-thing", "no subject")), true);
    assert.equal(f(card, head("3", "build/c1196-next-thing", "#C1196 (Role): own")), false);
    assert.equal(f(card, head("4", "build/c1196-next-thing", "x\n\nBoard-Id: next-thing")), false);
    assert.equal(f(card, head("5", "build/next-thing", "#C1195: named by id")), false, "a branch named by the card's id is not found by number alone");
    assert.equal(f(card, head("6", "build/c1197-other", "#C1195: other number")), false);
    assert.equal(f({ id: "x" }, head("7", "build/c1196-next-thing", "#C1195")), false, "a card with no number");
    assert.equal(f(card, null), false);
  }
  // The phase of such a head is read in cardState (the test above: build, no sign-offs, though the tip carries both); phaseOf alone does not look at the head's name.
});

test("the shipped-branch sweep does not list the numbered branch of an open card, and lists it once the card is not open", () => {
  const g = scratch();
  g(["switch", "-q", "-c", "build/c777-open-work"]); g(["commit", "-q", "--allow-empty", "-m", "work with no card subject"]); g(["switch", "-q", "main"]);
  g(["merge", "-q", "--no-ff", "-m", "merge", "build/c777-open-work"]); g(["commit", "-q", "--allow-empty", "-m", "main moves on"]);
  g(["update-ref", "refs/remotes/origin/main", "main"]); g(["update-ref", "refs/remotes/origin/build/c777-open-work", "build/c777-open-work"]);
  const cfg = JSON.stringify({ collector: { repoPath: "~/Code/demo-repo", remote: "origin", mainBranch: "main" } });
  const run = (openIds) => shippedBranchesWrite(cfg, { git: (_r, args) => g(args), openIds, now: T }).value.repos.flatMap((r) => r.remoteBranches.map((b) => b.name));
  assert.deepEqual(run([{ id: "open-work", num: 777 }]), []);
  assert.deepEqual(run([{ id: "other", num: 778 }]), ["build/c777-open-work"]);
});
