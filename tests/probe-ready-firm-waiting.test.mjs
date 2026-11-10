// #C731 B4b: the probe reads what derive.mjs gave the old page for a card's ETA and review lines: readyAt (the READY commit's time),
// firm (false while the card has only a head, no trailer or sign-off) and waitingFor (the reviews still unsigned on the tip), and the
// store's compat view passes them to derived/all. Real git; fictional repository and names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";
import { derivedDoc } from "../worker/compat-view.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-ready-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const branch = (name, msg, t) => { g(["checkout", "-qb", name]); at = T0 + t; appendFileSync(join(work, `${name}.md`), "x\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); const sha = g(["rev-parse", "HEAD"]).trim(); g(["checkout", "-q", "main"]); return sha; };
  const sign = (sha, who) => g(["notes", `--ref=${NOTES[who]}`, "add", "-m", "PASS", sha]);
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["push", "-q", "origin", "refs/notes/*:refs/notes/*"]); g(["fetch", "-q", "--prune", "origin"]); };
  const tipsOf = (name, sha, t, msg) => [{ branch: "main", sha: "x", at: T0, message: "" }, { branch: `origin/${name}`, sha, at: (T0 + t) * 1000, message: msg }];
  const repo = (extra = {}) => ({ git: (args) => g(args), remote: "origin", main: "main", notes: NOTES, live: null, versionPattern: null, ...extra });
  return { g, branch, sign, sync, tipsOf, repo };
}

test("a branch with a head but no trailer or sign-off is not firm and has no readyAt", () => {
  const s = scratch();
  const sha = s.branch("card-a", "Some work", 10); s.sync();
  const st = cardState({ id: "card-a", num: 731, level: "Full", phase: "plan" }, s.repo({ tips: s.tipsOf("card-a", sha, 10, "Some work") }), cfg, T0 * 1000);
  assert.equal(st.phase, "build"); assert.equal(st.firm, false);
  assert.ok(!("readyAt" in st) && !("waitingFor" in st));
});

test("a READY tip with one review signed has readyAt and waits for the other", () => {
  const s = scratch();
  const msg = "Work\n\nBoard-Id: card-b";
  const sha = s.branch("card-b", msg, 10); s.sign(sha, "checker"); s.sync();
  const st = cardState({ id: "card-b", num: 732, level: "Full", phase: "plan" }, s.repo({ tips: s.tipsOf("card-b", sha, 10, msg) }), cfg, T0 * 1000);
  assert.equal(st.phase, "security"); assert.equal(st.readyAt, (T0 + 10) * 1000); assert.deepEqual(st.waitingFor, ["security"]);
  assert.ok(!("firm" in st), "firm is only ever written as false");
  assert.deepEqual(stateErrors({ v: 1, board: { boardId: "b", at: T0 * 1000 }, cards: { "card-b": st }, agents: {} }).filter((e) => /readyAt|waitingFor|firm/.test(e)), []);
});

test("a fully signed tip has readyAt and no waitingFor", () => {
  const s = scratch();
  const msg = "Work\n\nBoard-Id: card-c";
  const sha = s.branch("card-c", msg, 10); s.sign(sha, "checker"); s.sign(sha, "security"); s.sync();
  const st = cardState({ id: "card-c", num: 733, level: "Full", phase: "plan" }, s.repo({ tips: s.tipsOf("card-c", sha, 10, msg) }), cfg, T0 * 1000);
  assert.equal(st.phase, "ship"); assert.equal(st.readyAt, (T0 + 10) * 1000); assert.ok(!("waitingFor" in st));
});

test("derived/all carries readyAt, firm false and waitingFor, and leaves them out otherwise", () => {
  const view = { now: 5, evidence: {
    "cards.a": { readAt: 1, value: { phase: "security", headSha12: "a".repeat(12), readyAt: 1_790_000_010_000, waitingFor: ["security"] } },
    "cards.b": { readAt: 1, value: { phase: "build", headSha12: "b".repeat(12), firm: false } },
    "cards.c": { readAt: 1, value: { phase: "plan", headSha12: null } },
  } };
  const d = derivedDoc(view).cards;
  assert.equal(d.a.readyAt, 1_790_000_010_000); assert.deepEqual(d.a.waitingFor, ["security"]); assert.ok(!("firm" in d.a));
  assert.equal(d.b.firm, false); assert.ok(!("readyAt" in d.b));
  assert.ok(!("readyAt" in d.c) && !("firm" in d.c) && !("waitingFor" in d.c));
});

