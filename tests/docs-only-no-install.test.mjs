// #C882 (the owner's screenshot, 2026-11-10 9:37 pm): a landing that changes no deployed or pinned file (only docs and tests) needs no install and
// reads Live, not "WAITING FOR INSTALL: NO DEPLOY ASK YET". A Worker (or probe, page, hook, migration) change landed still waits for the install.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { cardState, noInstallLanding } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";

const T = Date.now() - 1234;
const cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
const card = { id: "a-card", num: 882, level: "Quick", phase: "plan" };

// A repository whose main holds one commit of the card changing `files` (or nothing at all); the card's branch tip is that commit, so it is landed.
function landed(files) {
  const dir = mkdtempSync(join(tmpdir(), "fb-noinstall-")), git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "-b", "main"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["commit", "-q", "--allow-empty", "-m", "base"]);
  for (const f of files) { mkdirSync(join(dir, dirname(f)), { recursive: true }); writeFileSync(join(dir, f), `${f}\n`); }
  if (files.length) git(["add", "-A"]);
  git(["commit", "-q", "--allow-empty", "-m", "the card\n\nBoard-Id: a-card"]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  git(["update-ref", "refs/remotes/origin/main", sha]); git(["update-ref", "refs/remotes/origin/build/a-card", sha]);
  const tips = [{ branch: "build/a-card", sha, at: T, message: "the card\n\nBoard-Id: a-card" }, { branch: "main", sha, at: T, message: "" }];
  return { sha, git, repo: (extra = {}) => ({ git, remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips, live: null, versionPattern: null, ...extra }) };
}

test("a landing of docs and tests only reads Live, with noInstall true; the schema takes it", () => {
  for (const files of [["docs/DATA.md"], ["README.md", "CHANGELOG.md"], ["tests/new.test.mjs", "docs/x.md"]]) {
    const { repo } = landed(files);
    const s = cardState(card, repo(), cfg, T);
    assert.equal(s.onMain, true);
    assert.equal(s.noInstall, true, files.join());
    assert.equal(s.phase, "live", `${files.join()} needs no install`);
    assert.deepEqual(stateErrors({ v: 1, board: { boardId: "TestBoard01", at: T, probe: null, pageVersion: null }, agents: {}, cards: { "a-card": s } }), []);
  }
});

test("a landing that changes any deployed or pinned file still waits for the install: Worker, migration, config, page, probe, gate, hooks, scripts", () => {
  for (const f of ["worker/board-worker.mjs", "worker/migrations/0099_x.sql", "worker/wrangler.board.toml", "page/board.template.html", "collector/state.mjs", "gate/reset.mjs", "hooks/stop.sh", "scripts/make-pair.mjs"]) {
    const { repo } = landed(["docs/DATA.md", f]);
    const s = cardState(card, repo(), cfg, T);
    assert.equal(s.onMain, true);
    assert.equal(Object.hasOwn(s, "noInstall"), false, f);
    assert.equal(s.phase, "ship", `${f} landed is not live until it is deployed`);
  }
});

test("a deployed landing is live as before, and one that changed nothing or cannot be read keeps waiting", () => {
  const { sha, repo } = landed(["worker/board-worker.mjs"]);
  assert.equal(cardState(card, repo({ live: sha }), cfg, T).phase, "live", "deployed: live by the deploy, not by noInstall");
  assert.equal(Object.hasOwn(cardState(card, repo({ live: sha }), cfg, T), "noInstall"), false);
  const empty = landed([]);
  assert.equal(cardState(card, empty.repo(), cfg, T).phase, "ship", "an empty commit: nothing to read, keeps waiting");
  assert.equal(noInstallLanding(() => { throw new Error("no such commit"); }, "a".repeat(40)), false);
  assert.equal(noInstallLanding(() => "", "a".repeat(40)), false);
  assert.equal(noInstallLanding(() => "docs/a.md\n", "not-a-sha"), false);
  assert.equal(noInstallLanding(() => "docs/a.md\nworker/x.mjs\n", "b".repeat(40)), false, "one deployed path is enough");
  assert.equal(noInstallLanding(() => "docs/a.md\ntests/b.test.mjs\n", "c".repeat(40)), true);
  assert.equal(noInstallLanding(() => "docs-not/a.md\n", "d".repeat(40)), false, "docs/ is a folder, not a prefix");
});
