// #C1160 (11-17: the board lit "checker" on #C1128's empty start commit and the owner took it for a stuck review): a tip whose newest commit says WIP (#C1139's wipHead) is work in
// progress, so the probe reads the card at build: the phase stays build, firm is false and no readyAt is set. The next real commit reads as before (a review phase with its readyAt).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cardState } from "../collector/state.mjs";

const cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
function read(headSubject, { mainAtTip = false, trailer = true, empty = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fb-wipb-")), git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "gc.auto", "0");
  git("commit", "-q", "--allow-empty", "-m", "base"); const main = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", main);
  if (!empty) { mkdirSync(join(dir, "docs"), { recursive: true }); writeFileSync(join(dir, "docs/a.md"), "a\n"); git("add", "-A"); }
  const message = `${headSubject}${trailer ? "\n\nBoard-Id: a-card" : ""}`;
  git("commit", "-q", "--allow-empty", "-m", message); const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/build/a-card", sha);
  if (mainAtTip) git("update-ref", "refs/remotes/origin/main", sha);
  const T = Date.now();
  const tips = [{ branch: "build/a-card", sha, at: T, message }, { branch: "main", sha: mainAtTip ? sha : main, at: T - 1000, message: mainAtTip ? message : "base" }];
  return cardState({ id: "a-card", num: 1160, level: "Quick", phase: "plan" }, { git: (args) => git(...args), remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips, live: null, versionPattern: null }, cfg, T);
}

test("a WIP start commit reads at build: phase build, firm false, no readyAt, no waitingFor; the same shape of commit without WIP reads past build with its readyAt", () => {
  const wip = read("WIP: branch pushed before the first edit (#C1160)");
  assert.equal(wip.wipHead, true);
  assert.equal(wip.phase, "build");
  assert.equal(wip.firm, false);
  assert.equal(Object.hasOwn(wip, "readyAt"), false);
  assert.equal(Object.hasOwn(wip, "waitingFor"), false);
  const real = read("The watch checks the pin first (#C1160)");
  assert.equal(Object.hasOwn(real, "wipHead"), false);
  assert.notEqual(real.phase, "build", "the control: a real commit is past build");
  assert.equal(Number.isInteger(real.readyAt), true);
});

test("the word WIP right after one card token (the first-push guard's \"<card> WIP\") counts; so does an empty commit with any subject; a real commit that only mentions WIP does not", () => {
  for (const subject of ["#C1128 WIP: start", "1128 WIP", "rc-field-after-clear WIP", "WIP"]) {
    const r = read(subject);
    assert.equal(r.wipHead, true, subject);
    assert.equal(r.phase, "build", subject);
    assert.equal(Object.hasOwn(r, "readyAt"), false, subject);
  }
  const empty = read("Start the card", { empty: true });
  assert.equal(empty.wipHead, true, "an empty commit is a start push");
  assert.equal(empty.phase, "build");
  assert.equal(Object.hasOwn(empty, "readyAt"), false);
  for (const subject of ["Fix WIP: wording", "Fix the WIP notes (#C1160)", "WIPING the cache", "The board reads #C1128 WIP commits"]) {
    const r = read(subject);
    assert.equal(Object.hasOwn(r, "wipHead"), false, subject);
    assert.notEqual(r.phase, "build", subject);
  }
});

test("a WIP commit already on main, or on a bare branch, is not forced to build (the guards stay)", () => {
  const onMain = read("WIP: branch pushed before the first edit (#C1160)", { mainAtTip: true });
  assert.equal(Object.hasOwn(onMain, "wipHead"), false);
  assert.equal(onMain.phase === "build" && onMain.firm === false, false, "a main commit is not held at build by the mark");
});
