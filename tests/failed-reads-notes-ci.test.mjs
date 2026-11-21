// #C1395 (failed-reads-notes-ci, the second half of "a failed read answers unknown everywhere"; #C1387 did main, deploy, version and the stack): a failed read of the sign-off notes, of the install
// state, of the pair folder or of CI is never read as "no". A card whose sign-offs cannot be read, whose install state cannot be read (at the install wait) or whose pair folder cannot be read (at the pack
// and install waits) says `unknown`, naming the source; CI never turns a card unknown: its four words (none: no run exists; backoff, capped: no call made; unread: the call failed) are the card's `ci` and
// the ship tile's own words. Git's exit 1 stays the plain "no". Real git, one call made to fail; fictional names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState, cardStates, remoteTips, ciOf, ciReader, shipCandidate, teamShip, landingKind, MAX_CI_CALLS, BACKOFF_MIN_MS } from "../collector/state.mjs";
import { pairsIn, packOf, descends } from "../collector/pairs.mjs";
import { stateErrors, UNREAD_SOURCES, CI_STATES, SHIP_CI } from "../collector/state-schema.mjs";
import { reading } from "../worker/reading.mjs";
import { loadNames } from "./harness.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI", repos: [{ name: "flight-board", path: "/y", notes: NOTES }] } });
const NOW = (T0 + 1000) * 1000;
const RCFG = { repos: [{ name: "flight-board", kind: "board" }] };
const lower = { id: "c1-lower", num: 1, level: "Quick", repo: "flight-board", phase: "ship", status: "active" };
const read = (card, e) => reading(card, e, [], {}, RCFG, NOW, {});
const err = (status) => Object.assign(new Error("git failed"), { status });
const dirs = [];
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

