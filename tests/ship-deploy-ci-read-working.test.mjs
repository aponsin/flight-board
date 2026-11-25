// #C1426 (11-24: #C1421's Ship tile blinked blue, then read "queued to land" while Release's candidate build/ship-v1.226.27 waited on CI, and a deploy run in flight read no one's): a card reads
// working while the ship candidate carries it, while a deploy run on main holds its commit, and while its CI is running (DATA.md Tile states: "or CI is running"). Fictional shas and versions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { candidateShips, teamShip, deployRuns, addShipReads, shipsCard, cardState } from "../collector/state.mjs";
import { reading } from "../worker/reading.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const CAND = "c".repeat(40), PATTERN = "^build/ship-v\\d+\\.\\d+\\.\\d+$", SHIPPED = "([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})";
const c = { candidatePattern: PATTERN, shippedPattern: SHIPPED };
const subjects = "v1.226.27: build/card-a@aaaaaaa1, build/card-b@bbbbbbb2\nbase commit";
const team = (extra = {}) => ({ git: (a) => { if (a[0] === "merge-base") throw new Error("not an ancestor"); return subjects; }, remote: "origin", main: "main", tips: [{ branch: "build/ship-v1.226.27", sha: CAND, at: T - 4 * MIN, message: "" }], ci: () => ({ ci: "queued", ciMin: null }), ...extra });

test("candidateShips: the open candidate carries the cards its commit subjects name, each a card shipsCard finds", () => {
  const got = candidateShips(team(), c, T);
  assert.deepEqual(got.map((s) => s.branch), ["build/card-a", "build/card-b"]);
  assert.equal(shipsCard(got, { branch: "build/card-b", sha: "d".repeat(40) }, { sha: "d".repeat(40) }), true, "a card it carries");
  assert.equal(shipsCard(got, { branch: "build/card-z", sha: "d".repeat(40) }, { sha: "d".repeat(40) }), false, "a card it does not");
});

test("candidateShips: none with no candidate, a finished-bad run, no pattern, or no shippedPattern; a git that fails gives none", () => {
  assert.deepEqual(candidateShips(team({ tips: [] }), c, T), [], "no candidate");
  assert.deepEqual(candidateShips(team({ ci: () => ({ ci: "failed", ciMin: null }) }), c, T), [], "its run failed: the ship is over");
  assert.deepEqual(candidateShips(team(), { ...c, candidatePattern: "" }, T), [], "no candidatePattern");
  assert.deepEqual(candidateShips(team(), { ...c, shippedPattern: "" }, T), [], "no shippedPattern: no cards read");
  assert.deepEqual(candidateShips(team({ git: (a) => { if (a[0] === "merge-base") throw new Error("x"); throw new Error("no clone"); } }), c, T), []);
  assert.deepEqual(candidateShips(team({ git: () => "" }), c, T), [], "a candidate already on main (git's merge-base answers) is over");
});

test("the candidate is read once a run: the ship tile and the cards' list share one CI read", () => {
  let calls = 0;
  const t = team({ ci: () => { calls++; return { ci: "running", ciMin: null }; } });
  candidateShips(t, c, T);
  assert.equal(teamShip(t, c, T).ci, "running");
  assert.equal(calls, 1, "one CI call for both readings");
  candidateShips(t, c, T + MIN);
  assert.equal(calls, 2, "a later run reads again");
});

test("deployRuns: the commits of the deploy runs on now, none when gh can't be asked, none without a workflow", () => {
  const A = "a".repeat(40), B = "b".repeat(40), asked = [];
  const gh = (args) => { asked.push(args); return JSON.stringify([{ status: "in_progress", headSha: A }, { status: "queued", headSha: B }, { status: "completed", headSha: "d".repeat(40) }, { status: "in_progress", headSha: "short" }]); };
  assert.deepEqual(deployRuns(gh, "deploy.yml", T, undefined, "main"), [A, B]);
  assert.deepEqual(asked[0].slice(0, 6), ["run", "list", "--branch", "main", "--workflow", "deploy.yml"], "argv only, the workflow named");
  assert.equal(deployRuns(gh, "", T), null, "no deployWorkflow");
  const backoff = { until: 0, wait: 60e3 };
  assert.equal(deployRuns(() => { throw new Error("rate limited"); }, "deploy.yml", T, backoff), null);
  assert.equal(backoff.until, T + 60e3, "backs off like the other gh reads");
  assert.equal(deployRuns(() => "[]", "deploy.yml", T + 1000, backoff), null, "inside the back-off: not asked");
  assert.deepEqual(deployRuns(() => "[]", "deploy.yml", T + 61e3, backoff), []);
  assert.equal(deployRuns(() => "{}", "deploy.yml", T + 62e3), null);
});

