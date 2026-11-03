// #C621: a card with two branches carries one record per branch. The probe reads every tip of the card, each on its own
// (its phase, sign-offs, CI, main), so a page draws one row per branch and never lights two phases in one row.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cardState } from "../collector/state.mjs";
import { stateErrors, pickState } from "../collector/state-schema.mjs";
import { changeKey } from "../worker/state-worker.mjs";
import { loadNames } from "./harness.mjs";

const T = Date.now() - 1234;
const cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };

// Two branches of one card: route (signed by the checker) and picker (a commit, nothing else).
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-branches-")), git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "-b", "main"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["commit", "-q", "--allow-empty", "-m", "base"]);
  const msg = (n) => `${n}\n\nBoard-Id: two-parts`;
  git(["switch", "-q", "-c", "build/route"]); git(["commit", "-q", "--allow-empty", "-m", msg("route")]);
  const route = git(["rev-parse", "HEAD"]).trim();
  git(["switch", "-q", "main"]); git(["switch", "-q", "-c", "build/picker"]); git(["commit", "-q", "--allow-empty", "-m", msg("picker")]);
  const picker = git(["rev-parse", "HEAD"]).trim();
  git(["notes", "--ref=refs/notes/checker", "add", "-m", "PASS", route]);
  git(["update-ref", "refs/remotes/origin/main", "main"]);
  git(["update-ref", "refs/remotes/origin/build/route", route]); git(["update-ref", "refs/remotes/origin/build/picker", picker]);
  const tips = (extra = []) => [{ branch: "build/picker", sha: picker, at: T, message: msg("picker") }, { branch: "build/route", sha: route, at: T - 5000, message: msg("route") }, ...extra, { branch: "main", sha: "x", at: T, message: "" }];
  const repo = (extra = {}) => ({ git, remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips: tips(), live: null, versionPattern: null, ...extra });
  return { git, route, picker, repo };
}

test("a card with two branches carries one record per branch, each read from its own tip", () => {
  const { route, picker, repo } = scratch();
  const s = cardState({ id: "two-parts", num: 610, level: "Full", phase: "plan" }, repo(), cfg, T);
  assert.equal(s.headSha12, picker.slice(0, 12), "the card's own fields stay the newest tip's");
  assert.deepEqual(s.branches.map((b) => b.name), ["picker", "route"]);
  const [p, r] = s.branches;
  assert.equal(p.headSha12, picker.slice(0, 12)); assert.deepEqual(p.signed, []); assert.deepEqual(p.seen, ["build"]);
  assert.equal(r.headSha12, route.slice(0, 12)); assert.deepEqual(r.signed, ["checker"]); assert.deepEqual(r.seen, ["build", "checker"]);
  assert.notDeepEqual(p.seen, r.seen, "one branch's sign-off never lights the other's tile");
  assert.deepEqual(stateErrors({ v: 1, board: { boardId: "TestBoard01", at: T, probe: null, pageVersion: null }, agents: {}, cards: { "two-parts": s } }), []);
});

test("a card with one branch has no branches field; a branch name is the last path segment and never repeats", () => {
  const { repo } = scratch();
  const one = cardState({ id: "two-parts", num: 1 }, repo({ tips: repo().tips.filter((h) => h.branch !== "build/route") }), cfg, T);
  assert.equal(Object.hasOwn(one, "branches"), false);
  const twin = cardState({ id: "two-parts", num: 1 }, repo({ tips: repo().tips.map((h) => (h.branch === "build/route" ? { ...h, branch: "admin/picker" } : h)) }), cfg, T);
  assert.deepEqual(twin.branches.map((b) => b.name), ["picker", "picker-2"]);
});

test("the schema: branches is optional, 2 to 6 records, each with the card's fields and a unique id-shaped name", () => {
  const { repo } = scratch();
  const s = cardState({ id: "two-parts", num: 610 }, repo(), cfg, T);
  const state = (card) => ({ v: 1, board: { boardId: "TestBoard01", at: T, probe: null, pageVersion: null }, agents: {}, cards: { "two-parts": card } });
  const { branches, ...without } = s;
  assert.deepEqual(stateErrors(state(without)), [], "a probe before #C621 still fits");
  assert.ok(stateErrors(state({ ...s, branches: [branches[0]] })).length, "one record is not a list of branches");
  assert.ok(stateErrors(state({ ...s, branches: [branches[0], { ...branches[1], name: branches[0].name }] })).length, "a name twice");
  assert.ok(stateErrors(state({ ...s, branches: [branches[0], { ...branches[1], name: "Build/Route Fix" }] })).length, "a name that is not an id");
  assert.ok(stateErrors(state({ ...s, branches: [branches[0], { ...branches[1], note: "free text" }] })).length, "a key that is not in the plan");
  assert.ok(stateErrors(state({ ...s, branches: Array.from({ length: 7 }, (_, n) => ({ ...branches[0], name: `b${n}` })) })).length, "more than six");
  const picked = pickState(state(s)).cards["two-parts"].branches;
  assert.deepEqual(picked, branches);
  assert.notEqual(picked[0], branches[0], "a fresh copy, not the input's record");
});

