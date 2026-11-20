// #C1387 (failed-reads-say-unknown, half 1: main, deploy, version and the stack): a git or GitHub read that FAILS is never read as "no". The collector names the source in the card's
// `unread`, the Worker's reading says `unknown` with a why naming it (never working, never done), and git's exit 1 stays the plain "no". Real git; a wrapper makes one call fail.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState, cardStates, remoteTips, deployedSha, landedOn, trailerHead, shipCitedHead } from "../collector/state.mjs";
import { stateErrors, UNREAD_SOURCES } from "../collector/state-schema.mjs";
import { reading } from "../worker/reading.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });
const NOW = (T0 + 1000) * 1000;
const RCFG = { repos: [{ name: "flight-board", kind: "board" }] };
const lower = { id: "c1-lower", num: 1, level: "Quick", repo: "flight-board" }, top = { id: "c2-top", num: 2, level: "Quick", repo: "flight-board" };
const read = (card, e) => reading(card, e, [], {}, RCFG, NOW, {});
const err = (status) => Object.assign(new Error("git failed"), { status });

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-unread-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const commit = (t, file, msg) => { at = T0 + t; appendFileSync(join(work, file), `${t}\n`); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  // fail(args) -> a git exit status to throw for that call, or 0/undefined to run it for real; over: fields of the repository (live, versionPattern, ...)
  const repo = (fail = () => 0, over = {}) => {
    const git = (a) => { const st = fail(a); if (st) throw err(st); return g(a); };
    return { git, remote: "origin", main: "main", notes: NOTES, tips: remoteTips((a) => g(a), "origin"), live: null, versionPattern: null, ...over };
  };
  return { g, commit, sync, repo };
}
const isAnc = (a, x, y) => a[0] === "merge-base" && a[1] === "--is-ancestor" && (x === undefined || a[2] === x) && (y === undefined || a[3] === y);

// A card whose branch was merged into main and deleted (the common case), optionally with a version commit after it on main.
function landed({ version = false } = {}) {
  const s = scratch();
  s.g(["checkout", "-qb", "build/c1-lower"]);
  const w = s.commit(10, "a.md", "Work\n\nBoard-Id: c1-lower");
  s.g(["checkout", "-q", "main"]); s.g(["merge", "-q", "--ff-only", "build/c1-lower"]);
  const v = version ? s.commit(20, "v.md", "v1.2.3: ship it") : null;
  s.sync();
  s.g(["push", "-q", "origin", "--delete", "build/c1-lower"]); s.g(["fetch", "-q", "--prune", "origin"]);
  return { s, w, v, base: s.g(["rev-parse", `${w}^`]).trim() };
}
// A card with a branch that main has not reached.
function open() {
  const s = scratch();
  s.g(["checkout", "-qb", "build/c1-lower"]);
  const w = s.commit(10, "a.md", "Work\n\nBoard-Id: c1-lower");
  s.g(["checkout", "-q", "main"]); s.sync();
  return { s, w };
}
const unknownBecause = (r, word) => { assert.equal(r.state, "unknown"); assert.equal(r.working, false); assert.match(r.why, new RegExp(word)); };

test("the schema: `unread` is a list of known source words, optional, carried by pickState, and nothing else fits", () => {
  const card = { num: 1, phase: "ship", headSha12: null, signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: NOW };
  const state = (c) => ({ v: 1, id: "t", cards: { k: c } });
  assert.deepEqual(stateErrors(state({ ...card, unread: ["main", "deploy"] })).filter((e) => /unread/.test(e)), []);
  for (const bad of [[], ["nowhere"], ["main", "main"], "main", [1], UNREAD_SOURCES.concat("main")]) assert.notDeepEqual(stateErrors(state({ ...card, unread: bad })).filter((e) => /unread/.test(e)), [], JSON.stringify(bad));
  assert.deepEqual(stateErrors(state(card)).filter((e) => /unread/.test(e)), [], "a card with none still fits");
  for (const w of ["main", "deploy", "version", "stack", "start", "behind"]) assert.ok(UNREAD_SOURCES.includes(w), w);
});

