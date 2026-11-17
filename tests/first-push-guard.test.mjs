// #C1065 (the owner, 11-12 at 9:03 pm: "can we enforce this programmatically so things are not missed?"): gate/first-push.mjs is a PreToolUse hook that refuses the first edit on a
// card branch origin does not have yet, because the board counts a card as started only from its first push (#C1059 was worked about 30 minutes with none). The list of what it
// must still allow comes first here (the guard-false-positives), then what it refuses, with real git repositories (a bare origin and a clone).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { refusal, bashTargets, reason, CARD_BRANCH } from "../gate/first-push.mjs";

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A bare origin with main, and a clone of it on `branch` (not pushed) or pushed.
function world(branch = "build/card-x", { push = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fb-first-push-")), bare = join(dir, "origin.git"), work = join(dir, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git(work, "remote", "add", "origin", bare);
  writeFileSync(join(work, "a.txt"), "a\n"); git(work, "add", "-A"); git(work, "commit", "-qm", "first"); git(work, "push", "-q", "origin", "main");
  if (branch !== "main") git(work, "switch", "-qc", branch);
  if (push) git(work, "push", "-q", "origin", branch);
  return { dir, work, bare, file: join(work, "a.txt"), outside: join(dir, "msg.txt") };
}
const edit = (file, cwd) => ({ tool_name: "Edit", tool_input: { file_path: file }, cwd });
const bash = (command, cwd) => ({ tool_name: "Bash", tool_input: { command }, cwd });
const withWorld = (fn, ...a) => { const w = world(...a); try { fn(w); } finally { rmSync(w.dir, { recursive: true, force: true }); } };

test("ALLOWED: a branch origin has, a branch that is not a card branch, a detached HEAD, a file outside every repository (the scratchpad's message files)", () => {
  withWorld((w) => assert.equal(refusal(edit(w.file, w.work)), null), "build/card-x", { push: true });
  for (const b of ["main", "dev", "manager/notes", "wip/x", "build"]) withWorld((w) => assert.equal(refusal(edit(w.file, w.work)), null, b), b);
  withWorld((w) => { git(w.work, "switch", "-q", "--detach"); assert.equal(refusal(edit(w.file, w.work)), null, "detached"); });
  withWorld((w) => assert.equal(refusal(edit(w.outside, w.work)), null, "a message file outside the worktree, however the cwd is the worktree"));
  withWorld((w) => assert.equal(refusal(edit(join(tmpdir(), "no-such-folder-fb-c1065", "x.txt"), w.work)), null, "a folder that does not exist, outside any repository"));
});

test("ALLOWED: the remote has the branch though this clone has no remote-tracking ref for it (pushed from another clone)", () => {
  withWorld((w) => {
    const other = join(w.dir, "other");
    execFileSync("git", ["clone", "-q", w.bare, other]);
    git(other, "switch", "-qc", "build/card-x"); git(other, "commit", "-q", "--allow-empty", "-m", "wip"); git(other, "push", "-q", "origin", "build/card-x");
    assert.equal(refusal(edit(w.file, w.work)), null);
  });
});

test("ALLOWED: every doubt: a remote that cannot be reached, not a git repository, an unreadable call, a tool the guard does not watch", () => {
  withWorld((w) => { git(w.work, "remote", "set-url", "origin", join(w.dir, "gone.git")); assert.equal(refusal(edit(w.file, w.work)), null, "ls-remote fails: the answer is yes"); });
  assert.equal(refusal({ tool_name: "Edit", tool_input: {}, cwd: tmpdir() }), null);
  assert.equal(refusal({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" }, cwd: tmpdir() }), null);
  assert.equal(refusal(null), null);
  assert.equal(refusal({ tool_name: "Edit", tool_input: { file_path: 42 } }), null);
  assert.equal(refusal(edit(join(tmpdir(), "x.txt"), tmpdir())), null, "a plain folder");
});

test("ALLOWED: git commands themselves (the empty commit and the push), reads, and a Bash command that writes only outside the repository", () => {
  withWorld((w) => {
    for (const c of [`git commit --allow-empty -m wip`, `git push origin build/card-x`, `git -C ${w.work} switch -c x`, "git status", "ls -la", "cat a.txt", "node --test tests/x.test.mjs", "npm test --prefix .", "grep -rn foo . 2>&1", "echo hi 2>/dev/null",
      `cat a.txt > /dev/null`, `echo hi > ${w.outside}`, `cp a.txt ${w.outside}`, `sed -i 's/a/b/' ${w.outside}`, `tee ${w.outside}`, `mkdir -p ${join(w.dir, "scratch")}`, "node scripts/stack-ready.mjs --config c.json"]) assert.equal(refusal(bash(c, w.work)), null, c);
  });
});

test("ALLOWED: anything inside .git of the worktree (the hooks and git itself write there), and a linked worktree's own .git file", () => {
  withWorld((w) => assert.equal(refusal(edit(join(w.work, ".git", "info", "exclude"), w.work)), null));
  withWorld((w) => {
    const linked = join(w.dir, "linked");
    git(w.work, "worktree", "add", "-q", "-b", "build/other-card", linked);
    assert.equal(refusal(edit(join(linked, "a.txt"), linked)), reason("build/other-card"), "the linked worktree is on an unpushed card branch: its files are guarded");
    assert.equal(refusal(edit(join(linked, ".git"), linked)), null, "but its .git file is git's");
  });
});

test("ALLOWED: a branch that was pushed once counts as started even if the remote has since lost it (the remote-tracking ref says so, no remote call needed)", () => {
  withWorld((w) => {
    git(w.bare, "branch", "-D", "build/card-x");
    assert.equal(execFileSync("git", ["-C", w.bare, "branch", "--list", "build/card-x"], { encoding: "utf8" }).trim(), "", "the remote no longer has it");
    assert.equal(refusal(edit(w.file, w.work)), null, "the stale remote-tracking ref in this clone shows it was pushed");
  }, "build/card-x", { push: true });
});

test("REFUSED: an Edit, Write, MultiEdit or NotebookEdit of a file in a worktree on a card branch origin does not have, with the reason", () => {
  withWorld((w) => {
    for (const tool of ["Edit", "Write", "MultiEdit"]) assert.equal(refusal({ tool_name: tool, tool_input: { file_path: w.file }, cwd: w.work }), reason("build/card-x"), tool);
    assert.equal(refusal({ tool_name: "NotebookEdit", tool_input: { notebook_path: join(w.work, "n.ipynb") }, cwd: w.work }), reason("build/card-x"));
    assert.equal(refusal(edit(join(w.work, "new", "deep", "file.txt"), w.work)), reason("build/card-x"), "a new file in a folder that does not exist yet");
    assert.equal(refusal(edit("a.txt", w.work)), reason("build/card-x"), "a relative path is the cwd's");
    assert.match(reason("build/card-x"), /Push this branch first \(an empty commit is fine\): the board counts a card as started from its first push\./);
    assert.match(reason("build/card-x"), /git push origin build\/card-x/);
  });
  for (const b of ["admin/x", "mainsite/y", "lang/z", "build/a/b"]) withWorld((w) => assert.equal(refusal(edit(w.file, w.work)), reason(b), b), b);
});

test("REFUSED: a Bash command that writes a file of the worktree: redirection, tee, sed -i, cp, mv, rm, touch, mkdir", () => {
  withWorld((w) => {
    for (const c of ["echo x > out.txt", "echo x >> a.txt", "echo x>out.txt", "cat a.txt | tee b.txt", "sed -i 's/a/b/' a.txt", "sed -i.bak 's/a/b/' a.txt", "cp a.txt b.txt", "mv a.txt c.txt", "rm a.txt", "touch n.txt", "mkdir newdir", "ls && echo x > out.txt", "FOO=1 echo x > out.txt", `echo x > ${w.work}/out.txt`, "git log > log.txt", "echo ok; rm -f a.txt"]) assert.equal(refusal(bash(c, w.work)), reason("build/card-x"), c);
  });
  withWorld((w) => { const sub = join(w.work, "sub"); mkdirSync(sub); assert.equal(refusal(bash("echo x > f.txt", sub)), reason("build/card-x"), "from a folder inside the worktree"); });
});

test("a symbolic link into the worktree is judged by where it points (the scratchpad and /private/tmp spelling)", () => {
  withWorld((w) => {
    const link = join(w.dir, "link"); symlinkSync(w.work, link);
    assert.equal(refusal(edit(join(link, "a.txt"), w.dir)), reason("build/card-x"));
  });
});

test("bashTargets reads the written files and only those; CARD_BRANCH names the card branches", () => {
  assert.deepEqual(bashTargets("echo a > x.txt && cp a b; rm -f c d | tee e"), ["x.txt", "b", "c", "d", "e"]);
  assert.deepEqual(bashTargets("git commit -m 'a > b'"), [], "a '>' inside a quoted message is no redirection");
  assert.deepEqual(bashTargets(`git commit -m "fix; rm x && touch y | tee z"`), [], "a separator inside quotes does not start a command");
  assert.deepEqual(bashTargets("git commit -F msg.txt -m 'x -> y'"), []);
  assert.deepEqual(bashTargets("git commit -F - <<'EOF'\nrm -rf here\ncp a b > c.txt\nEOF"), [], "a heredoc's body is text");
  assert.deepEqual(bashTargets("cat <<EOF > out.txt\nbody > no\nEOF"), ["out.txt"], "the redirect on the heredoc's own line is a write");
  assert.deepEqual(bashTargets(`echo x > "my file.txt"`), ["my file.txt"]);
  assert.deepEqual(bashTargets("ls 2>&1 >/dev/null"), []);
  assert.deepEqual(bashTargets("sed -n 1p a.txt"), []);
  for (const b of ["build/x", "admin/x", "mainsite/x", "lang/x", "build/x/y-z.1"]) assert.ok(CARD_BRANCH.test(b), b);
  for (const b of ["main", "dev", "manager/x", "build", "build/", "builder/x", "feature/x", "build/a b"]) assert.equal(CARD_BRANCH.test(b), false, b);
});

test("the hook as the app runs it: JSON on stdin, exit 2 and the reason on stderr to refuse, exit 0 and nothing for anything else or for garbage", () => {
  const script = new URL("../gate/first-push.mjs", import.meta.url).pathname;
  const run = (input) => spawnSync(process.execPath, [script, "--config", "/x/board.config.json"], { input, encoding: "utf8" });
  withWorld((w) => {
    const refused = run(JSON.stringify(edit(w.file, w.work)));
    assert.equal(refused.status, 2);
    assert.equal(refused.stderr.trim(), reason("build/card-x"));
    assert.equal(refused.stdout, "");
    git(w.work, "push", "-q", "origin", "build/card-x");
    const ok = run(JSON.stringify(edit(w.file, w.work)));
    assert.equal(ok.status, 0);
    assert.equal(ok.stderr, "");
  });
  for (const garbage of ["", "not json", "[]", "null", "{}"]) assert.equal(run(garbage).status, 0, JSON.stringify(garbage));
});
