// #C620: every phase tile lit from evidence. The probe reads which phases a card has evidence for (a branch commit, a CI
// run, each sign-off, main, a deploy) and sends them as card.seen; the page lights a tile from it when the steps are silent.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { seenPhases, cardState } from "../collector/state.mjs";
import { stateErrors, pickState } from "../collector/state-schema.mjs";
import { loadNames } from "./harness.mjs";

const T = Date.now() - 1234;
const cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };

test("seenPhases: only what exists, in the board's order", () => {
  assert.deepEqual(seenPhases(cfg, {}), [], "nothing exists: nothing seen");
  assert.deepEqual(seenPhases(cfg, { head: true }), ["build"]);
  assert.deepEqual(seenPhases(cfg, { head: true, ci: "none" }), ["build"], "no CI run is no test evidence");
  assert.deepEqual(seenPhases(cfg, { head: true, ci: "failed", signed: ["security", "checker"] }), ["build", "test", "checker", "security"]);
  assert.deepEqual(seenPhases(cfg, { head: true, shipping: true }), ["build", "ship"]);
  assert.deepEqual(seenPhases(cfg, { head: true, onMain: true, deployed: true }), ["build", "ship", "live"]);
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-evidence-")), git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "-b", "main"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["commit", "-q", "--allow-empty", "-m", "base"]);
  git(["switch", "-q", "-c", "board-x"]); git(["commit", "-q", "--allow-empty", "-m", "work\n\nBoard-Id: board-x"]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  git(["notes", "--ref=refs/notes/checker", "add", "-m", "PASS", sha]);
  git(["update-ref", "refs/remotes/origin/main", "main"]); git(["update-ref", "refs/remotes/origin/board-x", sha]);
  const repo = (extra = {}) => ({ git, remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips: [{ branch: "board-x", sha, at: T, message: "work\n\nBoard-Id: board-x" }, { branch: "main", sha: "x", at: T, message: "" }], live: null, versionPattern: null, ...extra });
  return { git, sha, repo };
}

test("the card state carries seen: a commit and a sign-off, a CI run, main", () => {
  const { git, sha, repo } = scratch(), card = { id: "board-x", num: 620, level: "Full", phase: "plan" };
  assert.deepEqual(cardState(card, repo(), cfg, T).seen, ["build", "checker"]);
  assert.deepEqual(cardState(card, repo({ ci: () => ({ ci: "passed", ciMin: 4 }) }), cfg, T).seen, ["build", "test", "checker"]);
  git(["update-ref", "refs/remotes/origin/main", sha]);
  assert.deepEqual(cardState(card, repo(), cfg, T).seen, ["build", "checker", "ship"]);
  assert.deepEqual(cardState(card, repo({ live: "origin/main" }), cfg, T).seen, ["build", "checker", "ship", "live"]);
});

test("a card with no branch has no seen field: no claim, so the page shows no record", () => {
  const { repo } = scratch();
  assert.equal(Object.hasOwn(cardState({ id: "other-card", num: 1 }, repo(), cfg, T), "seen"), false);
});

test("the state schema: seen is an optional list of phases; a state without it still fits", () => {
  const base = { v: 1, board: { boardId: "TestBoard01", at: T, probe: null, pageVersion: null }, agents: {} };
  const card = { num: 1, phase: "ship", headSha12: "a1b2c3d4e5f6", signed: ["checker"], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: T };
  assert.deepEqual(stateErrors({ ...base, cards: { "board-x": card } }), []);
  assert.deepEqual(stateErrors({ ...base, cards: { "board-x": { ...card, seen: ["build", "checker"] } } }), []);
  assert.ok(stateErrors({ ...base, cards: { "board-x": { ...card, seen: ["Build it now!"] } } }).length, "a sentence does not fit");
  assert.ok(stateErrors({ ...base, cards: { "board-x": { ...card, seen: ["build", "build"] } } }).length, "no repeats");
  assert.ok(stateErrors({ ...base, cards: { "board-x": { ...card, seen: "build" } } }).length);
  assert.deepEqual(pickState({ ...base, cards: { "board-x": { ...card, seen: ["build"] } } }).cards["board-x"].seen, ["build"]);
});

function page(card, probeCard) {
  const b = loadNames(["liveCard", "probeEvent"]);
  b.state.initRaw = [{ id: card, num: 620, status: "active" }];
  b.state.derived = [{ id: "all", cards: {} }];
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 20e3 }, cards: { [card]: { headSha12: "a1b2c3d4e5f6", onMain: false, phase: "checker", ...probeCard } }, agents: {} } } });
  return b;
}

test("the page reads seen from a fresh live state, keeps only phases it has, and none from a stale or odd one", () => {
  const seen = (probeCard) => [...page("board-x", probeCard).liveCard("board-x").seen];
  assert.deepEqual(seen({ seen: ["build", "checker", "nonsense"] }), ["build", "checker"]);
  assert.deepEqual(seen({}), [], "a probe without it: nothing seen");
  assert.deepEqual(seen({ seen: "build" }), []);
});
