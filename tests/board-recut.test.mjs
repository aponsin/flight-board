// #C906: scripts/board-recut.mjs re-cuts a signed build/<card>[-vN] tip that no longer continues main, by a plain cherry-pick onto origin/main, only when
// the landings since its base touched none of the tip's files and every copy carries the same message, paths, modes and blobs. It pushes build/<card>-v(N+1)
// and never writes a note. Each test builds a bare "origin" and a working clone under the temp folder.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { recut, changeSet, newestPerCard, signed } from "../scripts/board-recut.mjs";

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\n+$/, "");
const TRAILER = (id) => `\n\nBoard-Id: ${id}\nCo-Authored-By: Test`;

function world() {
  const root = mkdtempSync(join(tmpdir(), "recut-")), origin = join(root, "origin.git"), work = join(root, "work");
  mkdirSync(origin); git(origin, "init", "-q", "--bare", "-b", "main");
  execFileSync("git", ["clone", "-q", origin, work], { stdio: "ignore" });
  git(work, "config", "user.email", "none"); git(work, "config", "user.name", "t"); git(work, "checkout", "-q", "-b", "main");
  const put = (f, text) => { mkdirSync(join(work, f, ".."), { recursive: true }); writeFileSync(join(work, f), text); };
  const commit = (msg, ...files) => { git(work, "add", "-A"); git(work, "commit", "-q", "-m", msg); return git(work, "rev-parse", "HEAD"); };
  put("a.txt", "a\n"); put("b.txt", "b\n"); commit("base");
  git(work, "push", "-q", "origin", "main");
  const base = git(work, "rev-parse", "HEAD");
  const sign = (sha, c = "PASS ok", s = "SECURE ok") => {
    git(work, "notes", "--ref=refs/notes/checker", "add", "-f", "-m", c, sha); git(work, "notes", "--ref=refs/notes/security", "add", "-f", "-m", s, sha);
    git(work, "push", "-q", "origin", "refs/notes/checker:refs/notes/checker", "refs/notes/security:refs/notes/security");
  };
  // a card branch from base with the given files, pushed; returns its tip
  const card = (branch, id, files, msgs = [`work${TRAILER(id)}`]) => {
    git(work, "checkout", "-q", "-b", `tmp-${branch.replace("/", "-")}`, base);
    let tip = base;
    msgs.forEach((m, i) => { for (const [f, t] of Object.entries(files(i))) put(f, t); tip = commit(m); });
    git(work, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    git(work, "checkout", "-q", "main");
    return tip;
  };
  const land = (f, text, msg = `landing${TRAILER("other")}`) => { git(work, "checkout", "-q", "main"); put(f, text); const s = commit(msg); git(work, "push", "-q", "origin", "main"); return s; };
  const mkWorktree = (sha) => { const d = mkdtempSync(join(root, "wt-")); git(work, "worktree", "add", "-q", "--detach", d, sha); return d; };
  const rmWorktree = (d) => { try { git(work, "worktree", "remove", "--force", d); } catch { /* gone */ } };
  const runner = (hook) => (a, o = {}) => { const r = execFileSync("git", a, { cwd: o.cwd ?? work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); hook?.(a, o); return r; };
  const heads = () => git(work, "ls-remote", "--heads", "origin", "build/*").split("\n").filter(Boolean).map((l) => l.split("\t")[1].replace("refs/heads/", ""));
  const go = (o = {}) => recut({ run: runner(o.hook), push: o.push ?? true, mkWorktree, rmWorktree });
  return { root, origin, work, put, commit, sign, card, land, heads, go, git: (...a) => git(work, ...a), remote: (...a) => git(origin, ...a), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a signed tip whose files no landing touched is re-cut onto main as -v2 with the same message, paths and blobs, and no note is written", () => {
  const w = world();
  try {
    const tip = w.card("build/one", "one", () => ({ "x.txt": "x\n" }));
    w.sign(tip);
    const main = w.land("b.txt", "b2\n");
    const r = w.go();
    assert.equal(r.results.length, 1);
    const { next, tip: nt } = r.results[0];
    assert.equal(next, "build/one-v2");
    assert.ok(w.heads().includes("build/one-v2"));
    assert.equal(w.remote("rev-parse", "refs/heads/build/one-v2"), nt);
    assert.equal(w.remote("rev-parse", `${nt}^`), main, "the copy sits directly on main");
    assert.equal(w.remote("log", "-1", "--format=%B", nt), w.remote("log", "-1", "--format=%B", tip));
    assert.equal(w.remote("rev-parse", `${nt}:x.txt`), w.remote("rev-parse", `${tip}:x.txt`));
    assert.equal(w.remote("log", "-1", "--format=%(trailers:key=Board-Id,valueonly)", nt).trim(), "one");
    assert.throws(() => w.remote("notes", "--ref=refs/notes/checker", "show", nt), "no note is written for the new tip");
    assert.throws(() => w.remote("notes", "--ref=refs/notes/security", "show", nt));
  } finally { w.cleanup(); }
});

test("a landing that touched a file the tip changed: needs a human re-cut, nothing pushed", () => {
  const w = world();
  try {
    const tip = w.card("build/one", "one", () => ({ "b.txt": "mine\n" }));
    w.sign(tip);
    w.land("b.txt", "theirs\n");
    const r = w.go();
    assert.match(r.lines[0], /needs a human re-cut \(the landings since its base touched b\.txt\)/);
    assert.deepEqual(w.heads(), ["build/one"]);
  } finally { w.cleanup(); }
});

test("a landing that changed a file and changed it back still counts as touching it", () => {
  const w = world();
  try {
    const tip = w.card("build/one", "one", () => ({ "b.txt": "mine\n" }));
    w.sign(tip);
    w.land("b.txt", "b2\n"); w.land("b.txt", "b\n");
    assert.match(w.go().lines[0], /needs a human re-cut/);
    assert.deepEqual(w.heads(), ["build/one"]);
  } finally { w.cleanup(); }
});

test("an unsigned tip, a tip with FINDINGS, and a tip with only one note are left alone", () => {
  const w = world();
  try {
    const a = w.card("build/unsigned", "unsigned", () => ({ "u.txt": "u\n" }));
    const b = w.card("build/found", "found", () => ({ "f.txt": "f\n" })); w.sign(b, "FINDINGS one", "SECURE ok");
    const c = w.card("build/half", "half", () => ({ "h.txt": "h\n" })); w.sign(c, "PASS ok", "RISKS something");
    w.land("b.txt", "b2\n");
    const r = w.go();
    assert.deepEqual(r.results, []); assert.deepEqual(r.lines, ["RECUT: nothing to re-cut"]);
    assert.deepEqual(w.heads().sort(), ["build/found", "build/half", "build/unsigned"]);
    assert.ok(a && b && c);
  } finally { w.cleanup(); }
});

test("a tip that already continues main, and a tip already on main, are left alone", () => {
  const w = world();
  try {
    const landed = w.land("z.txt", "z\n", `z${TRAILER("landed")}`);
    git(w.work, "push", "-q", "origin", `${landed}:refs/heads/build/landed`); w.sign(landed);
    git(w.work, "checkout", "-q", "-b", "cont", "main");
    w.put("y.txt", "y\n"); w.commit(`y${TRAILER("cont")}`); git(w.work, "push", "-q", "origin", "HEAD:refs/heads/build/cont");
    w.sign(git(w.work, "rev-parse", "HEAD"));
    git(w.work, "checkout", "-q", "main");
    assert.deepEqual(w.go().results, []);
  } finally { w.cleanup(); }
});

test("only the newest branch of a card is re-cut, and the next version follows the highest one on origin", () => {
  const w = world();
  try {
    const old = w.card("build/one", "one", () => ({ "x.txt": "x1\n" })); w.sign(old);
    const v2 = w.card("build/one-v2", "one", () => ({ "x.txt": "x2\n" })); w.sign(v2);
    w.land("b.txt", "b2\n");
    const r = w.go();
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].next, "build/one-v3");
    assert.deepEqual(w.heads().sort(), ["build/one", "build/one-v2", "build/one-v3"]);
    assert.deepEqual(newestPerCard([{ branch: "build/a", sha: "1".repeat(40) }, { branch: "build/a-v3", sha: "2".repeat(40) }, { branch: "build/a-v2", sha: "3".repeat(40) }, { branch: "evil", sha: "4".repeat(40) }]).map((x) => x.branch), ["build/a-v3"]);
  } finally { w.cleanup(); }
});

