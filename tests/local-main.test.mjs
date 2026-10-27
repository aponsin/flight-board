// Local main after a push (#C282): an install or a board release pushes a signed commit to origin/main, and
// scripts/current.mjs then fast-forwards the checkout's own main to it, only when that is a fast-forward and touches
// nobody's work: main checked out and clean, or not checked out at all. Anything else is left as it is, and said.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localMainMove, fastForwardMain } from "../scripts/current.mjs";

const A = "a".repeat(40), B = "b".repeat(40);

test("localMainMove: a fast-forward only, and only over no one's work", () => {
  const base = { sha: B, main: A, behind: true, contains: false, checkedOut: null, clean: true, busy: false };
  assert.equal(localMainMove(base).action, "ref", "not checked out: the ref moves");
  assert.equal(localMainMove({ ...base, checkedOut: "/w" }).action, "merge", "checked out and clean: a fast-forward merge there");
  assert.match(localMainMove({ ...base, main: null }).say, /no local main/);
  assert.match(localMainMove({ ...base, main: B }).say, /already at/);
  assert.match(localMainMove({ ...base, behind: false, contains: true }).say, /already has/);
  assert.match(localMainMove({ ...base, behind: false }).say, /diverged/);
  assert.match(localMainMove({ ...base, checkedOut: "/w", clean: false }).say, /uncommitted changes/);
  assert.match(localMainMove({ ...base, checkedOut: "/w", busy: true }).say, /in the middle/);
  assert.match(localMainMove({ ...base, busy: true }).say, /in the middle/, "main being rebased in a worktree, not checked out by name");
  for (const f of [{ main: null }, { main: B }, { behind: false }, { behind: false, contains: true }, { checkedOut: "/w", clean: false }, { busy: true }]) assert.equal(localMainMove({ ...base, ...f }).action, "none", JSON.stringify(f));
});

// A real origin, a checkout with main, a signed commit pushed past it.
function repos() {
  const base = mkdtempSync(join(tmpdir(), "fb-local-main-"));
  const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const origin = join(base, "origin.git"), co = join(base, "co"), other = join(base, "other");
  mkdirSync(origin); g(origin, "init", "-q", "--bare");
  g(base, "clone", "-q", origin, co);
  writeFileSync(join(co, "f"), "1"); g(co, "add", "f"); g(co, "commit", "-qm", "one"); g(co, "push", "-q", "origin", "HEAD:main");
  g(base, "clone", "-q", "-b", "main", origin, other);
  writeFileSync(join(other, "f"), "2"); g(other, "commit", "-qam", "two"); g(other, "push", "-q", "origin", "main");
  g(co, "fetch", "-q", "origin");
  const sha = g(co, "rev-parse", "origin/main"), old = g(co, "rev-parse", "main");
  return { base, co, g, sha, old, main: () => g(co, "rev-parse", "main") };
}

test("fastForwardMain: a clean checkout of main moves, its files with it", () => {
  const r = repos();
  try {
    assert.match(fastForwardMain(r.co, r.sha), /local main: .* → /);
    assert.equal(r.main(), r.sha);
    assert.equal(r.g(r.co, "status", "--porcelain"), "", "the working tree followed");
    assert.match(fastForwardMain(r.co, r.sha), /already at/);
  } finally { rmSync(r.base, { recursive: true, force: true }); }
});

test("fastForwardMain: an untracked file is no change, and stays", () => {
  const r = repos();
  try {
    writeFileSync(join(r.co, "notes.txt"), "mine");
    assert.match(fastForwardMain(r.co, r.sha), / → /);
    assert.equal(r.main(), r.sha);
    assert.equal(r.g(r.co, "status", "--porcelain"), "?? notes.txt");
  } finally { rmSync(r.base, { recursive: true, force: true }); }
});

test("fastForwardMain: uncommitted changes, a diverged main, a main ahead: left exactly as they are", () => {
  const r = repos();
  try {
    writeFileSync(join(r.co, "f"), "local edit");
    assert.match(fastForwardMain(r.co, r.sha), /left .*uncommitted changes/);
    assert.equal(r.main(), r.old);
    r.g(r.co, "commit", "-qam", "local work");
    const mine = r.main();
    assert.match(fastForwardMain(r.co, r.sha), /left .*diverged/);
    assert.equal(r.main(), mine, "local work never reset");
  } finally { rmSync(r.base, { recursive: true, force: true }); }
  const s = repos();
  try {
    s.g(s.co, "merge", "-q", "--ff-only", s.sha);
    writeFileSync(join(s.co, "g"), "x"); s.g(s.co, "add", "g"); s.g(s.co, "commit", "-qm", "ahead");
    const ahead = s.main();
    assert.match(fastForwardMain(s.co, s.sha), /already has/);
    assert.equal(s.main(), ahead);
  } finally { rmSync(s.base, { recursive: true, force: true }); }
});

test("fastForwardMain: main not checked out moves as a ref; run from another worktree (an install's), the same", () => {
  const r = repos();
  try {
    r.g(r.co, "switch", "-q", "-c", "card");
    writeFileSync(join(r.co, "f"), "card work in progress");
    const wt = join(r.base, "wt"); r.g(r.co, "worktree", "add", "-q", "--detach", wt, r.sha);
    assert.match(fastForwardMain(wt, r.sha), / → /);
    assert.equal(r.main(), r.sha);
    assert.equal(r.g(r.co, "rev-parse", "--abbrev-ref", "HEAD"), "card", "the branch someone works on is untouched");
    assert.equal(r.g(r.co, "status", "--porcelain"), "M f");
  } finally { rmSync(r.base, { recursive: true, force: true }); }
});

test("fastForwardMain: main checked out in another worktree moves there only when that one is clean", () => {
  const r = repos();
  try {
    r.g(r.co, "switch", "-q", "-c", "card");
    const wt = join(r.base, "wt"); r.g(r.co, "worktree", "add", "-q", wt, "main");
    writeFileSync(join(wt, "f"), "edit in the main worktree");
    assert.match(fastForwardMain(r.co, r.sha), /uncommitted changes/);
    assert.equal(r.main(), r.old);
    r.g(wt, "checkout", "-q", "--", "f");
    assert.match(fastForwardMain(r.co, r.sha), / → /);
    assert.equal(r.main(), r.sha);
    assert.equal(r.g(wt, "status", "--porcelain"), "");
  } finally { rmSync(r.base, { recursive: true, force: true }); }
});

test("fastForwardMain: main mid-rebase is left alone", () => {
  const r = repos();
  try {
    writeFileSync(join(r.co, "g"), "a"); r.g(r.co, "add", "g"); r.g(r.co, "commit", "-qm", "a");
    writeFileSync(join(r.co, "g"), "b"); r.g(r.co, "commit", "-qam", "b");
    const before = r.main();
    try { r.g(r.co, "rebase", "-q", "--exec", "false", "HEAD~1"); } catch { /* stops on the failing exec */ }
    assert.match(fastForwardMain(r.co, r.sha), /in the middle/);
    assert.equal(r.main(), before);
  } finally { rmSync(r.base, { recursive: true, force: true }); }
});

test("fastForwardMain: never throws; a repository it can't read is said, not fatal", () => {
  const base = mkdtempSync(join(tmpdir(), "fb-local-main-none-"));
  try { assert.match(fastForwardMain(base, A), /local main: left as it is/); }
  finally { rmSync(base, { recursive: true, force: true }); }
});
