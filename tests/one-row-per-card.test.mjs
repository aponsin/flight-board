// #C886 (the owner, 2026-11-10 10:02 pm: 15 blue tiles while every agent was idle): a card draws one row. Once one branch of the card is on main, the card is
// that branch alone; before that, of the versions of a branch only the newest pushed one is a row. Branches of different names stay rows (#C621).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cardState, branchFamily } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";

const T = Date.now() - 1234;
const cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
const state = (card) => ({ v: 1, board: { boardId: "TestBoard01", at: T, probe: null, pageVersion: null }, agents: {}, cards: { "a-card": card } });

// One commit per branch name, each cut from the same base. `at` is the push time the tips carry (newest first is the probe's order).
function scratch(names) {
  const dir = mkdtempSync(join(tmpdir(), "fb-one-row-")), git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "-b", "main"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["commit", "-q", "--allow-empty", "-m", "base"]);
  const msg = (n) => `${n}\n\nBoard-Id: a-card`;
  const sha = {};
  names.forEach((name, i) => {
    git(["switch", "-q", "main"]); git(["switch", "-q", "-c", name]); git(["commit", "-q", "--allow-empty", "-m", msg(name)]);
    sha[name] = git(["rev-parse", "HEAD"]).trim();
    git(["update-ref", `refs/remotes/origin/${name}`, sha[name]]);
  });
  git(["switch", "-q", "main"]); git(["update-ref", "refs/remotes/origin/main", "main"]);
  const tips = (extra = []) => [...names.map((name, i) => ({ branch: name, sha: sha[name], at: T - (names.length - 1 - i) * 5000, message: msg(name) })), ...extra, { branch: "main", sha: "x", at: T, message: "" }];
  const repo = (extra = {}) => ({ git, remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips: tips(), live: null, versionPattern: null, ...extra });
  return { git, sha, repo };
}
const card = { id: "a-card", num: 886, level: "Full", phase: "plan" };

test("the branch family: the whole branch name without a -v<N> suffix; twins on another path are not versions", () => {
  assert.equal(branchFamily("build/stacks-json-product-row-v5"), "build/stacks-json-product-row");
  assert.equal(branchFamily("build/stacks-json-product-row"), "build/stacks-json-product-row");
  assert.equal(branchFamily("admin/Stacks-JSON-v2"), "admin/stacks-json");
  assert.notEqual(branchFamily("build/route"), branchFamily("build/picker"));
  assert.notEqual(branchFamily("build/picker"), branchFamily("admin/picker"), "twins stay two rows (#C621)");
  assert.equal(branchFamily("build/thing-2"), "build/thing-2", "only -v<N> is a version");
});

test("a card with v1 unsigned and v3 on main draws one row, at v3's phase", () => {
  const { git, sha, repo } = scratch(["build/a-card", "build/a-card-v2", "build/a-card-v3"]);
  git(["update-ref", "refs/remotes/origin/main", sha["build/a-card-v3"]]); // v3 landed
  const s = cardState(card, repo(), cfg, T);
  assert.equal(Object.hasOwn(s, "branches"), false, "one row, no branches list");
  assert.equal(s.headSha12, sha["build/a-card-v3"].slice(0, 12));
  assert.equal(s.onMain, true);
  assert.equal(s.phase, "ship", "v3 is on main and not deployed");
  assert.deepEqual(stateErrors(state(s)), []);
});

test("the landed branch wins even when it is not the newest push; a signed old version's phase is not the card's", () => {
  const { git, sha, repo } = scratch(["build/a-card", "build/a-card-v2"]);
  git(["notes", "--ref=refs/notes/checker", "add", "-m", "PASS", sha["build/a-card-v2"]]);
  git(["update-ref", "refs/remotes/origin/main", sha["build/a-card"]]); // the OLD one landed (squashed in), v2 is newer and unlanded
  const s = cardState(card, repo(), cfg, T);
  assert.equal(Object.hasOwn(s, "branches"), false);
  assert.equal(s.headSha12, sha["build/a-card"].slice(0, 12), "the card is the landed branch, not the newer v2");
  assert.equal(s.onMain, true);
  assert.deepEqual(s.signed, [], "v2's sign-off is not read onto the landed row");
});

test("before anything lands only the newest version is a row, at its own phase", () => {
  const { git, sha, repo } = scratch(["build/a-card", "build/a-card-v2", "build/a-card-v3"]);
  git(["notes", "--ref=refs/notes/checker", "add", "-m", "PASS", sha["build/a-card"]]); // v1 was signed and frozen at security
  const s = cardState(card, repo(), cfg, T);
  assert.equal(Object.hasOwn(s, "branches"), false, "three versions, one row");
  assert.equal(s.headSha12, sha["build/a-card-v3"].slice(0, 12));
  assert.deepEqual(s.signed, [], "the old version's sign-off does not light the newest row");
  assert.equal(s.phase, "checker", "v3 waits at the checker with nothing signed (or at build while it is a bare commit)");
});

test("branches of different names are still rows of their own, one per family, newest version of each", () => {
  const { sha, repo } = scratch(["build/route", "build/route-v2", "build/picker"]);
  const s = cardState(card, repo(), cfg, T);
  assert.deepEqual(s.branches.map((b) => b.name), ["picker", "route-v2"], "newest first; route's v1 is superseded");
  assert.equal(s.headSha12, sha["build/picker"].slice(0, 12));
  assert.deepEqual(stateErrors(state(s)), []);
});

test("a card with one branch, or a branch already alone, is read as before", () => {
  const { sha, repo } = scratch(["build/a-card"]);
  const s = cardState(card, repo(), cfg, T);
  assert.equal(Object.hasOwn(s, "branches"), false);
  assert.equal(s.headSha12, sha["build/a-card"].slice(0, 12));
});