test("a stack of several commits is copied in order, each with its own message", () => {
  const w = world();
  try {
    const tip = w.card("build/two", "two", (i) => ({ [`s${i}.txt`]: `s${i}\n` }), [`first${TRAILER("two")}`, `second${TRAILER("two")}`]);
    w.sign(tip);
    w.land("b.txt", "b2\n");
    const r = w.go();
    const nt = r.results[0].tip;
    assert.deepEqual(w.remote("log", "--format=%s", `${nt}~2..${nt}`).split("\n"), ["second", "first"]);
    assert.equal(w.remote("rev-parse", `${nt}~2`), w.remote("rev-parse", "main"));
  } finally { w.cleanup(); }
});

test("a merge commit on the line is a human's job", () => {
  const w = world();
  try {
    git(w.work, "checkout", "-q", "-b", "side", "main"); w.put("m1.txt", "1\n"); w.commit(`m1${TRAILER("mer")}`);
    git(w.work, "checkout", "-q", "-b", "side2", "main"); w.put("m2.txt", "2\n"); w.commit(`m2${TRAILER("mer")}`);
    git(w.work, "merge", "-q", "--no-ff", "-m", `merge${TRAILER("mer")}`, "side");
    git(w.work, "push", "-q", "origin", "HEAD:refs/heads/build/mer"); w.sign(git(w.work, "rev-parse", "HEAD"));
    git(w.work, "checkout", "-q", "main"); w.land("b.txt", "b2\n");
    assert.match(w.go().lines[0], /needs a human re-cut \(a merge commit on the line\)/);
    assert.deepEqual(w.heads(), ["build/mer"]);
  } finally { w.cleanup(); }
});