function scratch() {
  const dir = tmp("fb-unread2-");
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  mkdirSync(join(work, "docs"));
  const commit = (t, file, msg) => { at = T0 + t; appendFileSync(join(work, file), `${t}\n`); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  const repo = (fail = () => 0, over = {}) => {
    const git = (a) => { const st = fail(a); if (st) throw err(st); return g(a); };
    return { git, remote: "origin", main: "main", notes: NOTES, tips: remoteTips((a) => g(a), "origin"), live: null, versionPattern: null, ...over };
  };
  return { g, commit, sync, repo };
}
const isNotesShow = (a) => a[0] === "notes" && a.includes("show");
// An open card: a branch main has not reached, signed by the checker.
function open() {
  const s = scratch();
  s.g(["checkout", "-qb", "build/c1-lower"]);
  const w = s.commit(10, "a.md", "Work\n\nBoard-Id: c1-lower");
  s.g(["notes", `--ref=${NOTES.checker}`, "add", "-m", "PASS", w]);
  s.g(["checkout", "-q", "main"]); s.sync();
  return { s, w };
}
// A card landed on main by a fast-forward; the file it changed decides whether it needs an install. keep: the branch stays.
function landed({ file = "a.md", keep = false } = {}) {
  const s = scratch();
  s.g(["checkout", "-qb", "build/c1-lower"]);
  const w = s.commit(10, file, "Work\n\nBoard-Id: c1-lower");
  s.g(["checkout", "-q", "main"]); s.g(["merge", "-q", "--ff-only", "build/c1-lower"]);
  s.sync();
  if (!keep) { s.g(["push", "-q", "origin", "--delete", "build/c1-lower"]); s.g(["fetch", "-q", "--prune", "origin"]); }
  return { s, w };
}
const unknownBecause = (r, word) => { assert.equal(r.state, "unknown"); assert.equal(r.working, false); assert.match(r.why, new RegExp(word)); };

test("the schema: the three CI reasons are card and ship values, 'failed' is still only the run's own result, and notes, install, pair, ci are unread sources", () => {
  for (const w of ["notes", "install", "pair", "ci"]) assert.ok(UNREAD_SOURCES.includes(w), w);
  for (const w of ["backoff", "capped", "unread"]) { assert.ok(CI_STATES.includes(w), `card ci ${w}`); assert.ok(SHIP_CI.includes(w), `ship ci ${w}`); }
  assert.equal(SHIP_CI.includes("failed"), false); assert.equal(SHIP_CI.includes("cancelled"), false);
  const card = { num: 1, phase: "ship", headSha12: null, signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: NOW };
  const state = (c, ship) => ({ v: 1, id: "t", cards: { k: c }, ...(ship ? { ship } : {}) });
  for (const ci of CI_STATES) assert.deepEqual(stateErrors(state({ ...card, ci })).filter((e) => /\.ci/.test(e)), [], `card ci ${ci}`);
  assert.notDeepEqual(stateErrors(state({ ...card, ci: "nowhere" })).filter((e) => /\.ci/.test(e)), []);
  assert.deepEqual(stateErrors(state({ ...card, unread: ["notes", "install", "pair", "ci"] })).filter((e) => /unread/.test(e)), []);
  for (const ci of SHIP_CI) assert.deepEqual(stateErrors(state(card, { version: "1.2.3", ci, at: NOW })).filter((e) => /ship/.test(e)), [], `ship ci ${ci}`);
  assert.notDeepEqual(stateErrors(state(card, { version: "1.2.3", ci: "failed", at: NOW })).filter((e) => /ship/.test(e)), []);
});

test("notes: a failed `git notes show` is unread notes, never 'no sign-off'; exit 1 (no note) is the plain no; a good read is unchanged", () => {
  const { s, w } = open();
  const bad = cardState(lower, s.repo((a) => isNotesShow(a) && 128), cfg, NOW);
  assert.deepEqual(bad.signed, []);
  assert.deepEqual(bad.unread, ["notes"]);
  unknownBecause(read(lower, bad), "sign-offs");
  const good = cardState(lower, s.repo(), cfg, NOW);
  assert.deepEqual(good.signed, ["checker"]); assert.equal(good.unread, undefined);
  assert.notEqual(read(lower, good).state, "unknown");
  const no = cardState(lower, s.repo((a) => isNotesShow(a) && 1), cfg, NOW);
  assert.deepEqual(no.signed, []); assert.equal(no.unread, undefined, "exit 1: git says there is no note");
  assert.notEqual(read(lower, no).state, "unknown");
  const timeout = cardState(lower, s.repo((a) => isNotesShow(a) && 124), cfg, NOW);
  assert.deepEqual(timeout.unread, ["notes"], "any status but 1 is a failed read");
  // a commit no review annotated is not asked at all, and a spawn that throws with no status at all is a failed read too
  const noStatus = cardState(lower, { ...s.repo(), git: (a) => { if (isNotesShow(a)) throw new Error("spawn failed"); return s.g(a); } }, cfg, NOW);
  assert.deepEqual(noStatus.unread, ["notes"], `${w.slice(0, 7)}: an error with no status is unread`);
});

test("notes: a failed read leaves a card on main alone (it rests on the deploy, not its sign-offs); the findings and the counters read the same way", () => {
  const { s } = landed();
  const bad = cardState(lower, s.repo((a) => isNotesShow(a) && 128), cfg, NOW);
  assert.equal(bad.onMain, true); assert.equal(bad.unread, undefined, "a card on main is not unknown for its sign-offs");
  const o = open();
  // the findings read (and the issue counters) go through the same notes read: one failure, one source
  const bad2 = cardState(lower, o.s.repo((a) => isNotesShow(a) && 128), cfg, NOW);
  assert.deepEqual(bad2.unread, ["notes"]);
});

test("install: a failed read of the card's landing is unread install, never 'waits for install'; a code landing is the plain wait; a docs landing is live", () => {
  const isDiff = (a) => a[0] === "diff" && a.includes("--name-only") && a.some((x) => /\^$/.test(String(x)));
  const d = landed({ file: "docs/x.md" });
  const good = cardState(lower, d.s.repo(), cfg, NOW);
  assert.equal(good.noInstall, true); assert.equal(good.phase, "live"); assert.equal(good.unread, undefined);
  assert.equal(read(lower, good).state, "done");
  const bad = cardState(lower, d.s.repo((a) => isDiff(a) && 128), cfg, NOW);
  assert.equal(bad.onMain, true); assert.equal(bad.noInstall, undefined); assert.equal(bad.phase, "ship");
  assert.deepEqual(bad.unread, ["install"]);
  unknownBecause(read(lower, bad), "install");
  // the code landing: a diff that names a deployed path needs the install, and nothing is unread
  const c = landed({ file: "worker.mjs" });
  const code = cardState(lower, c.s.repo(), cfg, NOW);
  assert.equal(code.noInstall, undefined); assert.equal(code.phase, "ship"); assert.equal(code.unread, undefined, "needs an install: a plain wait");
  assert.notEqual(read(lower, code).state, "unknown");
  // a card already live (the deploy holds it) does not rest on the install state
  const live = cardState(lower, d.s.repo((a) => isDiff(a) && 128, { live: d.w }), cfg, NOW);
  assert.equal(live.phase, "live"); assert.equal(live.unread, undefined, "deployed: no install wait to be unknown at");
  // the search for the card's commits on main failing is unread install too
  const k = landed({ file: "docs/x.md", keep: true });
  const cardLog = (a) => a[0] === "log" && a.includes("--format=%H%x1f%B%x1e");
  const bad2 = cardState(lower, k.s.repo((a) => cardLog(a) && 128), cfg, NOW);
  assert.deepEqual(bad2.unread, ["install"]);
  assert.deepEqual(cardState(lower, k.s.repo(), cfg, NOW).unread, undefined);
});

test("install: landingKind says a failed diff apart from a value that is no sha", () => {
  const sha = "a".repeat(40);
  const n1 = {}; assert.equal(landingKind(() => { throw err(128); }, sha, n1), "unread"); assert.equal(n1.failed, true);
  const n2 = {}; assert.equal(landingKind(() => "docs/x.md\n", sha, n2), "docs"); assert.equal(n2.failed, undefined);
  const n3 = {}; assert.equal(landingKind(() => { throw err(128); }, "not-a-sha", n3), "unread"); assert.equal(n3.failed, undefined, "no sha: nothing was read, nothing failed");
  assert.equal(landingKind(() => { throw err(128); }, sha), "unread", "no note given: the answer is the same");
});

test("pair folder: an unreadable folder or file is a failed read, a missing folder is none, a good one is unchanged", () => {
  const A = "a".repeat(40), B = "b".repeat(40);
  const dir = tmp("pairs2-");
  writeFileSync(join(dir, "board-store-deploy-pc7.mjs"), `const SIGNED = "${A}";\n`);
  writeFileSync(join(dir, "board-store-deploy-pc7.done"), `${A}\n`);
  const ok = {};
  assert.deepEqual(pairsIn(dir, ok).map((p) => ({ ...p })), [{ n: 7, sha: A, ran: true }]); assert.equal(ok.failed, undefined);
  const gone = {};
  assert.deepEqual(pairsIn(join(dir, "nope"), gone), []); assert.equal(gone.failed, undefined, "no folder: none, nothing failed");
  assert.deepEqual(pairsIn("", gone), []); assert.equal(gone.failed, undefined);
  // a .done that cannot be read is not "not run"
  const d2 = tmp("pairs2-");
  writeFileSync(join(d2, "board-store-deploy-pc8.mjs"), `const SIGNED = "${B}";\n`);
  mkdirSync(join(d2, "board-store-deploy-pc8.done"));
  const n2 = {};
  assert.deepEqual(pairsIn(d2, n2).map((p) => ({ ...p })), [{ n: 8, sha: B, ran: false }]); assert.equal(n2.failed, true);
  // a deploy file that cannot be read
  const d3 = tmp("pairs2-");
  mkdirSync(join(d3, "board-store-deploy-pc9.mjs"));
  const n3 = {};
  assert.deepEqual(pairsIn(d3, n3), []); assert.equal(n3.failed, true);
  assert.deepEqual(pairsIn(d3), [], "no note given: the answer is the same");
  // a folder that cannot be listed (not as root, which reads anything)
  if (process.getuid && process.getuid() !== 0) {
    const d4 = tmp("pairs2-"); writeFileSync(join(d4, "board-store-deploy-pc1.mjs"), `const SIGNED = "${A}";\n`);
    chmodSync(d4, 0o000);
    try { const n4 = {}; assert.deepEqual(pairsIn(d4, n4), []); assert.equal(n4.failed, true); } finally { chmodSync(d4, 0o700); }
  }
});

test("pair folder: descends and packOf say a failed git question apart from exit 1", () => {
  const A = "a".repeat(40), B = "b".repeat(40);
  const answer = (status) => () => ({ status });
  for (const [status, failed, holds] of [[0, undefined, true], [1, undefined, false], [128, true, false], [null, true, false]]) {
    const n = {};
    assert.equal(descends(answer(status), A, B, n), holds, `status ${status}`); assert.equal(n.failed, failed, `status ${status}`);
  }
  const n = {}; assert.equal(descends(() => { throw new Error("no git"); }, A, B, n), false); assert.equal(n.failed, true);
  assert.equal(descends(() => { throw new Error("no git"); }, A, B), false, "no note: no is still the answer");
  const pn = {};
  assert.deepEqual({ ...packOf([{ n: 3, sha: B, ran: true }], A, answer(128), pn) }, { packed: false, installed: false }); assert.equal(pn.failed, true);
  const pn1 = {};
  assert.deepEqual({ ...packOf([{ n: 3, sha: B, ran: true }], A, answer(1), pn1) }, { packed: false, installed: false }); assert.equal(pn1.failed, undefined, "exit 1 is the plain 'not packed'");
  const pn0 = {};
  assert.deepEqual({ ...packOf([{ n: 3, sha: B, ran: true }], A, answer(0), pn0) }, { packed: true, installed: true, pack: 3 }); assert.equal(pn0.failed, undefined);
});

// A board card landed on main (its commit is a code file), then main moves on: a pair pinned at the later commit holds the landing.
function packed() {
  const s = scratch();
  const w = s.commit(10, "worker.mjs", "Work\n\nBoard-Id: c1-lower");
  const m2 = s.commit(20, "other.mjs", "main moves on");
  s.sync();
  const dir = tmp("pairs2-");
  writeFileSync(join(dir, "board-store-deploy-pc40.mjs"), `const SIGNED = "${m2}";\n`);
  const run = (fail, over = {}, extra = {}) => cardStates({ cards: [lower], config: cfg, repos: { "flight-board": s.repo(fail, over) }, now: NOW, pairs: pairsIn(dir), ...extra });
  return { s, w, m2, run };
}

test("pair folder: a failed git question about a pair is unread pair at the pack wait, never 'not packed'; exit 1 is the plain no; a good read packs the card", () => {
  const { w, m2, run } = packed();
  const ask = (a) => a[0] === "merge-base" && a[2] === w && a[3] === m2;
  const good = run(() => 0)["c1-lower"];
  assert.equal(good.onMain, true); assert.equal(good.packed, true); assert.equal(good.pack, 40); assert.equal(good.unread, undefined);
  const bad = run((a) => ask(a) && 128)["c1-lower"];
  assert.equal(bad.packed, undefined); assert.deepEqual(bad.unread, ["pair"]);
  unknownBecause(read(lower, bad), "deploy pairs");
  const no = run((a) => ask(a) && 1)["c1-lower"];
  assert.equal(no.packed, undefined); assert.equal(no.unread, undefined, "exit 1: the pair does not hold the landing");
  assert.notEqual(read(lower, no).state, "unknown");
  assert.equal(read(lower, no).wait, "pack");
});

test("pair folder: a folder that could not be read is unread pair for a board card waiting at pack or install; a live card and a product card are not marked", () => {
  const { w, run } = packed();
  const bad = run(() => 0, {}, { pairs: [], pairsUnread: true })["c1-lower"];
  assert.equal(bad.packed, undefined); assert.deepEqual(bad.unread, ["pair"]);
  unknownBecause(read(lower, bad), "deploy pairs");
  const none = run(() => 0, {}, { pairs: [], pairsUnread: false })["c1-lower"];
  assert.equal(none.unread, undefined, "no pair at all and nothing failed: the plain 'not packed'");
  const live = run(() => 0, { live: w }, { pairs: [], pairsUnread: true })["c1-lower"];
  assert.equal(live.phase, "live"); assert.equal(live.unread, undefined, "a live card rests on neither");
  const s = scratch(); s.commit(10, "worker.mjs", "Work\n\nBoard-Id: c1-lower"); s.sync();
  const shop = { ...lower, repo: "shopsite" };
  const out = cardStates({ cards: [shop], config: fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI", repos: [{ name: "flight-board", path: "/y", notes: NOTES }, { name: "shopsite", path: "/z", notes: NOTES }] } }), repos: { "flight-board": s.repo(), shopsite: s.repo() }, now: NOW, pairs: [], pairsUnread: true });
  assert.equal(out["c1-lower"].unread, undefined, "a product card never reads the pair folder");
});

test("the Worker: notes, install and pair make a card unknown, naming the source; ci, start and behind never do", () => {
  const e = { phase: "ship", headSha12: "a".repeat(12), onMain: false, signed: ["checker"] };
  assert.equal(read(lower, { ...e, unread: ["notes"] }).why, "could not read the sign-offs");
  assert.equal(read(lower, { ...e, unread: ["install"], onMain: true, packed: true, installed: false }).why, "could not read the install state");
  assert.equal(read(lower, { ...e, unread: ["pair"], onMain: true }).why, "could not read the deploy pairs");
  assert.equal(read(lower, { ...e, unread: ["main", "notes"] }).why, "could not read main and the sign-offs");
  assert.notEqual(read(lower, { ...e, unread: ["ci"], ci: "unread" }).state, "unknown", "CI is the ship tile's own state, never a card's");
  assert.notEqual(read(lower, { ...e, unread: ["start", "behind", "ci"] }).state, "unknown");
  const live = read(lower, { ...e, phase: "live", onMain: true, unread: ["pair", "install"] });
  assert.equal(live.state, "done", "a live card is done whatever it could not read of the waits before");
  const stale = read(lower, { ...e, unread: ["notes"], stale: true, staleSince: NOW - 60e3 });
  assert.notEqual(stale.state, "unknown", "no reading is both stale and unknown");
});

test("CI: ciOf says a failed call is 'unread', an answer with no run is 'none', a run its own word", () => {
  const run = { status: "completed", conclusion: "success", createdAt: new Date(NOW - 5 * 60e3).toISOString(), updatedAt: new Date(NOW - 2 * 60e3).toISOString() };
  const bad = ciOf(() => { throw new Error("rate limit"); }, "a".repeat(40), NOW);
  assert.equal(bad.ci, "unread"); assert.equal(bad.failed, true);
  assert.equal(ciOf(() => "not json", "a".repeat(40), NOW).ci, "unread", "an answer that is no list is a failed read");
  assert.deepEqual(ciOf(() => "[]", "a".repeat(40), NOW), { ci: "none", ciMin: null }, "gh answered: no run exists");
  assert.equal(ciOf(() => JSON.stringify([run]), "a".repeat(40), NOW).ci, "passed");
  assert.equal(ciOf(() => JSON.stringify([{ ...run, conclusion: "failure" }]), "a".repeat(40), NOW).ci, "failed", "failed is the run's own result");
});

test("CI: the reader says backoff, capped or unread for a call not made or failed, and none only when no run exists", () => {
  const sha = (n) => String(n).padStart(40, "0");
  const run = (s) => ({ headSha: s, status: "completed", conclusion: "success", createdAt: new Date(NOW - 5 * 60e3).toISOString(), updatedAt: new Date(NOW - 2 * 60e3).toISOString() });
  // a failed batch list: unread for the card that asked, backoff for the next (the failure started the wait)
  const backoff = { until: 0, wait: BACKOFF_MIN_MS };
  const bad = ciReader(() => { throw new Error("rate limit"); }, NOW, {}, backoff, { batch: true });
  assert.equal(bad(sha(1)).ci, "unread"); assert.equal(bad(sha(2)).ci, "backoff");
  assert.equal(backoff.until, NOW + BACKOFF_MIN_MS);
  // while a back-off lasts nothing is asked
  const asked = [];
  const held = ciReader((a) => { asked.push(a); return "[]"; }, NOW + 1000, {}, backoff, { batch: true });
  assert.equal(held(sha(3)).ci, "backoff"); assert.equal(asked.length, 0);
  // a failed single call (no batch) is unread, and the back-off starts
  const b2 = { until: 0, wait: BACKOFF_MIN_MS };
  const single = ciReader(() => { throw new Error("boom"); }, NOW, {}, b2);
  assert.equal(single(sha(1)).ci, "unread"); assert.equal(single(sha(2)).ci, "backoff");
  // the call limit: the commits past it are capped, with and without the batch list
  const lacking = (a) => (a.includes("--commit") ? JSON.stringify([{ status: "in_progress", conclusion: "", createdAt: new Date(NOW).toISOString() }]) : "[]");
  const capped = ciReader(lacking, NOW, {}, undefined, { batch: true }), out = [];
  for (let n = 0; n < MAX_CI_CALLS + 3; n++) out.push(capped(sha(n + 1)).ci);
  assert.deepEqual(out.slice(-3), ["capped", "capped", "capped"]); assert.ok(out.slice(0, MAX_CI_CALLS - 1).every((c) => c === "running"));
  const per = ciReader(() => JSON.stringify([run(sha(1))]), NOW, {}), got = [];
  for (let n = 0; n < MAX_CI_CALLS + 2; n++) got.push(per(sha(n + 1)).ci);
  assert.deepEqual(got.slice(-2), ["capped", "capped"]);
  // no run exists: gh answers with an empty list, and that is the only "none"
  assert.equal(ciReader(() => "[]", NOW, {})(sha(1)).ci, "none");
  assert.equal(ciReader(() => "[]", NOW, {}, undefined, { batch: true })(sha(1)).ci, "none");
  // a good read is unchanged
  assert.deepEqual(ciReader(() => JSON.stringify([run(sha(1))]), NOW, {}, undefined, { batch: true })(sha(1)), { ci: "passed", ciMin: 3 });
});

test("CI: a card's own ci carries the word, and only a failed call sets the unread flag; the card is never unknown for it", () => {
  const { s } = open();
  const fail = cardState(lower, { ...s.repo(), gh: () => { throw new Error("rate limit"); } }, cfg, NOW);
  assert.equal(fail.ci, "unread"); assert.deepEqual(fail.unread, ["ci"]);
  assert.notEqual(read(lower, fail).state, "unknown");
  const none = cardState(lower, { ...s.repo(), gh: () => "[]" }, cfg, NOW);
  assert.equal(none.ci, "none"); assert.equal(none.unread, undefined);
  for (const word of ["backoff", "capped"]) {
    const c = cardState(lower, { ...s.repo(), ci: () => ({ ci: word, ciMin: null }) }, cfg, NOW);
    assert.equal(c.ci, word); assert.equal(c.unread, undefined, `${word}: a call not made is no failed read`);
    assert.deepEqual(stateErrors({ v: 1, id: "t", cards: { k: c } }).filter((e) => /\.ci/.test(e)), []);
  }
});

test("the ship candidate: the four CI words pass through, an answer that is none of them is unread, a failed or cancelled run is gone", () => {
  const SHA = "e3016d3" + "0".repeat(33), pattern = "^build/ship-v\\d+\\.\\d+\\.\\d+$";
  const tips = [{ branch: "build/ship-v1.226.23", sha: SHA, at: NOW - 60e3, message: "" }];
  const cand = (ci, onMain = () => false) => shipCandidate({ tips, pattern, now: NOW, onMain, ci });
  for (const word of ["none", "backoff", "capped", "unread", "queued", "running", "passed"]) assert.equal(cand(() => ({ ci: word, ciMin: null })).ci, word, word);
  for (const odd of [null, undefined, {}, { ci: "weird" }, { ci: 5 }]) assert.equal(cand(() => odd).ci, "unread", JSON.stringify(odd));
  assert.equal(cand(() => ({ ci: "failed" })), null); assert.equal(cand(() => ({ ci: "cancelled" })), null);
  for (const word of ["none", "backoff", "capped", "unread"]) assert.deepEqual(stateErrors({ v: 1, id: "t", cards: {}, ship: cand(() => ({ ci: word })) }).filter((e) => /ship/.test(e)), [], word);
});

test("the ship candidate: a failed 'is it on main' call keeps the candidate and marks it stale; exit 1 is the plain 'not on main'; on main it is gone", () => {
  const SHA = "e3016d3" + "0".repeat(33);
  const git = (status) => (a) => { if (a[0] === "merge-base") { if (status) throw err(status); return ""; } return ""; };
  const team = (status) => ({ git: git(status), remote: "origin", main: "main", tips: [{ branch: "build/ship-v1.226.23", sha: SHA, at: NOW - 60e3, message: "" }], ci: () => ({ ci: "running", ciMin: null }), live: null });
  const c = { candidatePattern: "^build/ship-v\\d+\\.\\d+\\.\\d+$", versionPattern: "" };
  const unread = teamShip(team(128), c, NOW);
  assert.equal(unread.ci, "running"); assert.equal(unread.stale, true, "the place on main could not be read: no fresh reading");
  assert.equal(teamShip(team(124), c, NOW).stale, true, "any status but 1");
  const no = teamShip(team(1), c, NOW);
  assert.equal(no.ci, "running"); assert.equal("stale" in no, false, "exit 1: not on main, a plain candidate");
  assert.equal(teamShip(team(0), c, NOW), null, "on main: the candidate is over");
  assert.deepEqual(stateErrors({ v: 1, id: "t", cards: {}, ship: unread }).filter((e) => /ship|stale/.test(e)), []);
});

test("the page: the ship tile has plain words for the three CI reasons, so the line never disappears and never reads red", () => {
  const b = loadNames(["shipCandidate", "probeEvent", "liveOn", "hhmm"], { Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(NOW); } static now() { return NOW; } } });
  const send = (ship) => b.probeEvent({ type: "data", result: { payload: { v: 1, board: { boardId: "TestBoard42xyz", at: NOW - 5e3, probe: null, pageVersion: null }, cards: {}, agents: {}, ship } } }, {});
  const words = { none: "candidate pushed, not on main", backoff: "CI check waiting", capped: "CI check limit reached", unread: "CI not read", queued: "waiting on CI", running: "CI running", passed: "CI passed, merging" };
  for (const ci of SHIP_CI) {
    assert.ok(Object.hasOwn(words, ci), `${ci} has a word in this test`);
    send({ version: "1.226.23", ci, at: NOW - 60e3 });
    assert.equal(b.shipCandidate(NOW), `Ship v1.226.23 ${words[ci]}`, ci);
  }
  send({ version: "1.226.23", ci: "unread", at: NOW - 60e3, stale: true });
  assert.equal(b.shipCandidate(NOW), "Ship v1.226.23 CI not read, no fresh reading");
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  const line = html.split("\n").find((l) => l.startsWith("const SHIP_CI_WORDS="));
  assert.ok(line && !/red|bad|warn|class/i.test(line), "plain words: no colour, no class");
});

test("the pinned copy of the ship CI words in collector/state.mjs equals the schema's, and the source keeps its failed-read answers", () => {
  const src = readFileSync(new URL("../collector/state.mjs", import.meta.url), "utf8");
  const m = /const SHIP_CI_STATES = (\[[^\]]*\]);/.exec(src);
  assert.ok(m); assert.deepEqual(JSON.parse(m[1]), [...SHIP_CI]);
  assert.match(src, /catch \(e\) \{ if \(e\?\.status !== 1\) notesFailed = true; \}/, "a `notes show` that fails with any status but 1 is a failed read");
  assert.match(src, /ancestry\(\(\) => team\.git\(\["merge-base"/, "the ship candidate's place on main is a three-valued answer");
});
