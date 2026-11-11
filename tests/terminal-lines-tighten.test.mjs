// #C931 (Checker's LOWs on #C921): (1) the bare-cd test runs on the trimmed line, so "cd ~/x" with a trailing newline is refused; (2) a step's
// cmd (an Action's or a Later's Copy box) is checked as well as a Terminal line; (3) make-pair refuses a folder the shell would split, since
// every line names it unquoted. Real git for make-pair; fictional folders.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { askRefusal, bareCd, stepsRefusal } from "../worker/board-rules.mjs";
import { makeAll } from "../scripts/make-pair.mjs";

const terminal = (commands) => ({ type: "Terminal", title: "Copy the job check", asked_by: "Manager", commands });
const action = (steps) => ({ type: "Action", title: "Run the check", asked_by: "Manager", steps, expect: "It prints OK" });

test("(1) a bare cd with a trailing newline, or a tab, is refused", () => {
  for (const line of ["cd ~/x\n", "cd ~/x\r\n", "\tcd ~/x\n\n", "pushd ~/y\n"]) assert.equal(askRefusal(terminal([line]))?.rule, "terminal-bare-cd", JSON.stringify(line));
});

test("(2) a bare cd in an Action step's cmd is refused, and in a Later's steps too", () => {
  const r = askRefusal(action([{ text: "Go to the folder", cmd: "cd ~/Documents/Code/app" }, { text: "Run it", cmd: "node run.mjs" }]));
  assert.equal(r?.rule, "terminal-bare-cd");
  assert.match(r.detail, /Go to the folder/);
  assert.equal(stepsRefusal([{ text: "x", cmd: "cd /tmp/y\n" }])?.rule, "terminal-bare-cd", "a Later's steps go through the same check");
});

test("Still allowed: a cd chained in a one-liner, a cmd that only mentions cd, a word starting cd, steps with no cmd", () => {
  assert.equal(askRefusal(action([{ text: "Run it", cmd: "cd ~/x && node y.mjs" }])), null);
  assert.equal(askRefusal(action([{ text: "Run it", cmd: "node ~/cd/x.mjs --dir cd" }])), null);
  assert.equal(askRefusal(action([{ text: "Look", cmd: "ls ~/x" }, "Open the page and check the tile"])), null);
  assert.equal(askRefusal(terminal(["cd-tool --sync", "cdk deploy", "cd ~/x\nnode a.mjs"])), null);
  for (const c of ["cd-tool", "cdk", "echo cd", "cd ~/x && y", "cd ~/x; y", "cd ~/x || y", "cd x | y"]) assert.equal(bareCd(c), false, c);
  for (const c of ["cd", "cd ~/x", " cd -  ", "pushd /a/b", "cd ~/x\n"]) assert.equal(bareCd(c), true, c);
  assert.equal(bareCd(undefined), false); assert.equal(bareCd(5), false);
});

test("(3) make-pair refuses a folder with a space or a shell character, and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-c931-"));
  const bare = join(dir, "origin.git"), work = join(dir, "work");
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...a], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g("remote", "add", "origin", bare);
  mkdirSync(join(work, "worker")); writeFileSync(join(work, "worker", "a.mjs"), "1\n"); g("add", "-A"); g("commit", "-qm", "base (#C100)");
  g("push", "-q", "origin", "main");
  const sha = g("rev-parse", "HEAD");
  for (const name of ["with space", "quote'd", "dollar$x", "semi;colon", "glob*"]) {
    const out = join(dir, name); mkdirSync(out);
    const r = makeAll({ repo: work, sha, n: 1, out });
    assert.equal(r.ok, false, name);
    assert.match(r.why, /plain path/);
    assert.deepEqual(readdirSync(out), [], `${name}: nothing written`);
  }
  const plain = join(dir, "plain_out-1.x"); mkdirSync(plain);
  assert.equal(makeAll({ repo: work, sha, n: 1, out: plain }).ok, true, "a plain folder still works");
});