test("addShipReads: the candidate's cards join the ship-run list, the deploy runs are listed; an unread run list is never made up", () => {
  const A = "a".repeat(40), gh = () => JSON.stringify([{ status: "in_progress", headSha: A }]), dc = { ...c, deployWorkflow: "deploy.yml", mainBranch: "main" };
  const t = addShipReads(team({ ships: [{ branch: "build/card-run", sha: "eeeeeee" }] }), dc, T, gh, { until: 0, wait: 60e3 });
  assert.deepEqual(t.ships.map((s) => s.branch), ["build/card-run", "build/card-a", "build/card-b"], "the run titles' pairs stay, the candidate's follow");
  assert.deepEqual(t.deploying, [A]);
  const unread = addShipReads(team({ ships: null }), dc, T, () => { throw new Error("gh down"); }, { until: 0, wait: 60e3 });
  assert.equal(unread.ships, null, "ship runs not read: nothing added, the cards say nothing of shipping");
  assert.equal(unread.deploying, null, "deploy runs not read");
  const none = addShipReads(team({ ships: [] }), { candidatePattern: "", shippedPattern: SHIPPED }, T, gh, { until: 0, wait: 60e3 });
  assert.deepEqual(none.ships, [], "no candidatePattern: as before");
  assert.equal("deploying" in none, false, "no deployWorkflow: not asked");
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-c1426-")), git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "-b", "main"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["commit", "-q", "--allow-empty", "-m", "base"]);
  git(["switch", "-q", "-c", "board-x"]); git(["commit", "-q", "--allow-empty", "-m", "work\n\nBoard-Id: board-x"]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  for (const ref of ["checker", "security"]) git(["notes", `--ref=refs/notes/${ref}`, "add", "-m", ref === "security" ? "SECURE" : "PASS", sha]);
  git(["update-ref", "refs/remotes/origin/main", "main"]); git(["update-ref", "refs/remotes/origin/board-x", sha]);
  const cfg = { phases: [["plan"], ["build"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
  const repo = (extra = {}) => ({ git, remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips: [{ branch: "board-x", sha, at: T, message: "work\n\nBoard-Id: board-x" }, { branch: "main", sha: "x", at: T, message: "" }], live: null, versionPattern: null, ...extra });
  return { git, sha, cfg, repo };
}

test("a card whose landing a deploy run on main holds reads shipping; one no run holds, a run list that failed, or a card not on main does not", () => {
  const { git, sha, cfg, repo } = scratch(), card = { id: "board-x", num: 1, level: "Full", phase: "plan" };
  git(["update-ref", "refs/remotes/origin/main", sha]);
  assert.equal(cardState(card, repo({ ships: [], deploying: [sha] }), cfg, T).shipping, true, "the run's commit is the card's landing");
  const later = git(["commit-tree", `${sha}^{tree}`, "-p", sha, "-m", "later"]).trim();
  assert.equal(cardState(card, repo({ ships: [], deploying: [later] }), cfg, T).shipping, true, "a run of a later main commit holds the landing too");
  assert.equal(cardState(card, repo({ ships: [], deploying: [sha], live: sha }), cfg, T).shipping, false, "already deployed: a later run is no ship of this card");
  assert.equal(cardState(card, repo({ ships: [], deploying: [] }), cfg, T).shipping, false, "no deploy on now");
  assert.equal(cardState(card, repo({ ships: [], deploying: [git(["rev-parse", "main"]).trim()] }), cfg, T).shipping, false, "a run of a commit before the landing");
  assert.equal(cardState(card, repo({ ships: [], deploying: null }), cfg, T).shipping, false, "the run list could not be read: the ship runs' answer stands");
  assert.equal(Object.hasOwn(cardState(card, repo({ deploying: [sha] }), cfg, T), "shipping"), true, "a deploy run is a fact even when the ship runs were not read");
  const { git: g2, sha: s2, cfg: cfg2, repo: repo2 } = scratch();
  assert.equal(cardState(card, repo2({ ships: [], deploying: [s2] }), cfg2, T).shipping, false, "not on main: a deploy run of main holds nothing of the card's");
  void g2;
});

// #C1430 (Checker 2 on #C1426): a deploy run whose commit git can't place (an unknown commit: git exits 128, not 1) is no answer, never "deploying".
test("a deploy run git can't place against the card's landing is unread: the card does not read shipping", () => {
  const { git, sha, cfg, repo } = scratch(), card = { id: "board-x", num: 1, level: "Full", phase: "plan" };
  git(["update-ref", "refs/remotes/origin/main", sha]);
  assert.equal(cardState(card, repo({ ships: [], deploying: ["f".repeat(40)] }), cfg, T).shipping, false, "git's failure is not a yes");
  assert.equal(cardState(card, repo({ ships: [], deploying: ["f".repeat(40), sha] }), cfg, T).shipping, true, "another run that holds it still counts");
});

// #C1430 (Checker 2 on #C1426: removing the call left the suite green): the probe's run puts the ship reads on the team repository right after reading it.
test("the probe's run calls addShipReads on the team repository it has just read", () => {
  const src = readFileSync(new URL("../collector/state.mjs", import.meta.url), "utf8");
  assert.match(src, /repos\[""\] = \{ \.\.\.r, [^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*addShipReads\(repos\[""\], c, now, r\.gh, shipBackoff\);/);
});

test("the reading: a card is working while CI runs, as while it queues; never on a stale reading, a passed run or a failed one", () => {
  const sha = "a".repeat(40), card = { id: "board-a", num: 1, repo: "flight-board", owner_role: "Boardsmith" };
  const ev = (over = {}) => ({ headSha: sha, headSha12: sha.slice(0, 12), phase: "checker", lit: ["checker"], onMain: false, at: T, ...over });
  const read = (e) => reading(card, e, [], {}, {}, T, {});
  assert.equal(read(ev({ ci: "running" })).working, true, "CI is running");
  assert.equal(read(ev({ ci: "running" })).state, "working");
  assert.equal(read(ev({ ci: "queued" })).working, true, "queued, as before");
  for (const ci of ["passed", "failed", "none"]) assert.equal(read(ev({ ci })).working, false, ci);
  assert.equal(read(ev({ ci: "running", stale: true, staleSince: T - 10 * MIN })).working, false, "a stale reading is never working");
  assert.equal(read(ev({ shipping: true, phase: "ship", lit: ["ship"] })).working, true, "a ship in flight, with no session on it");
});