test("the Worker stores a change in one branch's phase", () => {
  const { repo } = scratch();
  const s = cardState({ id: "two-parts", num: 610 }, repo(), cfg, T);
  const state = (card) => ({ v: 1, board: { boardId: "TestBoard01", at: T, probe: null, pageVersion: null }, agents: {}, cards: { "two-parts": card } });
  const moved = { ...s, branches: [s.branches[0], { ...s.branches[1], phase: "ship" }] };
  assert.notEqual(changeKey(pickState(state(s))), changeKey(pickState(state(moved))));
  assert.equal(changeKey(pickState(state(s))), changeKey(pickState(state({ ...s, at: T + 99, branches: s.branches.map((b) => ({ ...b, ciMin: 9 })) }))), "times and ciMin do not make a write");
});

// The page: a card with two branches draws one track per branch, each with one tile "now" and its own evidence.
function row(branches, extra = {}) {
  const b = loadNames(["initRow", "liveCard", "probeEvent"]);
  Object.assign(b.state, { steps: [], derived: [], todo: [], ideas: [], waiting: [], messages: [], threads: [] });
  const card = { id: "two-parts", num: 610, name: "Two parts", size: "M", status: "active", phase: "build", createdAt: Date.now() - 6e4, etaLive: Date.now() + 36e5 };
  Object.assign(b.state, { initRaw: [card], initiatives: [card] });
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 20e3 }, cards: { "two-parts": { headSha12: "a1b2c3d4e5f6", onMain: false, phase: "checker", ...(branches ? { branches } : {}), ...extra } }, agents: {} } } });
  return b.initRow(card);
}
const rec = (name, phase, seen, sha = "a1b2c3d4e5f6") => ({ name, phase, headSha12: sha, onMain: false, seen });

test("the page draws one track per branch, each with a single tile now", () => {
  const html = row([rec("route", "security", ["build", "checker", "security"]), rec("picker", "build", ["build"], "b1b2c3d4e5f6")]);
  assert.match(html, /<div class="br-tracks">/);
  assert.equal((html.match(/class="track br-track"/g) ?? []).length, 2);
  const names = [...html.matchAll(/class="br-name"[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(names, ["route", "picker"]);
  for (const part of html.split('class="br-name"').slice(1)) assert.equal((part.match(/class="step now/g) ?? []).length, 1, "one phase lit per row");
  const [route, picker] = html.split('class="br-name"').slice(1);
  assert.match(route, /class="step now"[^>]*>Security</, "route is at security");
  assert.match(picker, /class="step now"[^>]*>Build</, "picker is at build");
  assert.doesNotMatch(picker, /class="step done[^"]*"[^>]*>Checker</, "the other branch's sign-off does not light picker's tile");
});

test("a card with one branch, or a probe without branches, draws the single track as before", () => {
  for (const html of [row(null), row([rec("route", "security", ["build"])]), row([rec("route", "security", ["build"]), { name: "Bad Name", phase: "build", headSha12: "nothex" }])]) {
    assert.doesNotMatch(html, /br-track/);
    assert.equal((html.match(/<div class="track">/g) ?? []).length, 1);
  }
});

test("the page skips an odd branch record and keeps the good ones", () => {
  const b = loadNames(["liveCard", "probeEvent"]);
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 20e3 }, cards: { "two-parts": { headSha12: "a1b2c3d4e5f6", onMain: false, phase: "checker", branches: [rec("route", "security", ["build"]), rec("route", "build", []), rec("picker", "nonsense", []), rec("third", "build", ["build"], "c1b2c3d4e5f6")] } }, agents: {} } } });
  assert.deepEqual(b.liveCard("two-parts").branches.map((x) => x.name), ["route", "third"], "a repeat name and an unknown phase are dropped");
});