test("main: a failed 'is the tip on main' call is unread main, never 'not on main'; exit 1 is the plain no; a good read is unchanged", () => {
  const { s, w } = landed();
  const bad = cardState(lower, s.repo((a) => isAnc(a, w, "origin/main") && 128), cfg, NOW);
  assert.equal(bad.onMain, false);
  assert.ok(bad.unread.includes("main"), JSON.stringify(bad.unread));
  unknownBecause(read(lower, bad), "main");
  const good = cardState(lower, s.repo(), cfg, NOW);
  assert.equal(good.onMain, true); assert.equal(good.unread, undefined);
  assert.notEqual(read(lower, good).state, "unknown");
  const o = open();
  const no = cardState(lower, o.s.repo(), cfg, NOW);
  assert.equal(no.onMain, false); assert.equal(no.unread, undefined, "exit 1 says no, and nothing is unread");
  assert.notEqual(read(lower, no).state, "unknown");
  const timeout = cardState(lower, o.s.repo((a) => isAnc(a, o.w, "origin/main") && 124), cfg, NOW);
  assert.ok(timeout.unread.includes("main"), "any status but 1 is a failed read");
});

test("main: a failed landed-as-other-commits search (landedOn) is unread main, not 'not landed'", () => {
  const { s, w } = open();
  assert.equal(landedOn((a) => s.g(a), "origin/main", w, {}, {}), null);
  const note = {};
  assert.equal(landedOn((a) => { throw err(128); }, "origin/main", w, {}, note), null);
  assert.equal(note.failed, true);
  const note2 = {}; landedOn((a) => s.g(a), "origin/main", w, {}, note2);
  assert.equal(note2.failed, undefined, "a search that finds nothing is not a failure");
  const bad = cardState(lower, s.repo((a) => a[0] === "rev-list" && a.includes(`^origin/main`) && !a.includes("--max-count=400") && 128), cfg, NOW);
  assert.ok(bad.unread?.includes("main"), JSON.stringify(bad));
  unknownBecause(read(lower, bad), "main");
});

test("main: a failed search for the card's commit on main (trailerHead) is unread main for a card with no branch left; no commit found is plain none", () => {
  const { s } = landed();
  const isLog = (a) => a[0] === "log" && a.some((x) => String(x).startsWith("--grep=Board-Id: c1-lower"));
  const bad = cardState(lower, s.repo((a) => isLog(a) && 128), cfg, NOW);
  assert.ok(bad.unread.includes("main"), JSON.stringify(bad));
  unknownBecause(read(lower, bad), "main");
  const note = {};
  assert.equal(trailerHead({ ...s.repo((a) => isLog(a) && 128) }, "c1-lower", "main", 400, note), null);
  assert.equal(note.failed, true);
  const ghost = cardState({ id: "ghost", num: 9, repo: "flight-board" }, s.repo(), cfg, NOW);
  assert.equal(ghost.unread, undefined, "no commit carries the id: none, not unread");
  assert.equal(read({ id: "ghost", repo: "flight-board" }, ghost).state, "queued");
  const ghostBad = cardState({ id: "ghost", num: 9, repo: "flight-board" }, s.repo((a) => a[0] === "log" && a.some((x) => String(x).startsWith("--grep=Board-Id: ghost")) && 128), cfg, NOW);
  assert.deepEqual(ghostBad.unread, ["main"]);
  unknownBecause(read({ id: "ghost", repo: "flight-board" }, ghostBad), "main");
});

