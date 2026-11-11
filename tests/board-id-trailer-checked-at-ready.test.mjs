// #C896: the pre-push hook checks each build/ branch's Board-Id trailers the way the landing does, so a READY never fails on
// its trailer at landing (#C883 v2: a Board-Id in its own paragraph, cut from Co-Authored-By by a blank line). Real git.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { missingTrailers } from "../scripts/trailer-check.mjs";

const SAME_BLOCK = "Do a thing (#C1)\n\nBody.\n\nBoard-Id: some-card\nCo-Authored-By: T <t@example.com>\n";
const OWN_PARAGRAPH = "Do a thing (#C1)\n\nBody.\n\nBoard-Id: some-card\n\nCo-Authored-By: T <t@example.com>\n";
const NONE = "Do a thing (#C1)\n\nCo-Authored-By: T <t@example.com>\n";

const ID = ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
function repoWithInput() {
  const dir = mkdtempSync(join(tmpdir(), "fb-c896-"));
  const bare = join(dir, "origin.git"), work = join(dir, "work");
  const g = (...a) => execFileSync("git", [...ID, ...a], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g("remote", "add", "origin", bare);
  let n = 0;
  // The message goes in through stdin (commit -F -), whole, blank lines and all.
  const commit = (msg) => {
    writeFileSync(join(work, "f"), String(n++));
    g("add", "-A");
    execFileSync("git", [...ID, "commit", "-q", "-F", "-"], { cwd: work, input: msg });
    return g("rev-parse", "HEAD").trim();
  };
  return { g, work, commit, git: (args) => g(...args) };
}
const line = (sha, ref = "refs/heads/build/x", remote = "0".repeat(40)) => `${ref} ${sha} ${ref} ${remote}\n`;

test("a Board-Id in its own paragraph is refused; so is a commit with none; every commit off main is read", () => {
  const { g, commit, git } = repoWithInput();
  commit("base\n");
  g("push", "-q", "origin", "main");
  g("switch", "-q", "-c", "build/x");
  const own = commit(OWN_PARAGRAPH);
  const good = commit(SAME_BLOCK);
  const none = commit(NONE);
  const bad = missingTrailers(line(none), git, "origin").map((b) => b.sha).sort();
  assert.deepEqual(bad, [own, none].sort(), "the good one in between passes");
  assert.ok(!bad.includes(good));
});

test("Still allowed: a trailer in the same block as Co-Authored-By; main, other branches and deleted refs are not checked", () => {
  const { g, commit, git } = repoWithInput();
  const base = commit("base without a trailer\n");
  g("push", "-q", "origin", "main");
  g("switch", "-q", "-c", "build/y");
  const good = commit(SAME_BLOCK);
  assert.deepEqual(missingTrailers(line(good, "refs/heads/build/y"), git, "origin"), [], "the base on origin/main is not judged");
  g("switch", "-q", "main");
  const onMain = commit(NONE);
  assert.deepEqual(missingTrailers(line(onMain, "refs/heads/main"), git, "origin"), [], "main is the landing's, not this check's");
  assert.deepEqual(missingTrailers(line(onMain, "refs/heads/notes-x"), git, "origin"), [], "a branch that is not build/");
  assert.deepEqual(missingTrailers(`refs/heads/build/z ${"0".repeat(40)} refs/heads/build/z ${base}\n`, git, "origin"), [], "a deleted ref");
});

test("the hook runs the scan, then this check, on the same refs", () => {
  const hook = readFileSync(new URL("../.githooks/pre-push", import.meta.url), "utf8");
  assert.match(hook, /refs=\$\(cat\)/);
  assert.match(hook, /printf '%s\\n' "\$refs" \| node scripts\/scan\.mjs --pre-push "\$1" \|\| exit 1/);
  assert.match(hook, /printf '%s\\n' "\$refs" \| node scripts\/trailer-check\.mjs "\$1" \|\| exit 1/);
});

test("the script refuses with exit 1 and says where the trailer goes", () => {
  const { g, commit, work } = repoWithInput();
  commit("base\n");
  g("push", "-q", "origin", "main");
  g("switch", "-q", "-c", "build/w");
  const own = commit(OWN_PARAGRAPH);
  const r = spawnSync(process.execPath, [new URL("../scripts/trailer-check.mjs", import.meta.url).pathname, "origin"], { cwd: work, input: line(own, "refs/heads/build/w"), encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`${own.slice(0, 12)} on build/w: no Board-Id trailer`));
  assert.match(r.stderr, /same block as Co-Authored-By/);
});