test("a copy whose message differs from the original is refused and nothing is pushed (the check, not the cherry-pick, decides)", () => {
  const w = world();
  try {
    const tip = w.card("build/one", "one", () => ({ "x.txt": "x\n" })); w.sign(tip);
    w.land("b.txt", "b2\n");
    const r = w.go({ hook: (a, o) => { if (a[0] === "cherry-pick" && o.cwd) execFileSync("git", ["commit", "-q", "--amend", "-m", "changed"], { cwd: o.cwd }); } });
    assert.match(r.lines[0], /needs a human re-cut \(.* differs from its copy\)/);
    assert.deepEqual(w.heads(), ["build/one"]);
  } finally { w.cleanup(); }
});

test("a copy whose blob differs from the original is refused", () => {
  const w = world();
  try {
    const tip = w.card("build/one", "one", () => ({ "x.txt": "x\n" })); w.sign(tip);
    w.land("b.txt", "b2\n");
    const r = w.go({ hook: (a, o) => { if (a[0] === "cherry-pick" && o.cwd) { writeFileSync(join(o.cwd, "x.txt"), "tampered\n"); execFileSync("git", ["commit", "-q", "--amend", "-a", "--no-edit"], { cwd: o.cwd }); } } });
    assert.match(r.lines[0], /differs from its copy/);
    assert.deepEqual(w.heads(), ["build/one"]);
  } finally { w.cleanup(); }
});

test("a copy with an extra changed path is refused", () => {
  const w = world();
  try {
    const tip = w.card("build/one", "one", () => ({ "x.txt": "x\n" })); w.sign(tip);
    w.land("b.txt", "b2\n");
    const r = w.go({ hook: (a, o) => { if (a[0] === "cherry-pick" && o.cwd) { writeFileSync(join(o.cwd, "extra.txt"), "e\n"); execFileSync("git", ["add", "-A"], { cwd: o.cwd }); execFileSync("git", ["commit", "-q", "--amend", "--no-edit"], { cwd: o.cwd }); } } });
    assert.match(r.lines[0], /differs from its copy/);
    assert.deepEqual(w.heads(), ["build/one"]);
  } finally { w.cleanup(); }
});

test("a copy whose mode differs from the original is refused (a symbolic link where a file was)", () => {
  const w = world();
  try {
    const tip = w.card("build/one", "one", () => ({ "x.txt": "x\n" })); w.sign(tip);
    w.land("b.txt", "b2\n");
    const r = w.go({ hook: (a, o) => { if (a[0] === "cherry-pick" && o.cwd) { rmSync(join(o.cwd, "x.txt")); symlinkSync("a.txt", join(o.cwd, "x.txt")); execFileSync("git", ["add", "-A"], { cwd: o.cwd }); execFileSync("git", ["commit", "-q", "--amend", "--no-edit"], { cwd: o.cwd }); } } });
    assert.match(r.lines[0], /differs from its copy/);
    assert.deepEqual(w.heads(), ["build/one"]);
  } finally { w.cleanup(); }
});

test("--dry-run (push: false) does everything but push", () => {
  const w = world();
  try {
    const tip = w.card("build/one", "one", () => ({ "x.txt": "x\n" })); w.sign(tip);
    w.land("b.txt", "b2\n");
    const r = w.go({ push: false });
    assert.match(r.lines[0], /build\/one-v2 [0-9a-f]{40} \(dry run: not pushed\)/);
    assert.deepEqual(w.heads(), ["build/one"]);
  } finally { w.cleanup(); }
});

test("the temporary worktrees are removed, also after a refusal", () => {
  const w = world();
  try {
    const tip = w.card("build/one", "one", () => ({ "x.txt": "x\n" })); w.sign(tip);
    w.land("b.txt", "b2\n");
    w.go({ hook: (a, o) => { if (a[0] === "cherry-pick" && o.cwd) execFileSync("git", ["commit", "-q", "--amend", "-m", "changed"], { cwd: o.cwd }); } });
    assert.equal(w.git("worktree", "list").split("\n").length, 1);
  } finally { w.cleanup(); }
});

test("changeSet compares status, path, mode and blob; signed needs PASS and SECURE on first lines", () => {
  const raw = ":100644 100644 aaaaaaaa bbbbbbbb M\tf.txt\n:000000 100755 0000000 cccccccc A\tg.sh";
  assert.deepEqual(changeSet(raw), ["A\tg.sh\t100755\tcccccccc", "M\tf.txt\t100644\tbbbbbbbb"]);
  assert.notDeepEqual(changeSet(raw), changeSet(raw.replace("100755", "100644")));
  assert.equal(signed({ checker: "PASS x", security: "SECURE y" }), true);
  assert.equal(signed({ checker: "FINDINGS\nPASS", security: "SECURE y" }), false);
  assert.equal(signed({ checker: "PASS x", security: "" }), false);
});