test("main: a failed read of the ship lines on main (shipCitedHead) says failed; a log with no ship line citing the card is the plain none", () => {
  const { s } = landed();
  const pattern = "^v[0-9.]+: ([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})";
  const note = {};
  assert.equal(shipCitedHead(s.repo((a) => a[0] === "log" && 128, { shippedPattern: pattern }), { id: "c1-lower", num: 1 }, note), null);
  assert.equal(note.failed, true);
  const fine = {};
  assert.equal(shipCitedHead(s.repo(() => 0, { shippedPattern: pattern }), { id: "c1-lower", num: 1 }, fine), null);
  assert.equal(fine.failed, undefined);
  // a branch named for the card whose tip carries no Board-Id trailer: the ship lines on main are read for it
  const b = scratch();
  b.g(["checkout", "-qb", "build/c1-lower"]); b.commit(10, "a.md", "Work with no trailer"); b.g(["checkout", "-q", "main"]); b.sync();
  const ship = (a) => a[0] === "log" && a.includes("--first-parent") && a.includes("--format=%s");
  const bad = cardState(lower, b.repo((a) => ship(a) && 128, { shippedPattern: pattern }), cfg, NOW);
  assert.ok(bad.unread?.includes("main"), JSON.stringify(bad.unread));
  unknownBecause(read(lower, bad), "main");
  assert.equal(cardState(lower, b.repo(() => 0, { shippedPattern: pattern }), cfg, NOW).unread, undefined);
});

test("deploy: a failed 'is the head in the live commit' call is unread deploy, not 'not deployed'; exit 1 is the plain no; a good read is live", () => {
  const { s, w } = landed();
  const sha = w;
  const bad = cardState(lower, s.repo((a) => isAnc(a, sha, sha) && 128, { live: sha }), cfg, NOW);
  assert.equal(bad.onMain, true); assert.deepEqual(bad.unread, ["deploy"]);
  unknownBecause(read(lower, bad), "deploy");
  const good = cardState(lower, s.repo(() => 0, { live: sha }), cfg, NOW);
  assert.equal(good.phase, "live"); assert.equal(good.unread, undefined);
  assert.equal(read(lower, good).state, "done");
  const no = cardState(lower, s.repo((a) => isAnc(a, sha, sha) && 1, { live: sha }), cfg, NOW);
  assert.equal(no.phase, "ship"); assert.equal(no.unread, undefined, "exit 1 says not deployed, nothing unread");
  assert.notEqual(read(lower, no).state, "unknown");
});

test("deploy: a live commit that could not be read at all (repo.liveUnread) is unread deploy for a card on main; no live commit and no failure is the plain 'not deployed'", () => {
  const { s } = landed();
  const bad = cardState(lower, s.repo(() => 0, { live: null, liveUnread: true }), cfg, NOW);
  assert.deepEqual(bad.unread, ["deploy"]);
  unknownBecause(read(lower, bad), "deploy");
  const none = cardState(lower, s.repo(() => 0, { live: null }), cfg, NOW);
  assert.equal(none.unread, undefined); assert.equal(none.phase, "ship");
  const o = open();
  const open1 = cardState(lower, o.s.repo(() => 0, { live: null, liveUnread: true }), cfg, NOW);
  assert.equal(open1.unread, undefined, "a card not on main does not rest on the deploy");
  const src = readFileSync(new URL("../collector/state.mjs", import.meta.url), "utf8");
  assert.match(src, /catch \{ liveUnread = true; \}/, "the run's deploy-run read marks a failure");
  assert.match(src, /\.\.\.\(liveUnread \? \{ liveUnread: true \} : \{\}\)/);
});

test("deploy: deployedSha says a failed ancestry question apart from two commits on different lines", () => {
  const { s, w, base } = landed();
  const git = (fail) => (a) => { if (fail && a[0] === "merge-base") throw err(fail); return s.g(a); };
  const n1 = {}; assert.equal(deployedSha(git(0), base, w, n1), base); assert.equal(n1.failed, undefined);
  const n2 = {}; assert.equal(deployedSha(git(128), base, w, n2), null); assert.equal(n2.failed, true);
  const n3 = {}; assert.equal(deployedSha(git(1), base, w, n3), null, "exit 1 both ways: on different lines, null as before"); assert.equal(n3.failed, undefined);
  assert.equal(deployedSha(git(128), base, w), null, "no note given: the answer is the same");
});