// Security on 99a73a81 (LOW 2, 4, 5): a commit date outside the plan's time range gives no readyAt, so a bad date cannot fail the whole state;
// derived/all drops a firm that is not false and a readyAt that is not a number.
test("a commit time outside the plan's range gives no readyAt, and the state still fits", () => {
  const s = scratch();
  const msg = "Work\n\nBoard-Id: card-f";
  const sha = s.branch("card-f", msg, 10); s.sign(sha, "checker"); s.sync();
  const read = (at) => cardState({ id: "card-f", num: 736, level: "Full", phase: "plan" }, s.repo({ tips: [{ branch: "main", sha: "x", at: T0, message: "" }, { branch: "origin/card-f", sha, at, message: msg }] }), cfg, T0 * 1000);
  for (const bad of [0, 5, 1577836799999, 4102444800001, NaN, 1.5e12 + 0.5]) { const st = read(bad); assert.ok(!("readyAt" in st), `at ${bad}`); assert.deepEqual(st.waitingFor, ["security"]); }
  assert.equal(read(1_790_000_010_000).readyAt, 1_790_000_010_000);
});

test("derived/all keeps only firm false and a numeric readyAt", () => {
  const ev = (value) => ({ readAt: 1, value });
  const c = derivedDoc({ now: 5, evidence: { "cards.a": ev({ phase: "build", firm: true, readyAt: "soon" }), "cards.b": ev({ phase: "build", firm: "false", readyAt: NaN }) } }).cards;
  for (const id of ["a", "b"]) { assert.ok(!("firm" in c[id]), id); assert.ok(!("readyAt" in c[id]), id); }
});

// Checker on 6d56f58: the guards. firm is only ever written as false; readyAt is a time; waitingFor is 1 to 10 different phase words.
test("the plan refuses firm true, a bad readyAt and a bad waitingFor", () => {
  const board = { boardId: "b", at: T0 * 1000, probe: "a".repeat(12), pageVersion: "b".repeat(12) };
  const card = { num: null, phase: "build", headSha12: "a".repeat(12), signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: T0 * 1000 };
  const errs = (extra) => stateErrors({ v: 1, board, cards: { "card-x": { ...card, ...extra } }, agents: {} });
  assert.deepEqual(errs({ firm: false, readyAt: T0 * 1000, waitingFor: ["security"] }), []);
  for (const bad of [{ firm: true }, { firm: "false" }, { firm: null }, { readyAt: 5 }, { readyAt: "x" }, { readyAt: null }, { waitingFor: [] }, { waitingFor: ["security", "security"] }, { waitingFor: "security" }, { waitingFor: ["Not A Phase"] }, { waitingFor: Array.from({ length: 11 }, (_, i) => `p${i}`) }])
    assert.ok(errs(bad).length, JSON.stringify(bad));
});

