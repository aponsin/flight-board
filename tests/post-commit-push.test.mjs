// #C1102 (a): a commit on a build/ branch is pushed to origin at once by .githooks/post-commit (scripts/post-commit-push.mjs), so the board shows the work within a probe
// run. Never forced, only build/*, never a detached HEAD, never harmful to the commit. The real hook runs in a real repository with a bare origin; FB_WIP_PUSH_SYNC=1 makes
// the push inline so the test can look at the result.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, appendFileSync, chmodSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { branchToPush, wipPush, passedFacts } from "../scripts/post-commit-push.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("branchToPush: only a plain refs/heads/build/<name>", () => {
  assert.equal(branchToPush("refs/heads/build/group-building-label-truth\n"), "build/group-building-label-truth");
  assert.equal(branchToPush("refs/heads/build/thing-v2"), "build/thing-v2");
  for (const bad of ["refs/heads/main", "refs/heads/feature/x", "refs/heads/build", "refs/heads/build/", "refs/heads/build/-x", "refs/heads/build/a b", "refs/heads/build/a;rm", "refs/heads/build/$(x)", "HEAD", "", null, undefined]) assert.equal(branchToPush(bad), null, String(bad));
});

test("wipPush with git injected: the push line, and every refusal says why", () => {
  const calls = [];
  const git = (answers) => (args) => { calls.push(args.join(" ")); const a = answers[args[0]]; if (a instanceof Error) throw a; return a ?? ""; };
  const ok = wipPush({ git: git({ "symbolic-ref": "refs/heads/build/x\n" }), env: {} });
  assert.deepEqual(ok, { pushed: true, why: "pushed", branch: "build/x" });
  assert.equal(calls.at(-1), "push -q origin HEAD:refs/heads/build/x", "a plain push: no force flag, no lease, no --all");
  assert.ok(!calls.some((c) => /force|-f\b|delete|\+/.test(c)));
  assert.equal(wipPush({ git: git({ "symbolic-ref": new Error("detached") }), env: {} }).why, "detached");
  assert.equal(wipPush({ git: git({ "symbolic-ref": "refs/heads/main\n" }), env: {} }).why, "not a build branch");
  assert.equal(wipPush({ git: git({ "symbolic-ref": "refs/heads/build/x\n", remote: new Error("none") }), env: {} }).why, "no origin");
  assert.equal(wipPush({ git: git({ "symbolic-ref": "refs/heads/build/x\n", push: new Error("refused") }), env: {} }).why, "push refused");
  assert.equal(wipPush({ git: git({ "symbolic-ref": "refs/heads/build/x\n" }), env: { FB_NO_WIP_PUSH: "1" } }).why, "switched off");
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-pcp-")), work = join(dir, "repo"), bare = join(dir, "origin.git");
  const env = { ...process.env, FB_WIP_PUSH_SYNC: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
  const g = (args, extra = {}) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...env, ...extra } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  mkdirSync(join(work, "scripts")); mkdirSync(join(work, ".githooks"));
  copyFileSync(join(ROOT, "scripts/post-commit-push.mjs"), join(work, "scripts/post-commit-push.mjs"));
  copyFileSync(join(ROOT, ".githooks/post-commit"), join(work, ".githooks/post-commit")); chmodSync(join(work, ".githooks/post-commit"), 0o755);
  g(["config", "core.hooksPath", ".githooks"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]);
  g(["commit", "-qm", "start"]);
  g(["push", "-q", "origin", "main"]);
  const commit = (n, extra = {}) => { appendFileSync(join(work, "a.md"), `${n}\n`); g(["add", "-A"]); g(["commit", "-qm", `Work ${n}\n\nBoard-Id: thing`], extra); return g(["rev-parse", "HEAD"]).trim(); };
  const remote = (ref) => { try { return execFileSync("git", ["rev-parse", ref], { cwd: bare, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
  return { g, commit, remote, work };
}

test("the real hook: a commit on a build/ branch is on origin at once, every commit after it too", () => {
  const s = scratch();
  s.g(["checkout", "-qb", "build/thing"]);
  const one = s.commit(1);
  assert.equal(s.remote("refs/heads/build/thing"), one, "the first commit created the branch on origin");
  const two = s.commit(2);
  assert.equal(s.remote("refs/heads/build/thing"), two, "and the next one moved it");
});

test("the real hook: a commit on main or another branch, or with the switch off, pushes nothing; the commit itself always succeeds", () => {
  const s = scratch();
  const main2 = s.commit(1);
  assert.notEqual(s.remote("refs/heads/main"), main2, "main is not pushed by the hook");
  s.g(["checkout", "-qb", "feature/other"]); s.commit(2);
  assert.equal(s.remote("refs/heads/feature/other"), null);
  s.g(["checkout", "-qb", "build/quiet"]); s.commit(3, { FB_NO_WIP_PUSH: "1" });
  assert.equal(s.remote("refs/heads/build/quiet"), null, "FB_NO_WIP_PUSH turns it off");
});

test("the real hook: a detached HEAD pushes nothing; a branch origin has moved is not forced, and the commit still lands", () => {
  const s = scratch();
  s.g(["checkout", "-qb", "build/thing"]); const one = s.commit(1);
  s.g(["checkout", "-q", "--detach"]); s.commit(2);
  assert.equal(s.remote("refs/heads/build/thing"), one, "detached: nothing");
  // origin's build/thing moves on elsewhere; a local commit that does not contain it is not forced over it
  s.g(["checkout", "-q", "build/thing"]);
  s.g(["reset", "-q", "--hard", "main"]);
  const local = s.commit(3);
  assert.equal(s.remote("refs/heads/build/thing"), one, "not a fast-forward: origin keeps its tip");
  assert.equal(s.g(["rev-parse", "HEAD"]).trim(), local, "the commit is made");
});

test("the real hook: no origin at all is no error", () => {
  const s = scratch();
  s.g(["remote", "remove", "origin"]);
  s.g(["checkout", "-qb", "build/thing"]);
  assert.doesNotThrow(() => s.commit(1));
});

test("#C1126 wipPush pushes the sha and branch it was handed, never HEAD; a bad sha is not pushed", () => {
  const calls = [];
  const git = (args) => { calls.push(args.join(" ")); return args[0] === "symbolic-ref" ? "refs/heads/build/other\n" : ""; };
  const sha = "a".repeat(40);
  assert.deepEqual(wipPush({ git, env: {}, sha, ref: "refs/heads/build/x\n" }), { pushed: true, why: "pushed", branch: "build/x" });
  assert.equal(calls.at(-1), `push -q origin ${sha}:refs/heads/build/x`, "the handed commit to the handed name, whatever HEAD is by now");
  assert.ok(!calls.includes("symbolic-ref -q HEAD"), "HEAD is not read again when the hook passed the branch");
  assert.equal(wipPush({ git, env: {}, sha: "HEAD", ref: "refs/heads/build/x" }).why, "not a commit");
  assert.equal(wipPush({ git, env: {}, sha: "--delete", ref: "refs/heads/build/x" }).why, "not a commit");
  assert.equal(wipPush({ git, env: {}, sha, ref: "refs/heads/main" }).why, "not a build branch");
  assert.deepEqual(passedFacts(["node", "x", "--now", `--sha=${sha}`, "--ref=refs/heads/build/x"]), { sha, ref: "refs/heads/build/x" });
  assert.deepEqual(passedFacts(["node", "x", "--now"]), { sha: null, ref: null });
});

test("#C1126 the real script: the commit the hook saw is pushed to its branch even when HEAD has moved on", () => {
  const s = scratch();
  s.g(["checkout", "-qb", "build/thing"]);
  const one = s.commit(1, { FB_NO_WIP_PUSH: "1" });
  const two = s.commit(2, { FB_NO_WIP_PUSH: "1" });
  s.g(["checkout", "-qb", "build/elsewhere"]);
  execFileSync(process.execPath, ["scripts/post-commit-push.mjs", "--now", `--sha=${one}`, "--ref=refs/heads/build/thing"], { cwd: s.work, stdio: "ignore" });
  assert.equal(s.remote("refs/heads/build/thing"), one, "the sha the hook passed, not the later HEAD");
  assert.notEqual(s.remote("refs/heads/build/thing"), two);
  assert.equal(s.remote("refs/heads/build/elsewhere"), null, "and never the branch HEAD is on now");
});

test("#C1126 (Security I2) the pre-push scan is the gate for an auto-pushed commit: a token-like string in a build/ commit is not pushed, the clean one before it is", () => {
  const s = scratch();
  // The real scripts the hook runs (scan, trailer check, group order and what they import) are copied in, and kept out of the scratch repository's own commits.
  appendFileSync(join(s.work, ".git/info/exclude"), "/scripts/\n/worker/\n/collector/\n/docs/\n/package.json\n");
  for (const d of ["scripts", "worker", "collector"]) cpSync(join(ROOT, d), join(s.work, d), { recursive: true });
  copyFileSync(join(ROOT, ".githooks/pre-push"), join(s.work, ".githooks/pre-push")); chmodSync(join(s.work, ".githooks/pre-push"), 0o755);
  // The scan reads a private word list from outside the repository and refuses every push without one.
  const words = join(mkdtempSync(join(tmpdir(), "fb-words-")), "words.txt"); writeFileSync(words, "zzprivateword\n");
  s.g(["config", "flightboard.scanwords", words]);
  s.g(["checkout", "-qb", "build/thing"]);
  const clean = s.commit(1);
  assert.equal(s.remote("refs/heads/build/thing"), clean, "a clean commit goes through the real pre-push hook");
  const secret = "gh" + "p_" + "A1b2C3d4".repeat(3); // built from pieces: the scan refuses it in a file too
  writeFileSync(join(s.work, "leak.md"), `${secret}\n`); s.g(["add", "-A"]);
  s.g(["commit", "-qm", "Leak\n\nBoard-Id: thing"]);
  assert.equal(s.remote("refs/heads/build/thing"), clean, "the scan refused the push: origin keeps the clean tip");
});

test("the hook file is executable, tracked, and ends every path with exit 0; the script has no force and no other branch", async () => {
  const { readFileSync, statSync } = await import("node:fs");
  assert.ok(statSync(join(ROOT, ".githooks/post-commit")).mode & 0o111, "executable");
  assert.match(readFileSync(join(ROOT, ".githooks/post-commit"), "utf8"), /exit 0\s*$/);
  const src = readFileSync(join(ROOT, "scripts/post-commit-push.mjs"), "utf8");
  assert.ok(!/--force|--force-with-lease|"-f"|--all|--delete|--mirror/.test(src.replace(/\/\/.*$/gm, "")), "no force, no --all, no delete");
});