test("version: a failed version read is unread version, not 'no version commit yet'; a missing version commit is the plain no; a good read carries the version", () => {
  const { s, w, v } = landed({ version: true });
  const over = { live: v, versionPattern: "^v(\\d+\\.\\d+\\.\\d+)" };
  const bad = cardState(lower, s.repo((a) => a[0] === "rev-list" && a.includes("--ancestry-path") && 128, over), cfg, NOW);
  assert.deepEqual(bad.unread, ["version"]);
  unknownBecause(read(lower, bad), "version");
  const good = cardState(lower, s.repo(() => 0, over), cfg, NOW);
  assert.equal(good.liveVersion, "1.2.3"); assert.equal(good.unread, undefined);
  assert.equal(read(lower, good).state, "done");
  const none = cardState(lower, s.repo(() => 0, { ...over, live: w }), cfg, NOW);
  assert.equal(none.phase, "ship"); assert.equal(none.unread, undefined, "no version commit yet is a plain no");
  assert.notEqual(read(lower, none).state, "unknown");
});

test("behind main: a failed call answers neither: no re-cut and no state; exit 1 still sends the card back", () => {
  const sign = (s, sha) => { for (const [p, ref] of Object.entries(NOTES)) s.g(["notes", `--ref=${ref}`, "add", "-m", p === "security" ? "SECURE" : "PASS", sha]); };
  const mk = () => { const s = scratch(); s.g(["checkout", "-qb", "build/c1-lower"]); const own = s.commit(10, "a.md", "Work\n\nBoard-Id: c1-lower"); sign(s, own); s.g(["checkout", "-q", "main"]); s.commit(30, "m.md", "main moves on"); s.sync(); return { s, own }; };
  const { s, own } = mk();
  const behindCall = (a) => isAnc(a, "origin/main", own);
  const control = cardState(lower, s.repo(), cfg, NOW);
  assert.equal(control.phase, "ship"); assert.equal(control.behindMain, true, "exit 1: behind main, re-cut");
  assert.equal(control.unread, undefined);
  const bad = cardState(lower, s.repo((a) => behindCall(a) && 128), cfg, NOW);
  assert.equal(bad.behindMain, undefined, "a failed call is no re-cut");
  assert.deepEqual(bad.unread, ["behind"]);
  assert.notEqual(read(lower, bad).state, "unknown", "behind is a minor source: a flag, never the state");
  assert.deepEqual(stateErrors({ v: 1, id: "t", cards: { k: bad } }).filter((e) => /unread|behindMain/.test(e)), []);
});

test("start: a failed 'is it an empty start commit' call is unread start (a flag only), never 'empty'", () => {
  const { s } = open();
  const diff = (a) => a[0] === "diff" && a.includes("--quiet");
  const bad = cardState(lower, s.repo((a) => diff(a) && 128), cfg, NOW);
  assert.ok(bad.unread?.includes("start"));
  assert.equal(bad.wipHead, undefined);
  assert.notEqual(read(lower, bad).state, "unknown");
  const no = cardState(lower, s.repo((a) => diff(a) && 1), cfg, NOW);
  assert.equal(no.unread, undefined, "exit 1: it has changes: no");
  assert.equal(no.wipHead, undefined);
});

