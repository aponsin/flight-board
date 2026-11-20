// #C1318: after a landing, the land job removes each landed card's folder (a worktree of the repository) with plain `git worktree remove`,
// never --force, and only when that folder's HEAD is on origin/main. A refusal prints its reason and one ready line for the owner and never throws.
// These tests run real git in a temporary repository.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanLandedFolders, landedFolders, parseWorktrees } from "../scripts/board-land.mjs";

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
// the same read the job makes: the folder's ignored entries from `git status --ignored`
const ignoredIn = (p) => run(p, "status", "--ignored", "--porcelain").split("\n").filter((l) => l.startsWith("!! ")).map((l) => l.slice(3));
const go = (fx, landed, extra = {}) => {
  const lines = [];
  const out = landedFolders({ landed, worktrees: parseWorktrees(run(fx.repo, "worktree", "list", "--porcelain")), repo: fx.repo, log: (s) => lines.push(s),
    onMain: (sha) => { try { run(fx.repo, "merge-base", "--is-ancestor", sha, "main"); return true; } catch { return false; } },
    remove: (p) => run(fx.repo, "worktree", "remove", p), ignored: ignoredIn, ...extra });
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

// Checker 2: git worktree remove deletes gitignored files silently, so a folder with one (a token file) is kept; a dependency folder alone is let go.
test("a folder holding an ignored file is kept and says which, while one with only node_modules is removed", () => {
  const fx = fixture();
  writeFileSync(join(fx.repo, ".gitignore"), "*token*\nnode_modules/\n");
  run(fx.repo, "add", ".gitignore"); run(fx.repo, "commit", "-q", "-m", "ignore");
  const keeper = folder(fx, "build/card-six");
  writeFileSync(join(keeper, "my-token.txt"), "secret");
  const deps = folder(fx, "build/card-seven");
  mkdirSync(join(deps, "node_modules"));
  writeFileSync(join(deps, "node_modules", "x.js"), "x");
  const { out, lines } = go(fx, [{ branch: "build/card-six", cards: ["card-six"] }, { branch: "build/card-seven", cards: ["card-seven"] }]);
  assert.equal(existsSync(keeper), true, "the folder with the token file stays");
  assert.deepEqual(out.removed, [deps]);
  assert.match(lines.join("\n"), /folder kept .*ignored file git would delete without asking \(my-token\.txt\)/);
  assert.equal(out.kept.length, 1);
  assert.equal(go(fx, [], {}).out.removed.length, 0);
});

// #C1328 (Checker 2's LOW on 7fef3cb7): landedFolders had a default `ignored = () => []`, which fails open (a caller without the hook-up deletes token files), and the job's own
// wiring of it was never run by a test (the tests above pass their own copy of the read). No default now; the wiring is cleanLandedFolders, run here on a real repository.
test("landedFolders without ignored(path) throws and removes nothing (it does not fail open)", () => {
  const fx = fixture();
  writeFileSync(join(fx.repo, ".gitignore"), "*token*\n");
  run(fx.repo, "add", ".gitignore"); run(fx.repo, "commit", "-q", "-m", "ignore");
  const dir = folder(fx, "build/card-nine");
  writeFileSync(join(dir, "my-token.txt"), "secret");
  let removed = 0;
  assert.throws(() => landedFolders({ landed: [{ branch: "build/card-nine", cards: ["card-nine"] }], worktrees: parseWorktrees(run(fx.repo, "worktree", "list", "--porcelain")), repo: fx.repo, onMain: () => true, remove: () => { removed++; } }), /needs ignored/);
  assert.equal(removed, 0);
  assert.equal(existsSync(join(dir, "my-token.txt")), true);
});

test("the job's own wiring (cleanLandedFolders) keeps a folder holding a token file and removes a clean one, with the real ignored read", () => {
  const fx = fixture();
  writeFileSync(join(fx.repo, ".gitignore"), "*token*\nnode_modules/\n");
  run(fx.repo, "add", ".gitignore"); run(fx.repo, "commit", "-q", "-m", "ignore");
  const keeper = folder(fx, "build/card-ten");
  writeFileSync(join(keeper, "my-token.txt"), "secret");
  const clean = folder(fx, "build/card-eleven");
  const lines = [];
  const out = cleanLandedFolders({
    landed: [{ branch: "build/card-ten", cards: ["card-ten"] }, { branch: "build/card-eleven", cards: ["card-eleven"] }], repo: fx.repo, cwd: null, log: (s) => lines.push(s), mainRef: "main",
    git: (a) => run(fx.repo, ...a), quiet: (a) => { try { return run(fx.repo, ...a); } catch { return null; } },
  });
  assert.equal(existsSync(keeper), true, "the token file's folder stays");
  assert.equal(existsSync(join(keeper, "my-token.txt")), true);
  assert.equal(existsSync(clean), false, "the clean folder goes");
  assert.deepEqual(out.removed, [clean]);
  assert.match(lines.join("\n"), /ignored file git would delete without asking \(my-token\.txt\)/);
  assert.doesNotMatch(lines.join("\n"), /folders not cleaned/);
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
