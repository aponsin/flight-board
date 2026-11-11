// #C852: a review's FINDINGS note on the READY commit sends the card back to its owner, and a new commit clears it by itself. Git is the
// evidence: the probe reads the note (it is no sign-off, and evidence.findings names the review), the dispatch turns that into the owner's
// turn, and the new commit has a new sha with no note. Real git; fictional repository and names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";
import { dispatchRun } from "../collector/store-dispatch.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-findings-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const commit = (name, msg, t, first) => { if (first) g(["checkout", "-qb", name]); else g(["checkout", "-q", name]); at = T0 + t; appendFileSync(join(work, `${name}.md`), "x\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); const sha = g(["rev-parse", "HEAD"]).trim(); g(["checkout", "-q", "main"]); return sha; };
  const note = (sha, who, text, t) => { at = T0 + t; g(["notes", `--ref=${NOTES[who]}`, "add", "-f", "-m", text, sha]); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["push", "-q", "-f", "origin", "refs/notes/*:refs/notes/*"]); g(["fetch", "-q", "--prune", "origin"]); };
  const tips = (name, sha, t, msg) => [{ branch: "main", sha: "x", at: T0, message: "" }, { branch: `origin/${name}`, sha, at: (T0 + t) * 1000, message: msg }];
  const repo = (extra = {}) => ({ git: (args) => g(args), remote: "origin", main: "main", notes: NOTES, live: null, versionPattern: null, tips: [], ...extra });
  return { commit, note, sync, tips, repo };
}
const fits = (id, st) => stateErrors({ v: 1, board: { boardId: "b", at: T0 * 1000, probe: null, pageVersion: null }, cards: { [id]: st }, agents: {} });

test("the probe: a FINDINGS note is no sign-off and is named in findings; the next commit has neither", () => {
  const s = scratch();
  const msg = "Work\n\nBoard-Id: card-f";
  const sha = s.commit("card-f", msg, 10, true);
  s.note(sha, "checker", "FINDINGS two bugs", 30); s.note(sha, "security", "SECURE", 40); s.sync();
  const st = cardState({ id: "card-f", num: 820, level: "Full", phase: "plan" }, s.repo({ tips: s.tips("card-f", sha, 10, msg) }), cfg, T0 * 1000);
  assert.deepEqual(st.signed, ["security"], "the FINDINGS note does not sign Checker");
  assert.deepEqual(st.findings, ["checker"]);
  assert.ok(st.waitingFor.includes("checker"), "Checker is still waited for");
  assert.deepEqual(fits("card-f", st), []);
  // The fix: a new commit, a new sha, no note on it.
  const sha2 = s.commit("card-f", msg, 60, false); s.sync();
  const st2 = cardState({ id: "card-f", num: 820, level: "Full", phase: "plan" }, s.repo({ tips: s.tips("card-f", sha2, 60, msg) }), cfg, T0 * 1000);
  assert.ok(!("findings" in st2), "findings were on the old sha");
  assert.deepEqual(st2.signed, []);
  assert.deepEqual(fits("card-f", st2), []);
});

// The dispatch half: the same evidence shapes, through the real run.
const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Checker", "Security", "Release"], LEAD = "Manager";
const SHA = "8b3855f0f672", SHA_NEW = "c0ffee0badf0";
const world = (ev, card = {}) => ({
  cards: [{ id: "c900-thing", num: 900, owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", ...card }],
  asks: [],
  evidence: {
    agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN }])) },
    "cards.c900-thing": { readAt: NOW - 5_000, value: ev },
  },
});
const who = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "fb-d-")), roster: ROSTER, lead: LEAD, now: NOW }).items.map((i) => `${i.role}:${i.step}:${i.sha}`).sort();
const AT = { lit: ["checker"], phase: "checker", onMain: false };

test("the dispatch: FINDINGS on the tip is the owner's turn, not the reviewer's; a new tip without the note goes back to the reviewer", () => {
  assert.deepEqual(who(world({ ...AT, headSha12: SHA, signed: [] })), [`Checker:review:${SHA}`], "no findings: the reviewer");
  assert.deepEqual(who(world({ ...AT, headSha12: SHA, signed: [], findings: ["checker"] })), [`Boardsmith:rework:${SHA}`]);
  assert.deepEqual(who(world({ ...AT, headSha12: SHA_NEW, signed: [] })), [`Checker:review:${SHA_NEW}`], "the fix is pushed: review again");
});

test("the dispatch: on a Full card a finding from either review holds both reviewers until the fix; counted issues never move a turn", () => {
  const full = { review_level: "Full" };
  assert.deepEqual(who(world({ ...AT, headSha12: SHA, signed: ["security"], findings: ["checker"] }, full)), [`Boardsmith:rework:${SHA}`]);
  assert.deepEqual(who(world({ ...AT, headSha12: SHA, signed: [], findings: ["security"] }, full)), [`Boardsmith:rework:${SHA}`], "not Checker alone either");
  const counted = { rework_reason: "review findings", issues: JSON.stringify({ bugs: 3, security: 0, language: 0, design: 0, owner: 0 }) };
  assert.deepEqual(who(world({ lit: ["ship"], phase: "ship", headSha12: SHA, signed: ["checker", "security"], onMain: false }, counted)), [`Release:land:${SHA}`]);
});

// Checker: the owner's turn is only at a review phase. A FINDINGS note on the tip of a card at ship comes from a lane the card did not
// require (the required reviews are signed), so Release still lands it; the card does not go back to the owner on it.
test("the dispatch: findings on a card at ship (a lane it does not require) leave the turn with Release", () => {
  const ship = { lit: ["ship"], phase: "ship", headSha12: SHA, signed: ["checker", "security"], onMain: false };
  assert.deepEqual(who(world({ ...ship, findings: ["language"] })), [`Release:land:${SHA}`]);
  assert.deepEqual(who(world({ ...ship, findings: ["checker"] })), [`Release:land:${SHA}`]);
});

test("the dispatch: an unknown name in findings is ignored", () => {
  assert.deepEqual(who(world({ ...AT, headSha12: SHA, signed: [], findings: ["x\ny"] })), [`Checker:review:${SHA}`]);
});
