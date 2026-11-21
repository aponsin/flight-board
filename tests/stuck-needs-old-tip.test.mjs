// #C1396: `stuck` needs the tip itself to be old. A card whose agent works through subagents (the roster shows the role idle) but keeps pushing is not stuck: a push resets the clock.
// The tip's time is evidence.headAt (the head commit's time at any phase, written by the collector), else evidence.readyAt; with none, the phase's age alone decides, as before.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { reading } from "../worker/reading.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { cardState, remoteTips } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";

const FIX = JSON.parse(readFileSync(new URL("./fixtures/readings-real.json", import.meta.url), "utf8"));
const NOW = 1_795_208_000_000, MEDIAN = 600e3, id = "sample-card-h";
const ctx = { phaseStart: new Map([[`${id}|language`, NOW - 1300e3]]), medians: { language: MEDIAN } }; // the phase is over twice the median old
const run = (readyAt, agents = {}) => {
  const f = FIX[id], { readyAt: _r, headAt: _h, ...rest } = f.evidence;
  return reading(f.card, readyAt === undefined ? rest : { ...rest, readyAt }, [], agents, {}, NOW, ctx);
};

test("(a) the phase is over twice the median and the tip is older than that: stuck", () => {
  assert.equal(run(NOW - 1300e3).state, "stuck");
});

test("(b) the same phase age but a tip pushed within the median: not stuck, it reads waiting (turn)", () => {
  const r = run(NOW - 300e3);
  assert.equal(r.state, "waiting");
  assert.equal(r.wait, "turn");
  assert.equal(run(NOW - 1100e3).state, "waiting", "a tip under twice the median old is not old either");
});

test("(c) no tip time: stuck as before", () => {
  assert.equal(run(undefined).state, "stuck");
});

test("(d) a session working on the card: working, as before", () => {
  assert.equal(run(NOW - 1300e3, { Linguist: { state: "working", card: id } }).state, "working");
});

test("(e) at build, where there is no readyAt, headAt is the tip's time: recent is not stuck, old is stuck, and headAt wins over readyAt", () => {
  const card = { id: "b-card", repo: "flight-board", owner_role: "Boardsmith" };
  const c = { phaseStart: new Map([["b-card|build", NOW - 1300e3]]), medians: { build: MEDIAN } };
  const ev = (more) => ({ phase: "build", lit: ["build"], headSha: "a".repeat(40), headSha12: "a".repeat(12), signed: [], onMain: false, at: NOW, ...more });
  const r = (more) => reading(card, ev(more), [], {}, { repos: [{ name: "flight-board", kind: "board" }] }, NOW, c);
  assert.equal(r({ headAt: NOW - 300e3 }).state, "waiting", "pushed within the median: not stuck");
  assert.equal(r({ headAt: NOW - 1300e3 }).state, "stuck", "an old tip: stuck");
  assert.equal(r({}).state, "stuck", "no tip time: today's rule");
  assert.equal(r({ headAt: NOW - 300e3, readyAt: NOW - 1300e3 }).state, "waiting", "headAt first");
});

test("(f) collector: a card read at build carries headAt, the head commit's time in ms; the schema fits it and a bad one is refused", () => {
  const T0 = 1_790_000_000;
  const dir = mkdtempSync(join(tmpdir(), "fb-headat-")), work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]); execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  g(["checkout", "-qb", "build/c1-lower"]);
  at = T0 + 10; appendFileSync(join(work, "a.md"), "x\n"); g(["add", "-A"]); g(["commit", "-qm", "WIP: work in progress\n\nBoard-Id: c1-lower"]);
  g(["checkout", "-q", "main"]); g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]);
  const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
  const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });
  const repo = { git: (a) => g(a), remote: "origin", main: "main", notes: NOTES, tips: remoteTips((a) => g(a), "origin"), live: null, versionPattern: null };
  const st = cardState({ id: "c1-lower", num: 1, level: "Quick", repo: "flight-board" }, repo, cfg, (T0 + 1000) * 1000);
  assert.equal(st.phase, "build");
  assert.equal(st.readyAt, undefined, "build has no readyAt");
  assert.equal(st.headAt, (T0 + 10) * 1000, "headAt is the head commit's time");
  const state = (c) => ({ v: 1, id: "t", cards: { k: c } });
  assert.deepEqual(stateErrors(state(st)).filter((e) => /headAt/.test(e)), []);
  assert.notDeepEqual(stateErrors(state({ ...st, headAt: "soon" })).filter((e) => /headAt/.test(e)), []);
});
