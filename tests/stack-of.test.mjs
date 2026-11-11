// #C859 slice 2: the stack read from git. Real git: a bare origin and a clone; commits carry Board-Id trailers.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { stackOf, boardIds, ownCommits } from "../collector/stack.mjs";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "fb-stack-"));
  const bare = join(dir, "origin.git"), work = join(dir, "work");
  const git = (args) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "f"), "0\n"); git(["add", "f"]); git(["commit", "-qm", "base"]); git(["push", "-q", "origin", "main"]);
  const commit = (id, extra = "") => { appendFileSync(join(work, "f"), `${id}\n`); git(["commit", "-qam", `work for ${id}\n\nBoard-Id: ${id}${extra}`]); return git(["rev-parse", "HEAD"]); };
  const tip = (branch) => ({ branch, sha: git(["rev-parse", branch]), at: 1 });
  return { git, run: (args) => git(args), commit, tip, push: () => git(["push", "-q", "origin", "--all"]) };
}

test("three cards on one branch are one stack in commit order, with the tip; a card with nothing pushed is next, by queue order", () => {
  const { git, run, commit, tip, push } = repo();
  git(["switch", "-q", "-c", "build/stack-a"]);
  const a = commit("card-one"), b = commit("card-two"), c = commit("card-three");
  push();
  const s = stackOf({ git: run, remote: "origin", main: "main", tips: [tip("build/stack-a")], open: ["card-one", "card-two", "card-three", "card-four", "card-five"] });
  assert.equal(s.branch, "build/stack-a");
  assert.equal(s.tip, c);
  assert.deepEqual(s.members.map((m) => [m.id, m.sha]), [["card-one", a], ["card-two", b], ["card-three", c]]);
  assert.ok(s.members.every((m) => Number.isFinite(m.at) && /Board-Id: /.test(m.message)), "each member carries its commit time and message");
  assert.deepEqual(s.outside, {});
  assert.deepEqual(s.next, ["card-four", "card-five"], "queue order");
});

test("a card whose commit sits on a branch not under the stack tip is outside the stack, and named with its branch", () => {
  const { git, run, commit, tip, push } = repo();
  git(["switch", "-q", "-c", "build/stack-a"]);
  commit("card-one"); commit("card-two");
  git(["switch", "-q", "main"]); git(["switch", "-q", "-c", "build/lonely"]);
  commit("card-four");
  push();
  const s = stackOf({ git: run, remote: "origin", main: "main", tips: [tip("build/stack-a"), tip("build/lonely")], open: ["card-one", "card-two", "card-four"] });
  assert.equal(s.branch, "build/stack-a");
  assert.deepEqual(s.members.map((m) => m.id), ["card-one", "card-two"]);
  assert.deepEqual(s.outside, { "card-four": "build/lonely" });
  assert.deepEqual(s.next, []);
});

test("an earlier part of the stack on its own branch is inside, not outside; a closed card's commit is ignored", () => {
  const { git, run, commit, tip, push } = repo();
  git(["switch", "-q", "-c", "build/part"]);
  commit("card-one");
  git(["switch", "-q", "-c", "build/stack-a"]);
  commit("card-two"); commit("card-three");
  push();
  const s = stackOf({ git: run, remote: "origin", main: "main", tips: [tip("build/part"), tip("build/stack-a")], open: ["card-one", "card-two"] });
  assert.equal(s.branch, "build/stack-a");
  assert.deepEqual(s.members.map((m) => m.id), ["card-one", "card-two"], "card-three is closed: not a member");
  assert.deepEqual(s.outside, {});
});

test("the branch with more open cards is the stack; a tie goes to the newest tip, then the name", () => {
  const { git, run, commit, tip, push } = repo();
  git(["switch", "-q", "-c", "build/x"]); commit("card-one");
  git(["switch", "-q", "main"]); git(["switch", "-q", "-c", "build/y"]); commit("card-two");
  push();
  const x = { ...tip("build/x"), at: 5 }, y = { ...tip("build/y"), at: 9 };
  assert.equal(stackOf({ git: run, remote: "origin", main: "main", tips: [x, y], open: ["card-one", "card-two"] }).branch, "build/y", "newest tip");
  assert.equal(stackOf({ git: run, remote: "origin", main: "main", tips: [{ ...x, at: 9 }, y], open: ["card-one", "card-two"] }).branch, "build/x", "then the name");
});

test("nothing pushed for any open card gives no stack; main itself and a branch with a bad name are never a stack", () => {
  const { git, run, commit, tip, push } = repo();
  assert.equal(stackOf({ git: run, remote: "origin", main: "main", tips: [tip("main")], open: ["card-one"] }), null);
  git(["switch", "-q", "-c", "build/ok"]); commit("card-one"); push();
  assert.equal(stackOf({ git: run, remote: "origin", main: "main", tips: [{ branch: "--evil", sha: tip("build/ok").sha }, { branch: "bad branch", sha: tip("build/ok").sha }], open: ["card-one"] }), null);
  assert.equal(stackOf({ git: run, remote: "origin", main: "main", tips: [tip("build/ok")], open: [] }), null);
});

test("Board-Id lines are read exactly: one card per line, a lookalike is not a card, a bad id is dropped", () => {
  assert.deepEqual(boardIds("subject\n\nBoard-Id: card-one\nBoard-Id: card-two\nCo-Authored-By: x"), ["card-one", "card-two"]);
  assert.deepEqual(boardIds("Board-Id: card-one extra words\nboard-id: card-two\n Board-Id: card-three\nBoard-Id: Bad_Id\nBoard-Id: -x"), []);
  assert.deepEqual(ownCommits(() => { throw new Error("git failed"); }, "origin", "main", "a".repeat(40)), []);
  assert.deepEqual(ownCommits(() => "", "origin", "main", "not-a-sha"), []);
});
