// #C906: a changelog fragment CHANGELOG.d/<card id>.md is documentation like CHANGELOG.md: a landing of fragments, docs and tests needs no install
// (collector/state.mjs DOCS_ONLY) and make-pair lists it under "docs". Only a .md file directly in CHANGELOG.d/ counts; a script there, a nested path
// or any look-alike name is a change like any other.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { cardState, DOCS_ONLY } from "../collector/state.mjs";
import { groupPaths } from "../scripts/make-pair.mjs";

const T = Date.now() - 1234;
const cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
const card = { id: "a-card", num: 906, level: "Quick", phase: "plan" };

function landed(files) {
  const dir = mkdtempSync(join(tmpdir(), "fb-chlogd-")), git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "-b", "main"]); git(["config", "user.email", "none"]); git(["config", "user.name", "t"]);
  git(["commit", "-q", "--allow-empty", "-m", "base"]);
  for (const f of files) { mkdirSync(join(dir, dirname(f)), { recursive: true }); writeFileSync(join(dir, f), `${f}\n`); }
  git(["add", "-A"]);
  git(["commit", "-q", "--allow-empty", "-m", "the card\n\nBoard-Id: a-card"]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  git(["update-ref", "refs/remotes/origin/main", sha]); git(["update-ref", "refs/remotes/origin/build/a-card", sha]);
  const tips = [{ branch: "build/a-card", sha, at: T, message: "the card\n\nBoard-Id: a-card" }, { branch: "main", sha, at: T, message: "" }];
  return { repo: { git, remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips, live: null, versionPattern: null } };
}

test("DOCS_ONLY takes a .md directly in CHANGELOG.d and nothing that looks like it", () => {
  for (const p of ["CHANGELOG.d/a-card.md", "CHANGELOG.d/auto-recut-disjoint-stale-tip.md", "CHANGELOG.md"]) assert.equal(DOCS_ONLY.test(p), true, p);
  for (const p of ["CHANGELOG.d/run.mjs", "CHANGELOG.d/x.md.js", "CHANGELOG.d/sub/x.md", "CHANGELOG.d/", "CHANGELOG.d", "CHANGELOG.dx/x.md", "xCHANGELOG.d/x.md", "worker/CHANGELOG.d/x.md", "CHANGELOG.d/x.md/y"]) assert.equal(DOCS_ONLY.test(p), false, p);
});

test("a landing of changelog fragments, docs and tests reads Live with noInstall; a script in CHANGELOG.d does not", () => {
  for (const files of [["CHANGELOG.d/a-card.md"], ["CHANGELOG.d/a-card.md", "docs/x.md", "tests/t.test.mjs"]]) {
    const s = cardState(card, landed(files).repo, cfg, T);
    assert.equal(s.noInstall, true, files.join()); assert.equal(s.phase, "live", files.join());
  }
  for (const files of [["CHANGELOG.d/a-card.md", "CHANGELOG.d/run.mjs"], ["CHANGELOG.d/a-card.md", "CHANGELOG.d/sub/x.md"]]) {
    const s = cardState(card, landed(files).repo, cfg, T);
    assert.equal(Object.hasOwn(s, "noInstall"), false, files.join()); assert.equal(s.phase, "ship", files.join());
  }
});

test("make-pair groups a fragment under docs and a look-alike under other", () => {
  assert.deepEqual(groupPaths(["CHANGELOG.d/a-card.md", "CHANGELOG.md", "CHANGELOG.d/run.mjs", "CHANGELOG.d/sub/x.md"]),
    [["docs", ["CHANGELOG.d/a-card.md", "CHANGELOG.md"]], ["other", ["CHANGELOG.d/run.mjs", "CHANGELOG.d/sub/x.md"]]]);
});