// B4b: each card's expected version in derived/all, worked out by collector/expected.mjs from the cards' readings, the live version
// and the card words repo, batch and bump.
test("derived/all carries each card's expected version: the queue in READY order, a batch as one version, a minor bump, review at the earliest, another repository's card none", () => {
  const ev = (value) => ({ readAt: 1, value });
  const view = { now: 9, live: { state: "live", version: "v1.2.3", age: 0 }, cards: [
    { id: "q-one" }, { id: "q-two", batch: "pair" }, { id: "q-three", batch: "pair", bump: "minor" }, { id: "in-review" }, { id: "other-repo", repo: "elsewhere" }, { id: "dropped-one", dropped: 1 },
  ], evidence: {
    "cards.q-one": ev({ phase: "ship", headSha12: "a".repeat(12), readyAt: 1_790_000_001_000 }),
    "cards.q-two": ev({ phase: "ship", headSha12: "b".repeat(12), readyAt: 1_790_000_002_000 }),
    "cards.q-three": ev({ phase: "ship", headSha12: "c".repeat(12), readyAt: 1_790_000_003_000 }),
    "cards.in-review": ev({ phase: "security", headSha12: "d".repeat(12), readyAt: 1_790_000_004_000, waitingFor: ["security"] }),
    "cards.other-repo": ev({ phase: "ship", headSha12: "e".repeat(12), readyAt: 1_790_000_000_500 }),
    "cards.dropped-one": ev({ phase: "ship", headSha12: "f".repeat(12), readyAt: 1_790_000_000_400 }),
  } };
  const c = derivedDoc(view).cards;
  assert.deepEqual(c["q-one"].expected, { version: "1.2.4", place: 1, with: [], bump: "patch" });
  assert.deepEqual(c["q-two"].expected, { version: "1.3.0", place: 2, with: ["q-three"], bump: "minor" }, "a batch is one version, the largest bump");
  assert.deepEqual(c["q-three"].expected, { version: "1.3.0", place: 2, with: ["q-two"], bump: "minor" });
  assert.deepEqual(c["in-review"].expected, { version: "1.3.1", earliest: true, bump: "patch" });
  assert.equal(c["other-repo"].expected, undefined, "a card of another repository is not in the team's queue");
  assert.equal(c["dropped-one"].expected, undefined);
  const noLive = derivedDoc({ ...view, live: undefined }).cards;
  assert.equal(noLive["q-one"].expected, undefined, "no known version, no prediction");
});

test("a shipping card's expected version is the ship candidate's, and the cards behind it follow", () => {
  const ev = (value) => ({ readAt: 1, value });
  const view = { now: 9, live: { state: "live", version: "v1.2.3", age: 0 }, cards: [{ id: "going" }, { id: "behind" }], evidence: {
    ship: { readAt: 8, value: { version: "1.2.4", ci: "running", at: 8 } },
    "cards.going": ev({ phase: "ship", headSha12: "a".repeat(12), readyAt: 1_790_000_001_000, shipping: true }),
    "cards.behind": ev({ phase: "ship", headSha12: "b".repeat(12), readyAt: 1_790_000_002_000 }),
  } };
  const c = derivedDoc(view).cards;
  assert.deepEqual(c.going.expected, { version: "1.2.4", shipping: true });
  assert.equal(c.behind.expected.version, "1.2.5");
});

// B4b: the release log's CI times reach the page's ETA box: read from main by the probe, held by the schema, written as the "releases"
// evidence key, and drawn as derived/all's releaseTimes.
test("the release log's times: read from main, kept to the newest rows, a bad row or path reads as nothing", async () => {
  const { releaseTimesOf } = await import("../collector/state.mjs");
  const log = ["| date | v1.0.0 | candidate run 3.5 min, main run 6 min |", "| 2026-01-01 | v1.0.1 | candidate run 4 min, main run 7.5 min |", "| nope | v2.0.0 | no times here |", "| x | v1.0.2 | dev run 5 min, main run 8 min |"].join("\n");
  const git = (args) => { assert.equal(args[0], "show"); assert.equal(args[1], "origin/main:docs/RELEASE-TIMES.md"); return log; };
  assert.deepEqual(releaseTimesOf(git, "origin/main", "docs/RELEASE-TIMES.md"), { "1.0.0": { testsMin: 3.5, deployMin: 6 }, "1.0.1": { testsMin: 4, deployMin: 7.5 }, "1.0.2": { testsMin: 5, deployMin: 8 } });
  // a stub that serves the log for ANY path, counting calls: the path guard alone must keep git from being asked
  let calls = 0;
  const open = () => { calls += 1; return log; };
  for (const bad of ["", "-x", "../x", "a/../x", null, 5]) assert.equal(releaseTimesOf(open, "origin/main", bad), null, String(bad));
  assert.equal(calls, 0, "git is never called for a bad path");
  assert.ok(releaseTimesOf(open, "origin/main", "docs/RELEASE-TIMES.md"));
  assert.equal(calls, 1);
  // a long log keeps the NEWEST rows (the real log has ~500, newest last)
  const { MAX_RELEASES } = await import("../collector/state-schema.mjs");
  const total = MAX_RELEASES + 40;
  const long = Array.from({ length: total }, (_, i) => `| d | v1.${i}.0 | candidate run 1 min, main run 2 min |`).join("\n");
  const kept = Object.keys(releaseTimesOf(() => long, "origin/main", "docs/RELEASE-TIMES.md"));
  assert.equal(kept.length, MAX_RELEASES);
  assert.equal(kept[0], `1.${total - MAX_RELEASES}.0`);
  assert.equal(kept[kept.length - 1], `1.${total - 1}.0`);
  assert.equal(releaseTimesOf(() => { throw new Error("no file"); }, "origin/main", "docs/RELEASE-TIMES.md"), null);
  assert.equal(releaseTimesOf(() => "nothing useful", "origin/main", "docs/RELEASE-TIMES.md"), null);
});

