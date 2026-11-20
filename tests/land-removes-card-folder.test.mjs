// #C1318: after a landing, the land job removes each landed card's folder (a worktree of the repository) with plain `git worktree remove`,
// never --force, and only when that folder's HEAD is on origin/main. A refusal prints its reason and one ready line for the owner and never throws.
// These tests run real git in a temporary repository.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landedFolders, parseWorktrees } from "../scripts/board-land.mjs";

const run = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "land-folders-")));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  for (const [k, v] of [["user.email", "builder"], ["user.name", "builder"]]) run(repo, "config", k, v);
  writeFileSync(join(repo, "a.txt"), "a");
  run(repo, "add", "a.txt"); run(repo, "commit", "-q", "-m", "first");
  return { root, repo };
}
const commitIn = (dir, name) => { writeFileSync(join(dir, name), name); run(dir, "add", name); run(dir, "commit", "-q", "-m", name); };
// a folder on branch `branch`, with one commit; merged into main when `merge`
function folder({ root, repo }, branch, { merge = true, dirty = false } = {}) {
  const dir = join(root, branch.replace(/\//g, "-"));
  run(repo, "worktree", "add", "-q", "-b", branch, dir);
  commitIn(dir, `${branch.replace(/\//g, "-")}.txt`);
  if (merge) run(repo, "merge", "-q", "--ff-only", branch);
  if (dirty) writeFileSync(join(dir, "scratch.txt"), "unsaved");
  return dir;
}
const go = (fx, landed, extra = {}) => {
  const lines = [];
  const out = landedFolders({ landed, worktrees: parseWorktrees(run(fx.repo, "worktree", "list", "--porcelain")), repo: fx.repo, log: (s) => lines.push(s),
    onMain: (sha) => { try { run(fx.repo, "merge-base", "--is-ancestor", sha, "main"); return true; } catch { return false; } },
    remove: (p) => run(fx.repo, "worktree", "remove", p), ...extra });
  return { out, lines };
};

test("a merged, clean folder of a landed card is removed", () => {
  const fx = fixture();
  const dir = folder(fx, "build/card-one");
  const { out, lines } = go(fx, [{ branch: "build/card-one", cards: ["card-one"] }]);
  assert.deepEqual(out.removed, [dir]);
  assert.equal(existsSync(dir), false);
  assert.match(lines.join("\n"), /folder removed/);
});

test("a dirty folder is kept (git refuses, never --force), with the reason and one ready line", () => {
  const fx = fixture();
  const dir = folder(fx, "build/card-two", { dirty: true });
  const { out, lines } = go(fx, [{ branch: "build/card-two", cards: ["card-two"] }]);
  assert.deepEqual(out.removed, []);
  assert.equal(out.kept.length, 1);
  assert.equal(existsSync(dir), true);
  assert.match(lines.join("\n"), /folder kept .*(modified|untracked)/);
  assert.match(lines.join("\n"), /To remove it yourself: git -C .* worktree remove /);
});

test("a folder whose work is not on main is kept untouched", () => {
  const fx = fixture();
  const dir = folder(fx, "build/card-three", { merge: false });
  const { out, lines } = go(fx, [{ branch: "build/card-three", cards: ["card-three"] }]);
  assert.deepEqual(out.removed, []);
  assert.equal(existsSync(dir), true);
  assert.match(lines.join("\n"), /not on origin\/main/);
});

test("a folder of a card that did not land, the repository's own folder and a locked folder are left alone", () => {
  const fx = fixture();
  const other = folder(fx, "build/card-other");
  const locked = folder(fx, "build/card-four");
  run(fx.repo, "worktree", "lock", locked);
  const { out } = go(fx, [{ branch: "build/card-four", cards: ["card-four"] }]);
  assert.deepEqual(out.removed, []);
  assert.equal(existsSync(other), true, "not a landed card's");
  assert.equal(existsSync(fx.repo), true);
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].why, "it is locked");
});

test("a card's -vN branch matches its card, and a refusing git never throws", () => {
  const fx = fixture();
  const dir = folder(fx, "build/card-five-v2");
  const { out } = go(fx, [{ branch: "build/card-five-v3", cards: ["card-five"] }], { remove: () => { throw Object.assign(new Error("x"), { stderr: "fatal: app blocks agents\n" }); } });
  assert.deepEqual(out.removed, []);
  assert.equal(out.kept[0].why, "fatal: app blocks agents");
  assert.equal(existsSync(dir), true);
});
