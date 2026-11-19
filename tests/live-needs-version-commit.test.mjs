// #C1278 (11-19: the shipped feed and its Acknowledge button stopped after 1.218.0, ten versions ago): Release merges a card's commit into dev, CI goes green on that merge, and the version commit
// ("v1.226.3: <branch>@<sha>") is made after it. The newest green run therefore already contained the card's head while no commit naming a version was in it: the card read live and closed, its reading
// carried no liveVersion, and no ships row was ever written. In a repository that names its versions a card is deployed only once a version commit lies between its head and the live commit.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cardState } from "../collector/state.mjs";
import { noteShip, plainVersion } from "../worker/compat-ships.mjs";

const cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
// main: base, v1.0.1 (an earlier ship), the card's commit merged "into dev", and (when `versioned`) the version commit naming the card's branch. `liveAt` says which of them the newest green CI run is.
function read({ versioned, liveAt, pattern = "^v(\\d+\\.\\d+\\.\\d+)\\b" }) {
  const dir = mkdtempSync(join(tmpdir(), "fb-live-")), git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "gc.auto", "0");
  const commit = (name, msg) => { writeFileSync(join(dir, name), name + "\n"); git("add", "-A"); git("commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };
  const base = commit("a.txt", "base");
  const v0 = commit("b.txt", "v1.0.1: admin/an-older-card@" + base);
  git("checkout", "-q", "-b", "admin/c-card", v0);
  const card = commit("c.txt", "The card's work");
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "Merge commit '" + card + "' into dev", card);
  const merged = git("rev-parse", "HEAD");
  let version = null;
  if (versioned) { writeFileSync(join(dir, "ver.txt"), "1.0.2\n"); git("add", "-A"); git("commit", "-q", "-m", "v1.0.2: admin/c-card@" + card); version = git("rev-parse", "HEAD"); }
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  git("update-ref", "refs/remotes/origin/admin/c-card", card);
  const T = Date.now(), live = liveAt === "merge" ? merged : version;
  const tips = [{ branch: "admin/c-card", sha: card, at: T, message: "The card's work" }, { branch: "main", sha: git("rev-parse", "HEAD"), at: T - 1000, message: "main" }];
  return cardState({ id: "c-card", num: 1262, level: "Quick", phase: "ship" }, { git: (args) => git(...args), remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips, live, versionPattern: pattern, shippedPattern: "([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})" }, cfg, T);
}

test("green CI on the merge, version commit not yet in it: the card is not live and carries no version (it stays at ship)", () => {
  const r = read({ versioned: true, liveAt: "merge" });
  assert.equal(r.phase, "ship");
  assert.equal(r.liveVersion, null);
});

test("the version commit is in the live commit: the card reads live and its reading carries the version", () => {
  const r = read({ versioned: true, liveAt: "version" });
  assert.equal(r.phase, "live");
  assert.equal(r.liveVersion, "1.0.2");
});

test("a repository that names no versions is unchanged: a head in the live commit is deployed", () => {
  const r = read({ versioned: true, liveAt: "merge", pattern: null });
  assert.equal(r.phase, "live");
  assert.equal(r.liveVersion, null);
});

test("the ship is noted from that reading: a card's reading with liveVersion writes a ships row", async () => {
  const rows = [];
  const db = { prepare: (sql) => ({ bind: (...a) => ({ first: async () => (sql.startsWith("SELECT") ? null : undefined), run: async () => { rows.push([sql.split(" ")[0], ...a]); } }) }) };
  const r = read({ versioned: true, liveAt: "version" });
  await noteShip(db, Date.now(), "c-card", r);
  assert.equal(plainVersion(r.liveVersion), "1.0.2");
  assert.deepEqual(rows.map((x) => x[0]), ["INSERT"]);
  assert.equal(rows[0][1], "1.0.2");
});
