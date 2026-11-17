// #C1139 (Checker 2, 11-16 late): the dispatch woke it for #C1124 at 8224f95d and for #C1065 at d664bc97, each a single empty "WIP: branch pushed before the first edit" commit with no READY sent,
// though #C1066 was meant to stop exactly that. A WIP commit is not a READY whatever the stack switch or a signal says: the probe marks a card whose tip's newest commit says WIP (wipHead) and the
// dispatch gives it no review turn, for Checker and for Security. The next real commit is a new tip, with no such word, and wakes the lanes as before.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { dispatchRun } from "../collector/store-dispatch.mjs";
import { cardState } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Checker", "Security", "Release"], LEAD = "Manager";
const idle = { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN };
const card = (id, extra = {}) => ({ id, num: Number(id.replace(/\D/g, "")) || null, owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", ...extra });
const world = ({ cards, ev = {}, on = false }) => ({
  cards, asks: [], stackSwitch: [{ repo: "board", stack: on, set_by: "default", set_at: 0 }],
  evidence: { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle])) }, ...Object.fromEntries(Object.entries(ev).map(([id, v]) => [`cards.${id}`, { readAt: NOW - 5_000, value: v }])) },
});
const who = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "wip-")), roster: ROSTER, lead: LEAD, now: NOW }).items.map((i) => `${i.card}:${i.role}:${i.step}`).sort();
const pushed = (extra = {}) => ({ lit: ["checker"], phase: "checker", headSha12: "1".repeat(12), signed: [], onMain: false, ...extra });

test("dispatch: a tip whose newest commit says WIP wakes no reviewer, Security neither at Full, with the stack switch on or off; the same tip without the mark wakes them", () => {
  for (const on of [false, true]) {
    const quick = world({ cards: [card("c1-base")], ev: { "c1-base": pushed({ wipHead: true }) }, on });
    assert.deepEqual(who(quick), [], `quick, switch ${on}: nobody`);
    const full = world({ cards: [card("c1-base", { review_level: "Full" })], ev: { "c1-base": pushed({ wipHead: true }) }, on });
    assert.deepEqual(who(full), [], `full, switch ${on}: nobody`);
  }
  // the control: with the switch off, a pushed tip with no mark is a review turn as before
  assert.deepEqual(who(world({ cards: [card("c1-base")], ev: { "c1-base": pushed() } })), ["c1-base:Checker:review"]);
  assert.deepEqual(who(world({ cards: [card("c1-base", { review_level: "Full" })], ev: { "c1-base": pushed() } })), ["c1-base:Checker:review", "c1-base:Security:review"]);
  // a mark that is not exactly true is no mark
  for (const odd of [false, "true", 1, null]) assert.deepEqual(who(world({ cards: [card("c1-base")], ev: { "c1-base": pushed({ wipHead: odd }) } })), ["c1-base:Checker:review"], JSON.stringify(odd));
});

// ---- the probe: real git, a start push and then a real commit ----
const cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
function repoWith(headSubject) {
  const dir = mkdtempSync(join(tmpdir(), "fb-wip-")), git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "gc.auto", "0");
  git("commit", "-q", "--allow-empty", "-m", "base"); const main = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", main);
  mkdirSync(join(dir, "docs"), { recursive: true }); writeFileSync(join(dir, "docs/a.md"), "a\n"); git("add", "-A");
  const message = `${headSubject}\n\nBoard-Id: a-card`;
  git("commit", "-q", "--allow-empty", "-m", message); const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/build/a-card", sha);
  const T = Date.now();
  const tips = [{ branch: "build/a-card", sha, at: T, message }, { branch: "main", sha: main, at: T - 1000, message: "base" }];
  return { read: () => cardState({ id: "a-card", num: 1139, level: "Quick", phase: "plan" }, { git: (args) => git(...args), remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips, live: null, versionPattern: null }, cfg, T) };
}

test("the probe: a card whose tip's newest commit starts with WIP reads wipHead: true; a real commit after it, or a commit that only mentions WIP, does not", () => {
  const wip = repoWith("WIP: branch pushed before the first edit (#C1139)").read();
  assert.equal(wip.wipHead, true);
  // the reading passes the state schema, and the schema refuses a mark that is not exactly true
  const wrap = (c) => stateErrors({ v: 1, board: { boardId: "TestBoard01", at: NOW, probe: null, pageVersion: null }, agents: {}, cards: { "a-card": c } });
  assert.deepEqual(wrap(wip), []);
  for (const bad of [false, "true", 1]) assert.notDeepEqual(wrap({ ...wip, wipHead: bad }), [], JSON.stringify(bad));
  assert.equal(repoWith("WIP start").read().wipHead, true);
  assert.equal(Object.hasOwn(repoWith("The sweep gets a bigger buffer (#C1124)").read(), "wipHead"), false);
  assert.equal(Object.hasOwn(repoWith("Fix the WIP: wording").read(), "wipHead"), false, "the word must start the first line");
  assert.equal(Object.hasOwn(repoWith("WIPING the cache").read(), "wipHead"), false, "a word that merely starts with the letters is not WIP");
});