test("releases fit the plan: versions with two numbers each, nothing else; the evidence write and derived/all carry them", async () => {
  const { stateErrors, pickState } = await import("../collector/state-schema.mjs");
  const { evidenceWrites } = await import("../collector/probe-evidence.mjs");
  const base = { v: 1, board: { boardId: "b", at: T0 * 1000, probe: "a".repeat(12), pageVersion: "b".repeat(12) }, cards: {}, agents: {} };
  const ok = { ...base, releases: { "1.2.3": { testsMin: 4, deployMin: 6.5 } } };
  assert.deepEqual(stateErrors(ok), []);
  assert.deepEqual(pickState({ ...ok, releases: { "1.2.3": { testsMin: 4, deployMin: 6.5 } } }).releases, { "1.2.3": { testsMin: 4, deployMin: 6.5 } });
  for (const bad of [{ "v1.2.3": { testsMin: 1, deployMin: 1 } }, { "1.2.3": { testsMin: -1, deployMin: 1 } }, { "1.2.3": { testsMin: 1 } }, { "1.2.3": { testsMin: 1, deployMin: 1, text: "x" } }, { "1.2.3": { testsMin: "4", deployMin: 1 } }, []])
    assert.ok(stateErrors({ ...base, releases: bad }).length, JSON.stringify(bad));
  assert.ok(stateErrors({ ...base, releases: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`1.0.${i}`, { testsMin: 1, deployMin: 1 }])) }).length, "more than 100 versions");
  assert.deepEqual(evidenceWrites(ok, "evidence").find((w) => w.key === "releases").value, ok.releases);
  assert.equal(evidenceWrites(base, "evidence").some((w) => w.key === "releases"), false, "no log, no write");
  const d = derivedDoc({ now: 9, evidence: { releases: { readAt: 1, value: ok.releases } } });
  assert.deepEqual(d.releaseTimes, ok.releases);
  assert.equal(derivedDoc({ now: 9, evidence: {} }).releaseTimes, undefined);
});

test("the state's change key moves when a release is added at the cap or a time changes, and not otherwise", async () => {
  const { changeKey } = await import("../worker/state-worker.mjs");
  const rel = (from, n, t = 1) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`1.${from + i}.0`, { testsMin: t, deployMin: 2 }]));
  const st = (releases) => ({ cards: {}, agents: {}, board: { probe: "a".repeat(12), pageVersion: "b".repeat(12) }, ...(releases ? { releases } : {}) });
  assert.equal(changeKey(st(rel(0, 100))), changeKey(st(rel(0, 100))));
  assert.notEqual(changeKey(st(rel(0, 100))), changeKey(st(rel(1, 100))), "a new release at the 100 cap is a change");
  assert.notEqual(changeKey(st(rel(0, 3))), changeKey(st(rel(0, 3, 9))), "a changed time is a change");
  assert.notEqual(changeKey(st()), changeKey(st(rel(0, 1))));
});

test("waitingFor lists every unsigned review in order, skips the ones the card does not need, and a READY tip signed by none lists all", () => {
  const s = scratch();
  const msg = "Work\n\nBoard-Id: card-e";
  const sha = s.branch("card-e", msg, 10); s.sync();
  const read = (level) => cardState({ id: "card-e", num: 735, level, phase: "plan" }, s.repo({ tips: s.tipsOf("card-e", sha, 10, msg) }), cfg, T0 * 1000);
  const full = read("Full");
  assert.equal(full.phase, "checker"); assert.deepEqual(full.waitingFor, ["checker", "security"]);
  const quick = read("Quick");
  assert.deepEqual(quick.waitingFor, ["checker"], "Security is skipped below Full");
});
