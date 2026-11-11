// #C854: a signed tip that no longer continues main goes back to its builder. Seen 2026-11-10: #C852 v2 read "waits at Ship" after #C846 v4 landed
// first, so v2 no longer continued main and Release could not take it. The probe says so (behindMain), the dispatch names the owner (re-cut), and
// the stall line says "signed but behind main <sha>, waits at <owner>". A re-cut tip is a new commit with no notes, so a reviewer is named again.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState, remoteTips } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";
import { turnsOf } from "../collector/store-dispatch.mjs";
import { stalledWaits } from "../worker/board-rules.mjs";
import { dispatchLine, DISPATCH_STEPS } from "../gate/reset.mjs";

const SHA = "8b3855f0f672";
const card = { id: "c1-thing", num: 1, owner_role: "Boardsmith", review_level: "Quick" };
const ship = { lit: ["ship"], phase: "ship", headSha12: SHA, signed: ["checker", "security"], onMain: false };

test("signed and continuing main names Release; signed and behind main names the owner; a re-cut tip names Checker", () => {
  assert.deepEqual(turnsOf(card, ship), [{ role: "Release", phase: "ship", step: "land", sha: SHA, signed: ["Checker", "Security"] }]);
  assert.deepEqual(turnsOf(card, { ...ship, behindMain: true }), [{ role: "Boardsmith", phase: "ship", step: "recut", sha: SHA, signed: ["Checker", "Security"] }]);
  const recut = { lit: ["checker"], phase: "checker", headSha12: "111111111111", signed: [], onMain: false };
  assert.deepEqual(turnsOf(card, recut).map((t) => `${t.role}:${t.step}`), ["Checker:review"]);
});

test("the line names the step, the commit and who signed", () => {
  const t = turnsOf(card, { ...ship, behindMain: true })[0];
  assert.equal(dispatchLine({ card: card.id, num: 1, role: t.role, level: 1, since: 0, phase: t.phase, step: t.step, sha: t.sha, signed: t.signed }),
    `DISPATCH #C1 at ship: ${SHA} signed by Checker and Security; it ${DISPATCH_STEPS.recut} (Boardsmith's turn; pushing your own build branch, sending READY and taking your next queued card need no go from anyone, act on this)`);
});

test("landed (on main) is not behind it, whatever the field says", () => {
  assert.deepEqual(turnsOf({ ...card, repo: "flight-board" }, { ...ship, onMain: true, behindMain: true }).map((t) => t.step), ["pair"]);
});

test("the stall line: a signed card behind main waits at its owner, not at Release; one continuing main still waits at Release", () => {
  const NOW = 1_800_000_000_000, MIN = 60e3;
  const agents = { Boardsmith: { state: "idle", since: NOW - 40 * MIN }, Release: { state: "idle", since: NOW - 40 * MIN } };
  const run = (v) => stalledWaits({ now: NOW, cards: [{ ...card, paused: 0, dropped: 0 }], evidence: { [card.id]: v }, agents, openAskCards: new Set(), phaseStart: new Map([[`${card.id}|ship`, NOW - 30 * MIN]]) });
  const behind = run({ ...ship, behindMain: true });
  assert.equal(behind.length, 1);
  assert.equal(behind[0].role, "Boardsmith");
  assert.match(behind[0].reason, new RegExp(`^#C1 signed but behind main ${SHA}, waits at Boardsmith 15 min, Boardsmith idle since`));
  const ok = run(ship);
  assert.equal(ok[0].role, "Release");
  assert.match(ok[0].reason, /^#C1 waits at Ship 15 min, Release idle since/);
});

// Real git: a signed branch whose base main has since moved past.
const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-stale-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const commit = (t, file, msg) => { at = T0 + t; appendFileSync(join(work, file), `${t}\n`); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  const repo = () => ({ git: (a) => g(a), remote: "origin", main: "main", notes: NOTES, tips: remoteTips((a) => g(a), "origin"), live: null, versionPattern: null });
  return { g, commit, sync, repo };
}
const sign = (s, sha) => { for (const ref of Object.values(NOTES)) s.g(["notes", `--ref=${ref}`, "add", "-m", "PASS", sha]); };
const NOW = (T0 + 1000) * 1000;

test("the probe: a signed tip with main ahead of it reads behindMain; one that continues main does not; a tip in review costs no extra reading", () => {
  const s = scratch();
  s.g(["checkout", "-qb", "build/c1-thing"]);
  const own = s.commit(10, "a.md", "Work\n\nBoard-Id: c1-thing");
  sign(s, own);
  s.g(["checkout", "-q", "main"]);
  s.sync();
  const c = { id: "c1-thing", num: 1, level: "Quick" };
  const fine = cardState(c, s.repo(), cfg, NOW);
  assert.equal(fine.phase, "ship");
  assert.equal(fine.behindMain, undefined, "it continues main");
  s.commit(20, "b.md", "Another card landed first");
  s.sync();
  const behind = cardState(c, s.repo(), cfg, NOW);
  assert.equal(behind.phase, "ship");
  assert.equal(behind.behindMain, true);
  assert.deepEqual(stateErrors({ v: 1, id: "t", cards: { k: behind } }).filter((e) => /behindMain/.test(e)), [], "the schema accepts it");
  const s2 = scratch();
  s2.g(["checkout", "-qb", "build/c1-thing"]);
  s2.commit(10, "a.md", "Work\n\nBoard-Id: c1-thing");
  s2.g(["checkout", "-q", "main"]); s2.commit(20, "b.md", "ahead"); s2.sync();
  const calls = [];
  const watch = { ...s2.repo(), git: (a) => { calls.push(a.join(" ")); return s2.g(a); } };
  const inReview = cardState(c, watch, cfg, NOW);
  assert.notEqual(inReview.phase, "ship");
  assert.equal(inReview.behindMain, undefined);
  assert.ok(!calls.some((x) => x.startsWith("merge-base --is-ancestor origin/main")), "no ancestry check of main for a card not at ship");
});
