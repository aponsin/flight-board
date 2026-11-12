// #C1026: the release tool carries a signed commit's PASS and SECURE to its plain re-cut onto a newer main, on facts it reads itself, for tests/, docs/,
// CHANGELOG.d/ and page/ only. Each refusal below has a test; the lists are fixed in code and tested. Every case builds a temporary repository: a base, the
// signed original o on a build ref, a landing on main, and c, the cherry-pick of o onto it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { carryPathRefusal, carryFrom, carryCheck, gatherCarry, parseChanges, verdict, CARRY_ALLOW, CARRY_NEVER_ROOTS } from "../scripts/board-release.mjs";

const ID = "some-card";
const MSG = `the change\n\nBoard-Id: ${ID}\nCo-Authored-By: Test`;
const LINES = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";

function world() {
  const dir = mkdtempSync(join(tmpdir(), "carry-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\n+$/, "");
  const quiet = (a) => { try { return git(...a); } catch { return null; } };
  git("init", "-q", "-b", "main"); git("config", "user.email", "none"); git("config", "user.name", "t");
  const put = (f, t) => { mkdirSync(join(dir, dirname(f)), { recursive: true }); writeFileSync(join(dir, f), t); };
  const commit = (msg) => { git("add", "-A"); git("commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };
  for (const f of ["tests/keep.txt", "tests/lines.txt", "docs/d.md", "page/p.html", "page/q.html", "worker/w.mjs", "scripts/s.mjs", "collector/c.mjs", "README.md"]) put(f, f === "tests/lines.txt" ? LINES : `${f}\n`);
  put("package.json", "{}\n"); put("wrangler.toml", "x\n");
  commit("base");
  const base = git("rev-parse", "HEAD");
  const sign = (sha, checker = "PASS ok", security = "SECURE ok") => {
    if (checker) git("notes", "--ref=board-release/checker", "add", "-f", "-m", checker, sha);
    if (security) git("notes", "--ref=board-release/security", "add", "-f", "-m", security, sha);
  };
  // o: built on base by `edit()`, signed; a landing `land()` on main; c: o cherry-picked onto the landing.
  function build({ edit, land = () => put("README.md", "landing\n"), signOriginal = true, message = MSG, recut = (o) => { git("cherry-pick", o); } }) {
    git("checkout", "-q", "-b", "card", base); edit(); const o = commit(message);
    git("update-ref", "refs/remotes/origin/build/some-card", o);
    git("checkout", "-q", "main"); land(); const main = commit(`landing\n\nBoard-Id: other`);
    git("checkout", "-q", "-b", "recut", main); recut(o); const c = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/build/some-card-v2", c);
    if (signOriginal) sign(o);
    const facts = (owned = []) => gatherCarry({ quiet, sha: c, main, owned, noteRef: (w) => `board-release/${w}` });
    return { o, c, main, facts, run: (owned) => carryFrom({ c, main, facts: facts(owned) }) };
  }
  return { dir, git, quiet, put, commit, sign, build, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const refusal = (r, re) => assert.ok(r.refusals?.some((x) => re.test(x)), `expected a refusal matching ${re}, got ${JSON.stringify(r.refusals ?? r.lines)}`);

test("a plain re-cut of a signed tests/docs commit carries the original's notes, prints o's full sha, both note lines, the paths and the range, and writes no note", () => {
  const w = world();
  try {
    const x = w.build({ edit: () => { w.put("tests/new.test.mjs", "t\n"); w.put("docs/d.md", "doc\n"); } });
    const r = x.run();
    assert.equal(r.from, x.o);
    assert.match(r.lines[0], new RegExp(`^carried: ${x.o} \\(Checker "PASS ok", Security "SECURE ok"\\) paths: docs/d\\.md, tests/new\\.test\\.mjs landings: [0-9a-f]{12}\\.\\.[0-9a-f]{12}$`));
    assert.equal(r.lines[1], "carried: self-deploy will refuse until signed");
    assert.equal(w.quiet(["notes", "--ref=board-release/checker", "show", x.c]), null, "no note is written for the carried commit");
    assert.equal(w.quiet(["notes", "--ref=board-release/security", "show", x.c]), null);
  } finally { w.cleanup(); }
});

test("a deleted tests file is carried; deleting or renaming into a forbidden folder is not (a rename is a delete plus an add)", () => {
  const w = world();
  try {
    assert.ok(w.build({ edit: () => { rmSync(join(w.dir, "tests/keep.txt")); } }).run().from);
  } finally { w.cleanup(); }
  const v = world();
  try { refusal(v.build({ edit: () => { rmSync(join(v.dir, "scripts/s.mjs")); } }).run(), /scripts\/s\.mjs: scripts\/ is never carried/); } finally { v.cleanup(); }
  const m = world();
  try { refusal(m.build({ edit: () => { m.git("mv", "tests/keep.txt", "scripts/k.txt"); } }).run(), /scripts\/k\.txt: scripts\/ is never carried/); } finally { m.cleanup(); }
});

test("the allow list and the never list are fixed in code, one test per entry", () => {
  assert.deepEqual(CARRY_ALLOW, ["tests/", "docs/", "CHANGELOG.d/", "page/"]);
  assert.deepEqual(CARRY_NEVER_ROOTS, ["worker", "hooks", "gate", "collector", "keeper", "scripts", ".github"]);
  for (const p of ["tests/a.test.mjs", "tests/sub/b.mjs", "docs/x.md", "CHANGELOG.d/card.md", "page/board.template.html"]) assert.equal(carryPathRefusal(p, ["100644", "100644"]), null, p);
  for (const root of CARRY_NEVER_ROOTS) assert.match(carryPathRefusal(`${root}/x.mjs`, ["100644"]) ?? "", /never carried|dotfile/, root);
  for (const p of ["wrangler.toml", "wrangler.board.toml", "package.json", "package-lock.json", "page/package.json", "tests/wrangler.toml"]) assert.match(carryPathRefusal(p, ["100644"]) ?? "", /never carried|outside/, p);
  for (const p of ["README.md", "CHANGELOG.md", "testsx/a", "docs", "tests", "Page/p.html", "src/x.mjs"]) assert.match(carryPathRefusal(p, ["100644"]) ?? "", /outside/, p);
  for (const p of [".gitignore", "tests/.hidden", "docs/.x/y.md", ".github/workflows/a.yml", "tests/../worker/w.mjs", "/tests/a", "tests//a"]) assert.ok(carryPathRefusal(p, ["100644"]), p);
  assert.match(carryPathRefusal("tests/l", ["000000", "120000"]), /symbolic link or a submodule/);
  assert.match(carryPathRefusal("tests/m", ["160000"]), /symbolic link or a submodule/);
});

test("each forbidden folder refuses a real re-cut (worker, collector, scripts, package.json, wrangler.toml, a dotfile under tests)", () => {
  for (const [file, re] of [["worker/w.mjs", /worker\/ is never carried/], ["collector/c.mjs", /collector\/ is never carried/], ["scripts/s.mjs", /scripts\/ is never carried/], ["package.json", /package\.json is never carried/], ["wrangler.toml", /wrangler\.toml is never carried/], ["tests/.hidden", /dotfile/]]) {
    const w = world();
    try { refusal(w.build({ edit: () => w.put(file, "changed\n") }).run(), re); } finally { w.cleanup(); }
  }
});

test("a symbolic link is never carried", () => {
  const w = world();
  try { refusal(w.build({ edit: () => { symlinkSync("../README.md", join(w.dir, "tests/link")); } }).run(), /symbolic link or a submodule/); } finally { w.cleanup(); }
});

test("a message or trailer that differs refuses", () => {
  const w = world();
  try {
    const x = w.build({ edit: () => w.put("tests/new.test.mjs", "t\n"), recut: (o) => { w.git("cherry-pick", o); w.git("commit", "-q", "--amend", "-m", `${MSG}\nExtra: yes`); } });
    refusal(x.run(), /full message/);
  } finally { w.cleanup(); }
  const v = world();
  try {
    const x = v.build({ edit: () => v.put("tests/new.test.mjs", "t\n"), recut: (o) => { v.git("cherry-pick", o); v.git("commit", "-q", "--amend", "-m", MSG.replace("Board-Id: some-card", "Board-Id: other-card")); } });
    refusal(x.run(), /no other commit of this card/); // the card id is c's own now: the original is no sibling of it
  } finally { v.cleanup(); }
});

test("a different blob, an extra path or a changed mode refuses", () => {
  const w = world();
  try { refusal(w.build({ edit: () => w.put("tests/new.test.mjs", "t\n"), recut: (o) => { w.git("cherry-pick", o); w.put("tests/new.test.mjs", "tampered\n"); w.git("commit", "-q", "-a", "--amend", "--no-edit"); } }).run(), /changed paths, modes or blobs differ/); } finally { w.cleanup(); }
  const v = world();
  try { refusal(v.build({ edit: () => v.put("tests/new.test.mjs", "t\n"), recut: (o) => { v.git("cherry-pick", o); v.put("tests/extra.txt", "e\n"); v.git("add", "-A"); v.git("commit", "-q", "--amend", "--no-edit"); } }).run(), /changed paths, modes or blobs differ/); } finally { v.cleanup(); }
  const m = world();
  try { refusal(m.build({ edit: () => m.put("tests/new.test.mjs", "t\n"), recut: (o) => { m.git("cherry-pick", o); execFileSync("chmod", ["+x", join(m.dir, "tests/new.test.mjs")]); m.git("add", "-A"); m.git("commit", "-q", "--amend", "--no-edit"); } }).run(), /changed paths, modes or blobs differ/); } finally { m.cleanup(); }
});

test("a merge commit, or a commit not directly on main, refuses", () => {
  const w = world();
  try { refusal(w.build({ edit: () => w.put("tests/new.test.mjs", "t\n"), recut: (o) => { w.git("merge", "-q", "--no-ff", "-m", MSG, o); } }).run(), /one parent/); } finally { w.cleanup(); }
  const v = world();
  try { refusal(v.build({ edit: () => v.put("tests/new.test.mjs", "t\n"), recut: (o) => { v.put("docs/d.md", "another\n"); v.commit("in between"); v.git("cherry-pick", o); } }).run(), /not directly on origin\/main/); } finally { v.cleanup(); }
});

test("a path the landings touched refuses (the landing changed another hunk of the same file)", () => {
  const w = world();
  try {
    const x = w.build({
      edit: () => w.put("tests/lines.txt", LINES.replace("line 1\n", "line one\n")),
      land: () => w.put("tests/lines.txt", LINES.replace("line 28\n", "line twenty-eight\n")),
    });
    const r = x.run();
    refusal(r, /changed paths, modes or blobs differ|differs between the parents/);
    assert.ok(carryCheck({ c: x.c, o: x.o, main: x.main, facts: x.facts() }).some((s) => /tests\/lines\.txt differs between the parents/.test(s)));
  } finally { w.cleanup(); }
});

test("page/ is carried only when the landings touched nothing under page/ or worker/", () => {
  const ok = world();
  try { assert.ok(ok.build({ edit: () => ok.put("page/p.html", "mine\n"), land: () => ok.put("docs/d.md", "landing\n") }).run().from, "a docs landing leaves page/ alone"); } finally { ok.cleanup(); }
  const w = world();
  try { refusal(w.build({ edit: () => w.put("page/p.html", "mine\n"), land: () => w.put("worker/w.mjs", "landing\n") }).run(), /page\/ is carried only when the landings.*worker\/w\.mjs/); } finally { w.cleanup(); }
  const p = world();
  try { refusal(p.build({ edit: () => p.put("page/p.html", "mine\n"), land: () => p.put("page/q.html", "landing\n") }).run(), /page\/ is carried only when the landings.*page\/q\.html/); } finally { p.cleanup(); }
  const t = world();
  try { assert.ok(t.build({ edit: () => t.put("tests/new.test.mjs", "t\n"), land: () => t.put("worker/w.mjs", "landing\n") }).run().from, "a worker landing does not stop a tests-only commit"); } finally { t.cleanup(); }
});

test("a commit with the same Board-Id on any origin build ref whose note is FINDINGS, STOP, RISKS or withdrawn refuses", () => {
  for (const [role, text] of [["checker", "FINDINGS one"], ["checker", "withdrawn"], ["security", "STOP"], ["security", "RISKS two"]]) {
    const w = world();
    try {
      const x = w.build({ edit: () => w.put("tests/new.test.mjs", "t\n") });
      // another commit of the same card, on another build ref, with the bad note
      w.git("checkout", "-q", "-b", "other", x.main); w.put("tests/other.txt", "o\n");
      const s = w.commit(MSG); w.git("update-ref", "refs/remotes/origin/build/some-card-v3", s);
      w.git("notes", `--ref=board-release/${role}`, "add", "-f", "-m", text, s);
      refusal(x.run(), new RegExp(`${role === "checker" ? "Checker" : "Security"} note that is not ${role === "checker" ? "PASS" : "SECURE"}`));
    } finally { w.cleanup(); }
  }
  // the original itself with FINDINGS holds no real sign
  const w = world();
  try {
    const x = w.build({ edit: () => w.put("tests/new.test.mjs", "t\n"), signOriginal: false });
    w.sign(x.o, "FINDINGS", "SECURE ok");
    refusal(x.run(), /does not hold both PASS and SECURE|not PASS/);
  } finally { w.cleanup(); }
});

test("an original without both real notes carries nothing (a carried commit holds no note, so there is no chain), and with no sibling at all there is nothing to carry from", () => {
  const w = world();
  try {
    const x = w.build({ edit: () => w.put("tests/new.test.mjs", "t\n"), signOriginal: false });
    refusal(x.run(), /does not hold both PASS and SECURE/);
    w.sign(x.o, "PASS ok", null);
    refusal(x.run(), /does not hold both PASS and SECURE/);
  } finally { w.cleanup(); }
  const v = world();
  try {
    const x = v.build({ edit: () => v.put("tests/new.test.mjs", "t\n") });
    v.git("update-ref", "-d", "refs/remotes/origin/build/some-card");
    refusal(x.run(), /no other commit of this card/);
  } finally { v.cleanup(); }
});

test("carryCheck itself wants a real PASS and SECURE on the original (it does not lean on its caller)", () => {
  const w = world();
  try {
    const x = w.build({ edit: () => w.put("tests/new.test.mjs", "t\n") });
    const f = x.facts();
    assert.deepEqual(carryCheck({ c: x.c, o: x.o, main: x.main, facts: f }), []);
    const asked = (o) => carryCheck({ c: x.c, o: x.o, main: x.main, facts: { ...f, notes: (s) => (s === x.o ? o : f.notes(s)), siblings: [] } });
    assert.ok(asked({ checker: "FINDINGS", security: "SECURE ok" }).some((s) => /no PASS from Checker/.test(s)));
    assert.ok(asked({ checker: "PASS ok", security: "STOP" }).some((s) => /no SECURE from Security/.test(s)));
    assert.ok(asked({}).length === 2);
  } finally { w.cleanup(); }
});

test("a commit of the same card that is already on main does not block a carry (only the card's commits outside main are read)", () => {
  const w = world();
  try {
    const x = w.build({
      edit: () => w.put("tests/new.test.mjs", "t\n"),
      land: () => {
        w.put("docs/older.md", "x\n"); const s = w.commit(MSG);
        w.git("notes", "--ref=board-release/checker", "add", "-f", "-m", "FINDINGS fixed by a later commit", s);
        w.git("update-ref", "refs/remotes/origin/build/some-card-v0", s);
        w.put("README.md", "landing\n");
      },
    });
    assert.ok(x.run().from);
  } finally { w.cleanup(); }
});

test("a path in the owner's closure refuses", () => {
  const w = world();
  try { refusal(w.build({ edit: () => w.put("tests/new.test.mjs", "t\n") }).run(["tests/new.test.mjs"]), /in the owner's closure/); } finally { w.cleanup(); }
});

test("no Board-Id trailer naming a card: no facts", () => {
  const w = world();
  try {
    const x = w.build({ edit: () => w.put("tests/new.test.mjs", "t\n"), message: "no trailer here", recut: (o) => { w.git("cherry-pick", o); } });
    assert.equal(x.facts(), null);
  } finally { w.cleanup(); }
});

test("the verdict refuses a carried commit when the suite on it is not green, and says nothing when nothing was carried", () => {
  const base = { forward: true, notes: { checker: "PASS ok", security: "SECURE ok" }, pinned: "a".repeat(40), changed: [], owned: [], capabilities: [], mcpErrors: [] };
  assert.equal(verdict({ ...base, carrySuite: null }).ok, true);
  assert.equal(verdict({ ...base, carrySuite: "" }).ok, true);
  const r = verdict({ ...base, carrySuite: "exit 1, not ok 3 - x" });
  assert.equal(r.ok, false); assert.match(r.refusals[0], /carries a sign-off.*not green: exit 1/);
});

test("parseChanges reads status, path, modes and the new blob", () => {
  assert.deepEqual(parseChanges(":100644 100755 aaaaaaa bbbbbbb M\ttests/x\n:000000 100644 0000000 ccccccc A\tdocs/y"), [
    { status: "M", path: "tests/x", src: "100644", dst: "100755", blob: "bbbbbbb" }, { status: "A", path: "docs/y", src: "000000", dst: "100644", blob: "ccccccc" }]);
});
