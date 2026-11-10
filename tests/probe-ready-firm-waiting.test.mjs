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

// Checker on 6d56f58: the guards. firm is only ever written as false; readyAt is a time; waitingFor is 1 to 10 different phase words.
test("the plan refuses firm true, a bad readyAt and a bad waitingFor", () => {
  const board = { boardId: "b", at: T0 * 1000, probe: "a".repeat(12), pageVersion: "b".repeat(12) };
  const card = { num: null, phase: "build", headSha12: "a".repeat(12), signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: T0 * 1000 };
  const errs = (extra) => stateErrors({ v: 1, board, cards: { "card-x": { ...card, ...extra } }, agents: {} });
  assert.deepEqual(errs({ firm: false, readyAt: T0 * 1000, waitingFor: ["security"] }), []);
  for (const bad of [{ firm: true }, { firm: "false" }, { firm: null }, { readyAt: 5 }, { readyAt: "x" }, { readyAt: null }, { waitingFor: [] }, { waitingFor: ["security", "security"] }, { waitingFor: "security" }, { waitingFor: ["Not A Phase"] }, { waitingFor: Array.from({ length: 11 }, (_, i) => `p${i}`) }])
    assert.ok(errs(bad).length, JSON.stringify(bad));
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