// A chain of two cards on one branch, the stack switch on.
function chain() {
  const s = scratch();
  s.g(["checkout", "-qb", "build/stack"]);
  s.commit(10, "a.md", "Work\n\nBoard-Id: c1-lower"); s.commit(20, "b.md", "Work\n\nBoard-Id: c2-top");
  s.g(["checkout", "-q", "main"]); s.sync();
  const run = (fail) => cardStates({ cards: [{ id: "c1-lower", num: 1 }, { id: "c2-top", num: 2 }], config: cfg, repos: { "": s.repo(fail) }, now: NOW, stacks: [""] });
  return { s, run };
}
const notMain = (a) => !a.includes("origin/main");

test("stack: a failed stack ancestry question is unread stack for every open card of the repository; exit 1 is the plain no; a good read is unchanged", () => {
  const { run } = chain();
  const good = run(() => 0);
  assert.equal(good["c1-lower"].unread, undefined); assert.ok(good["c1-lower"].stack, "control: the chain is one stack");
  const bad = run((a) => (isAnc(a) || (a[0] === "for-each-ref" && a.includes("--contains"))) && notMain(a) && 128);
  for (const id of ["c1-lower", "c2-top"]) { assert.deepEqual(bad[id].unread, ["stack"], id); unknownBecause(read({ id, repo: "flight-board" }, bad[id]), "stack"); }
  const no = run((a) => (isAnc(a) || (a[0] === "for-each-ref" && a.includes("--contains"))) && notMain(a) && 1);
  for (const id of ["c1-lower", "c2-top"]) assert.equal(no[id].unread, undefined, `${id}: exit 1 is no`);
});

test("stack: a failed read of the stack's branch commits (stackHeads) is unread stack", () => {
  const { run } = chain();
  const bad = run((a) => a[0] === "log" && a.includes("--not") && 128);
  for (const id of ["c1-lower", "c2-top"]) { assert.ok(bad[id].unread?.includes("stack"), id); unknownBecause(read({ id, repo: "flight-board" }, bad[id]), "stack"); }
  const badMerged = run((a) => a[0] === "for-each-ref" && a.includes("--merged") && 128);
  assert.ok(badMerged["c1-lower"].unread?.includes("stack"), "a failed merged-branches list is unread too, not 'none merged'");
});

test("stack: a failed read of a group's branches leaves its members unread stack, not 'not built'", () => {
  const s = scratch();
  s.g(["checkout", "-qb", "build/group"]);
  s.commit(10, "a.md", "Work\n\nBoard-Id: c1-lower"); s.commit(20, "b.md", "Work\n\nBoard-Id: c2-top");
  s.g(["checkout", "-q", "main"]); s.sync();
  const cards = [{ id: "c1-lower", num: 1, batch: "g1" }, { id: "c2-top", num: 2, batch: "g1" }];
  const run = (fail) => cardStates({ cards, config: cfg, repos: { "": s.repo(fail) }, now: NOW });
  const good = run(() => 0);
  assert.equal(good["c1-lower"].unread, undefined);
  const bad = run((a) => a[0] === "log" && a.includes("--not") && 128);
  assert.ok(bad["c1-lower"].unread?.includes("stack"), JSON.stringify(bad["c1-lower"]));
  unknownBecause(read({ id: "c1-lower", repo: "flight-board", batch: "g1" }, bad["c1-lower"]), "stack");
});

test("a minor source (start, behind) never makes a card unknown, and a stale reading keeps its own rule", () => {
  const e = { phase: "ship", headSha12: "a".repeat(12), onMain: false, signed: ["checker"], unread: ["start", "behind"] };
  assert.notEqual(read(lower, e).state, "unknown");
  assert.equal(read(lower, { ...e, unread: ["main"] }).state, "unknown");
  const stale = read(lower, { ...e, unread: ["main"], stale: true, staleSince: NOW - 60e3 });
  assert.notEqual(stale.state, "unknown", "no reading is both stale and unknown");
  assert.equal(stale.stale, true);
  assert.equal(read(lower, { ...e, unread: ["main", "deploy"] }).why, "could not read main and the live deploy");
  assert.equal(read(lower, { ...e, unread: ["main"], phase: "live" }).working, false);
});
