// #C1275 (11-19: Designer got a review dispatch for #C1272 at e1a12981, which was #C1269's tip: the branch had no commit of its own yet, and Designer signed it and had to withdraw): a tip whose newest
// commit names Board-Ids and not the card's is another card's commit, the base of a stacked branch. The probe reads it as a start push (wipHead, phase build, no readyAt), which the dispatch already
// skips for a review turn; one commit of the card's own on it reads as before, and a stacked branch dispatches once it has one.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cardState } from "../collector/state.mjs";

const cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
// A repository with main, then a lower card's commit ("lower"), then (when ownMessage is given) the card's own commit on top. The branch is named for the card.
function read(ownMessage, { lowerTrailer = "Board-Id: lower-card" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fb-base-")), git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "gc.auto", "0");
  git("commit", "-q", "--allow-empty", "-m", "base"); const main = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", main);
  const lowerMsg = `The lower card's work\n\n${lowerTrailer}`;
  // Real changes, not empty commits: an empty commit is a start push whatever it says (#C1160).
  const change = (name) => { writeFileSync(join(dir, name), name + "\n"); git("add", "-A"); };
  change("lower.md"); git("commit", "-q", "-m", lowerMsg); let sha = git("rev-parse", "HEAD"), message = lowerMsg;
  if (ownMessage) { change("own.md"); git("commit", "-q", "-m", ownMessage); sha = git("rev-parse", "HEAD"); message = ownMessage; }
  git("update-ref", "refs/remotes/origin/card-two", sha);
  const T = Date.now();
  const tips = [{ branch: "card-two", sha, at: T, message }, { branch: "main", sha: main, at: T - 1000, message: "base" }];
  return cardState({ id: "card-two", num: 1272, level: "Quick", phase: "plan" }, { git: (args) => git(...args), remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips, live: null, versionPattern: null }, cfg, T);
}

test("a branch whose tip is still its base (another card's commit) reads as a start push: no review", () => {
  const r = read(null);
  assert.equal(r.wipHead, true);
  assert.equal(r.phase, "build");
  assert.equal(r.firm, false);
  assert.equal(Object.hasOwn(r, "readyAt"), false);
  assert.equal(Object.hasOwn(r, "waitingFor"), false);
});

test("one commit of the card's own on the base reads as before: past build, with its readyAt", () => {
  const r = read("The card's own work\n\nBoard-Id: card-two");
  assert.equal(Object.hasOwn(r, "wipHead"), false);
  assert.notEqual(r.phase, "build");
  assert.equal(Number.isInteger(r.readyAt), true);
});

test("a commit that names the card among several ids is the card's; a commit with no Board-Id line at all is not called foreign", () => {
  const several = read("Both cards\n\nBoard-Id: lower-card\nBoard-Id: card-two");
  assert.equal(Object.hasOwn(several, "wipHead"), false, "the card's id is among them");
  const none = read("A fix with no trailer");
  assert.equal(Object.hasOwn(none, "wipHead"), false, "no id on the head: the missing-trailer rules read it, not this one");
});
