// #C1047: READY (the stack-ready push) refuses a tip that undoes work already on main. G4 v1 (648abc1d) went to review with a pre-#C1008 tree: it deleted
// Pull out, the group rows and the store route, and the Worker would not load. Real git, a bare origin and a work clone. A branch that changes a file main
// changed after the branch's base, with a version that is not main's, is refused with the file list and nothing is pushed; a rebase onto main, a branch cut
// on main that edits the same files on purpose, a stale branch whose files are not main's, and the same change on both sides are all let through.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { stackReady, staleFiles, STALE_LISTED } from "../scripts/stack-ready.mjs";

const NOW = "2026-11-12T20:00:00.000Z";
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-stale-")), work = join(dir, "work"), bare = join(dir, "origin.git");
  const g = (args, cwd = work) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  const put = (file, text) => writeFileSync(join(work, file), text);
  const commit = (msg, files = {}) => { for (const [f, t] of Object.entries(files)) put(f, t); g(["add", "-A"]); g(["commit", "-qm", msg]); };
  // main starts with a few files, pushed.
  for (const [f, t] of Object.entries({ "page.html": "page v1\n", "store.mjs": "store v1\n", "notes.md": "notes v1\n", "other.md": "other v1\n", "tool.sh": "echo a\n" })) put(f, t);
  chmodSync(join(work, "tool.sh"), 0o755); // really executable on disk, so a later `git add -A` keeps the mode
  g(["add", "-A"]); g(["commit", "-qm", "start"]);
  g(["push", "-q", "origin", "main"]);
  const ready = () => stackReady({ run: (a) => g(a), queue: null, now: () => NOW });
  const pushedBranches = () => execFileSync("git", ["branch", "--list"], { cwd: bare, encoding: "utf8" }).replace(/[* ]/g, "").split("\n").filter(Boolean);
  // main moves on without this checkout: a second clone lands a commit and pushes it, so origin/main is ahead of the base the branch was cut from.
  const moveMain = (files, msg = "main moves", { notExec = [] } = {}) => {
    const other = join(dir, "other");
    try { execFileSync("git", ["clone", "-q", bare, other], { stdio: "ignore" }); } catch { /* cloned already */ }
    const o = (args) => execFileSync("git", args, { cwd: other, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    o(["config", "user.email", "t@example.com"]); o(["config", "user.name", "T"]);
    o(["pull", "-q", "origin", "main"]);
    for (const [f, t] of Object.entries(files)) { if (t === null) o(["rm", "-q", f]); else writeFileSync(join(other, f), t); }
    o(["add", "-A"]);
    for (const f of notExec) o(["update-index", "--chmod=-x", f]);
    o(["commit", "-qm", msg]); o(["push", "-q", "origin", "main"]);
  };
  const branch = (name = "build/card-x") => g(["checkout", "-qb", name]);
  return { dir, work, bare, g, commit, ready, moveMain, branch, pushedBranches, put };
}
const work = (s, msg = "Work\n\nBoard-Id: card-x") => (files) => s.commit(msg, files);

test("a tip that carries an older version of a file main changed is refused, with the files listed, and nothing is pushed", () => {
  const s = scratch();
  s.branch();
  work(s)({ "page.html": "page v1 + the branch's edit\n", "store.mjs": "store v1 + the branch's edit\n" });
  s.moveMain({ "page.html": "page v2: main added Pull out\n", "store.mjs": "store v2: main added the route\n" });
  assert.throws(() => s.ready(), (e) => /does not carry main's change to 2 files this branch also changes, so landing it would undo main: page\.html, store\.mjs\. Rebase onto origin\/main/.test(e.message));
  assert.deepEqual(s.pushedBranches(), ["main"], "the branch was not pushed");
  assert.equal(execFileSync("git", ["for-each-ref", "refs/notes/stack-ready"], { cwd: s.bare, encoding: "utf8" }).trim(), "", "no signal either");
});

test("a rebase onto main is let through, and so is a branch cut on main that edits the same files on purpose", () => {
  const s = scratch();
  s.branch();
  work(s)({ "page.html": "page v1 + the branch's edit\n" });
  s.moveMain({ "page.html": "page v2: main added Pull out\n" });
  assert.throws(() => s.ready(), /undo main: page\.html/);
  // Rebase onto main resolving the file by taking both changes: the base is now main, nothing changed after it.
  s.g(["fetch", "-q", "origin", "main"]);
  try { s.g(["rebase", "origin/main"]); } catch { s.put("page.html", "page v2: main added Pull out + the branch's edit\n"); s.g(["add", "-A"]); s.g(["-c", "core.editor=true", "rebase", "--continue"]); }
  const r = s.ready();
  assert.match(r.line, /^STACK-READY OK: pushed build\/card-x at [0-9a-f]{12}, signal written/);
  assert.ok(s.pushedBranches().includes("build/card-x"));
  // A branch cut on main now edits the same file on purpose: its base includes main's commit.
  s.g(["checkout", "-q", "main"]); s.g(["pull", "-q", "origin", "main"]);
  s.branch("build/card-y");
  s.commit("Edit on purpose\n\nBoard-Id: card-y", { "page.html": "page v3: edited on top of main\n" });
  assert.match(s.ready().line, /^STACK-READY OK: pushed build\/card-y at /);
});

test("a stale branch whose files main has not changed is let through, however far behind main it is", () => {
  const s = scratch();
  s.branch();
  work(s)({ "notes.md": "notes v1 + the branch's edit\n", "new-file.md": "new\n" });
  s.moveMain({ "page.html": "page v2\n", "store.mjs": "store v2\n" });
  s.moveMain({ "other.md": "other v2\n" }, "main moves again");
  const r = s.ready();
  assert.match(r.line, /signal written/);
  assert.deepEqual(staleFiles((a) => { try { return s.g(a).trim(); } catch (e) { return { error: String(e.message) }; } }), []);
});

test("the same change on both sides is no revert; a different one is", () => {
  const s = scratch();
  s.branch();
  work(s)({ "page.html": "page v2: the same words\n", "store.mjs": "store v1 + mine\n" });
  s.moveMain({ "page.html": "page v2: the same words\n", "store.mjs": "store v2 + theirs\n" });
  assert.throws(() => s.ready(), (e) => /to 1 file this branch also changes/.test(e.message) && /: store\.mjs\./.test(e.message) && !/page\.html/.test(e.message));
});

test("a deleted file counts both ways: the branch deletes one main changed, and main deletes one the branch changed", () => {
  const s = scratch();
  s.branch();
  s.g(["rm", "-q", "page.html"]); s.commit("Drop the page\n\nBoard-Id: card-x", { "notes.md": "notes v1 + mine\n" });
  s.moveMain({ "page.html": "page v2: main added Pull out\n", "notes.md": null });
  assert.throws(() => s.ready(), (e) => /to 2 files/.test(e.message) && /notes\.md, page\.html/.test(e.message));
});

test("a rename counts as a path gone and a path added: a branch that renames a file main changed is refused for the old path", () => {
  const s = scratch();
  s.branch();
  s.g(["mv", "page.html", "site.html"]); s.commit("Rename the page\n\nBoard-Id: card-x");
  s.moveMain({ "page.html": "page v2: main added Pull out\n" });
  assert.throws(() => s.ready(), (e) => /to 1 file this branch also changes/.test(e.message) && /: page\.html\./.test(e.message));
});

test("a mode change is a difference too: the same words on both sides, but main took the exec bit off and the branch kept it", () => {
  const s = scratch();
  s.branch();
  work(s)({ "tool.sh": "echo b\n" });
  s.moveMain({ "tool.sh": "echo b\n" }, "main edits the script and drops its exec bit", { notExec: ["tool.sh"] });
  assert.throws(() => s.ready(), (e) => /to 1 file this branch also changes/.test(e.message) && /: tool\.sh\./.test(e.message));
  // The same words and the same mode on both sides: no difference.
  const s2 = scratch();
  s2.branch();
  s2.commit("Edit script\n\nBoard-Id: card-x", { "tool.sh": "echo b\n" });
  s2.moveMain({ "tool.sh": "echo b\n" }, "main makes the same edit");
  assert.match(s2.ready().line, /signal written/);
});

test("the list is capped at 20 names and says how many more", () => {
  const s = scratch();
  s.branch();
  const mine = {}, theirs = {};
  for (let n = 0; n < 25; n++) { mine[`f${String(n).padStart(2, "0")}.md`] = `mine ${n}\n`; theirs[`f${String(n).padStart(2, "0")}.md`] = `theirs ${n}\n`; }
  // The files exist on main already, so the branch changes them and main changes them after.
  s.g(["checkout", "-q", "main"]); s.commit("add the files", Object.fromEntries(Object.keys(mine).map((f) => [f, "base\n"]))); s.g(["push", "-q", "origin", "main"]);
  s.g(["checkout", "-q", "build/card-x"]); s.g(["rebase", "-q", "main"]);
  work(s)(mine);
  s.moveMain(theirs);
  assert.equal(STALE_LISTED, 20);
  assert.throws(() => s.ready(), (e) => /to 25 files/.test(e.message) && /f19\.md and 5 more\. Rebase/.test(e.message) && !/f20\.md/.test(e.message));
});

test("with no origin/main to compare against, or no common base, nothing is judged", () => {
  const none = (a) => (a[0] === "fetch" ? { error: "no such remote ref" } : a[0] === "rev-parse" ? { error: "no such ref" } : assert.fail(`not reached: ${a[0]}`));
  assert.deepEqual(staleFiles(none), []);
  const noBase = (a) => (a[0] === "fetch" ? "" : a[0] === "rev-parse" ? "a".repeat(40) : a[0] === "merge-base" ? { error: "no merge base" } : assert.fail(`not reached: ${a[0]}`));
  assert.deepEqual(staleFiles(noBase), []);
  // A repository whose remote has no main at all: READY works as before.
  const dir = mkdtempSync(join(tmpdir(), "fb-nomain-")), work = join(dir, "work"), bare = join(dir, "origin.git");
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", "--bare", bare]); execFileSync("git", ["init", "-q", "-b", "build/lonely", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "a.md"), "a\n"); g(["add", "-A"]); g(["commit", "-qm", "Work\n\nBoard-Id: card-z"]);
  assert.match(stackReady({ run: g, queue: null, now: () => NOW }).line, /signal written/);
  rmSync(dir, { recursive: true, force: true });
});
