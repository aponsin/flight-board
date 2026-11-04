// #C617, board truth from code: tonight the board looked stuck three ways, each from a forgotten write. This file holds the
// gate's part (a live step closes its card); the probe's parts (shipping, signed and waiting, closeable) are below.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { checkWrites } from "../gate/rules.mjs";
import { shipRuns, shipsCard, shipTitlePairs, cardState, SHIP_TITLE } from "../collector/state.mjs";
import { boardTruth } from "../collector/readings.mjs";
import { stateErrors, pickState } from "../collector/state-schema.mjs";
import { truthPending, truthSeen, truthLine, TRUTH_FILE, TRUTH_SEEN_FILE } from "../gate/reset.mjs";
import { tick } from "../scripts/wake-watch.mjs";
import { loadNames } from "./harness.mjs";

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const config = fullConfig({ artifactUrl: URL_ });
const now = Date.now() - 1234;
const release = { role: "Release" }, lead = { role: "Manager", manager: true };
const liveStep = (init, extra = {}) => ({ op: "set", collection: "steps", doc_id: `s${now}-live-${init}`, data: { init, phase: "live", kind: "end", who: "Release", at: now, note: "Live: v1.2.3", ...extra } });
const close = (init, data = { status: "done", doneAt: now }) => ({ op: "update", collection: "initiatives", doc_id: init, data });
const mirrorOf = (cards) => ({ docs: { initiatives: cards, waiting: [], messages: [], steps: [] }, at: now - 100, atBy: {} });
const errs = (writes, mirror = null, who = release) => checkWrites(writes, { config, who, now, state: {}, mirror }).errors;
const liveErr = (e) => e.filter((m) => /step closes its card/.test(m));

test("a live step is refused unless the same batch sets its card's status to done", () => {
  const e = liveErr(errs([liveStep("board-x")]));
  assert.equal(e.length, 1);
  assert.match(e[0], /a live step closes its card: set initiatives\/board-x \{status: "done"\} in the same batch/);
  assert.deepEqual(liveErr(errs([liveStep("board-x"), close("board-x")])), [], "with the card closed in the same batch");
  assert.deepEqual(liveErr(errs([close("board-x"), liveStep("board-x")])), [], "in either order");
});

test("another card's close, or a close that is not done, does not count", () => {
  assert.equal(liveErr(errs([liveStep("board-x"), close("board-y")])).length, 1);
  assert.equal(liveErr(errs([liveStep("board-x"), close("board-x", { status: "active" })])).length, 1);
  assert.equal(liveErr(errs([liveStep("board-x"), { op: "delete", collection: "initiatives", doc_id: "board-x" }])).length, 1);
});

test("a card the board already holds as done needs no second close; an open one in the mirror does", () => {
  assert.deepEqual(liveErr(errs([liveStep("board-x")], mirrorOf([{ id: "board-x", status: "done" }]))), []);
  assert.equal(liveErr(errs([liveStep("board-x")], mirrorOf([{ id: "board-x", status: "active" }]))).length, 1);
});

test("only a live step: start and end steps of other phases pass; a live start step is a live step too", () => {
  assert.deepEqual(liveErr(errs([{ op: "set", collection: "steps", doc_id: "s1", data: { init: "board-x", phase: "ship", kind: "end", who: "Release", at: now } }])), []);
  assert.equal(liveErr(errs([liveStep("board-x", { kind: "start" })])).length, 1);
  assert.equal(liveErr(errs([liveStep("board-x")], null, lead)).length, 1, "whoever writes it");
});

// ---- (1) shipping: a GitHub run titled "vX: <branch>@<sha>" marks that card while it runs
const T = 1_800_000_000_000;
const runsGh = (runs) => () => JSON.stringify(runs);
const run = (status, displayTitle) => ({ status, displayTitle });

test("shipRuns reads the running runs titled vX: <branch>@<sha>, and only those", () => {
  const gh = runsGh([run("in_progress", "v1.184.1: build/live-now@c5dc81c0"), run("queued", "v1.184.2: other-card@aaaaaaa"), run("completed", "v1.183.0: done-card@bbbbbbb"), run("in_progress", "deploy to prod"), run("in_progress", "v1.2.3: bad branch with spaces@ccccccc"), run("in_progress", "v1.2.3: x@zz")]);
  assert.deepEqual(shipRuns(gh, T), [{ branch: "build/live-now", sha: "c5dc81c0" }, { branch: "other-card", sha: "aaaaaaa" }]);
  assert.match("v1.184.1: build/live-now@c5dc81c0", SHIP_TITLE);
});

test("shipRuns: gh failing is none, never 'not shipping', and backs off like the CI reads", () => {
  const backoff = { until: 0, wait: 60e3 };
  assert.equal(shipRuns(() => { throw new Error("rate limited"); }, T, backoff), null);
  assert.equal(backoff.until, T + 60e3);
  assert.equal(backoff.wait, 120e3);
  let called = 0;
  assert.equal(shipRuns(() => { called++; return "[]"; }, T + 1000, backoff), null, "inside the back-off: not asked");
  assert.equal(called, 0);
  assert.deepEqual(shipRuns(() => "[]", T + 61e3, backoff), [], "after it: asked, and cleared");
  assert.equal(backoff.until, 0);
  assert.equal(shipRuns(() => "not json", T + 62e3), null);
  assert.equal(shipRuns(() => JSON.stringify({ runs: [] }), T + 62e3), null);
});

test("a run is for a card when its branch is the tip's, whole, or its sha (7 characters at least) starts the tip or head", () => {
  const tip = { branch: "build/live-now", sha: "c5dc81c0" + "0".repeat(32) }, head = { sha: "9db172c9" + "0".repeat(32) };
  assert.equal(shipsCard([{ branch: "build/live-now", sha: "1111111" }], tip, head), true);
  assert.equal(shipsCard([{ branch: "live-now", sha: "1111111" }], tip, head), false, "the last part alone is another card's (Checker): admin/x and build/x are two");
  assert.equal(shipsCard([{ branch: "admin/live-now", sha: "1111111" }], tip, head), false);
  assert.equal(shipsCard([{ branch: "elsewhere", sha: "c5dc81c" }], tip, head), true, "the tip's sha");
  assert.equal(shipsCard([{ branch: "elsewhere", sha: "9db172c" }], tip, head), true, "the head's sha");
  assert.equal(shipsCard([{ branch: "elsewhere", sha: "c5dc" }], tip, head), false, "a cut title's 4-character sha names nothing alone");
  assert.equal(shipsCard([{ branch: "elsewhere", sha: "1111111" }], tip, head), false);
  assert.equal(shipsCard([], tip, head), false);
});

// Checker's finding on 47cdc89: real ship titles combine branches and GitHub cuts them with "…".
test("shipTitlePairs reads every branch@sha of a combined or cut title (real titles)", () => {
  assert.deepEqual(shipTitlePairs("v1.186.0: admin/replace-photo-upload@1211a47c3b8c66a886d9677d318feb30…"), [{ branch: "admin/replace-photo-upload", sha: "1211a47c3b8c66a886d9677d318feb30" }]);
  assert.deepEqual(shipTitlePairs("v1.183.0: build/contact-dup-phone@c6db…, build/gbp-kit@1534…"), [{ branch: "build/contact-dup-phone", sha: "c6db" }, { branch: "build/gbp-kit", sha: "1534" }]);
  assert.deepEqual(shipTitlePairs("v1.186.0: build/a@aaaaaaa, build/b@bbbbbbb, build/c-d@ccccccc"), [{ branch: "build/a", sha: "aaaaaaa" }, { branch: "build/b", sha: "bbbbbbb" }, { branch: "build/c-d", sha: "ccccccc" }]);
  assert.deepEqual(shipTitlePairs("v1.186.0: build/a＠aaaaaaa, build/b@bb"), [{ branch: "build/a", sha: "aaaaaaa" }], "the full-width @; a part cut to nothing is dropped");
  assert.deepEqual(shipTitlePairs("v1.186.0: build/cut-branch-na…"), [], "a branch cut before its @");
  assert.deepEqual(shipTitlePairs("deploy to prod"), []);
  assert.deepEqual(shipTitlePairs(undefined), []);
});

test("shipRuns adds the pairs from the run's own commit subjects (whole, never cut), and a cut title still marks its first card", () => {
  const head = "9".repeat(40), subjects = ["v1.186.0: build/contact-dup-phone@c6dbaaaaaaa, build/gbp-kit@1534bbbbbbb, build/third@ddddddd", "base commit"].join("\n");
  const gh = runsGh([{ status: "in_progress", displayTitle: "v1.186.0: build/contact-dup-phone@c6db…", headSha: head }, { status: "completed", displayTitle: "v1.185.0: old@eeeeeee", headSha: "8".repeat(40) }]);
  const asked = [];
  const git = (args) => { asked.push(args); return subjects; };
  const got = shipRuns(gh, T, undefined, { git, shippedPattern: "([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})" });
  assert.deepEqual(asked, [["log", "-5", "--format=%s", head]], "the git call is the run's head, argv only; a finished run is not read");
  assert.deepEqual(got.map((s) => s.branch), ["build/contact-dup-phone", "build/contact-dup-phone", "build/gbp-kit", "build/third"]);
  assert.equal(shipsCard(got, { branch: "build/third", sha: "d".repeat(40) }, { sha: "d".repeat(40) }), true, "a branch the title lost");
  assert.deepEqual(shipRuns(gh, T, undefined, { git: () => { throw new Error("no clone"); }, shippedPattern: "([a-z/]+)@([0-9a-f]{7,40})" }).map((s) => s.branch), ["build/contact-dup-phone"], "no git: the title's pairs stand");
  assert.deepEqual(shipRuns(gh, T, undefined, { git, shippedPattern: "" }).map((s) => s.branch), ["build/contact-dup-phone"], "no shippedPattern: the title only");
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-truth-")), git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "-b", "main"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["commit", "-q", "--allow-empty", "-m", "base"]);
  git(["switch", "-q", "-c", "board-x"]); git(["commit", "-q", "--allow-empty", "-m", "work\n\nBoard-Id: board-x"]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  for (const ref of ["checker", "security"]) git(["notes", `--ref=refs/notes/${ref}`, "add", "-m", "PASS", sha]);
  git(["update-ref", "refs/remotes/origin/main", "main"]); git(["update-ref", "refs/remotes/origin/board-x", sha]);
  const cfg = { phases: [["plan"], ["build"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
  const repo = (extra = {}) => ({ git, remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips: [{ branch: "board-x", sha, at: T, message: "work\n\nBoard-Id: board-x" }, { branch: "main", sha: "x", at: T, message: "" }], live: null, versionPattern: null, ...extra });
  return { git, sha, cfg, repo };
}

test("the card state carries shipping: true while a run is on its tip, false without one, nothing when runs weren't read", () => {
  const { sha, cfg, repo } = scratch(), card = { id: "board-x", num: 617, level: "Full", phase: "plan" };
  assert.equal(cardState(card, repo({ ships: [{ branch: "build/board-x", sha: sha.slice(0, 7) }] }), cfg, T).shipping, true);
  const none = cardState(card, repo({ ships: [] }), cfg, T);
  assert.equal(none.shipping, false);
  assert.equal(none.phase, "ship", "signed by both: ship phase");
  assert.equal(Object.hasOwn(cardState(card, repo({ ships: null }), cfg, T), "shipping"), false, "gh could not be asked: no claim");
  assert.equal(Object.hasOwn(cardState(card, repo(), cfg, T), "shipping"), false);
});

test("a card already on main is not shipping, whatever run names it", () => {
  const { git, sha, cfg, repo } = scratch();
  git(["update-ref", "refs/remotes/origin/main", sha]);
  assert.equal(cardState({ id: "board-x", num: 617, level: "Full" }, repo({ ships: [{ branch: "board-x", sha: sha.slice(0, 7) }] }), cfg, T).shipping, false);
});

test("the state schema: shipping is an optional boolean, and a state from a probe without it still fits", () => {
  const base = { v: 1, board: { boardId: "TestBoard01", at: T, probe: null, pageVersion: null }, agents: {} };
  const card = { num: 1, phase: "ship", headSha12: "a1b2c3d4e5f6", signed: ["checker"], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: T };
  assert.deepEqual(stateErrors({ ...base, cards: { "board-x": card } }), []);
  assert.deepEqual(stateErrors({ ...base, cards: { "board-x": { ...card, shipping: true } } }), []);
  assert.ok(stateErrors({ ...base, cards: { "board-x": { ...card, shipping: "yes, soon" } } }).length);
  assert.equal(pickState({ ...base, cards: { "board-x": { ...card, shipping: true } } }).cards["board-x"].shipping, true);
});

// ---- (2) signed and waiting, (3) live and still open: what the probe writes and the watch prints
const st = (phase, over = {}) => ({ headSha12: "a1b2c3d4e5f6", phase, onMain: false, ...over });

test("boardTruth: ship for a signed tip off main with no run; close for a live open card; nothing else", () => {
  const states = { "a-signed": st("ship"), "b-running": st("ship", { shipping: true }), "c-onmain": st("ship", { onMain: true }), "d-live": st("live", { onMain: true }), "e-review": st("checker"), "f-nohead": { phase: "ship", onMain: false, headSha12: null }, "g-verifying": st("live", { onMain: true }) };
  assert.deepEqual(boardTruth({ states, shipPhase: "ship", livePhase: "live", hold: new Set(["g-verifying"]) }), [
    { kind: "ship", card: "a-signed", sha: "a1b2c3d4e5f6" },
    { kind: "close", card: "d-live", sha: "a1b2c3d4e5f6" },
  ]);
  assert.equal(boardTruth({ states: Object.fromEntries(Array.from({ length: 30 }, (_, n) => [`card-${String(n).padStart(2, "0")}`, st("ship")])), shipPhase: "ship", livePhase: "live" }).length, 20, "at most 20");
});

test("a CLOSE line repeats every 2 hours until the card leaves the list (status done); a SHIP line is printed once per tip", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-truth-repeat-"));
  const write = (items) => writeFileSync(join(dir, TRUTH_FILE), JSON.stringify({ at: T, items }));
  const roster = ["Manager", "Release"], MIN = 60e3;
  write([{ kind: "ship", card: "board-x", sha: "a1b2c3d4e5f6" }, { kind: "close", card: "board-y", sha: "b1b2c3d4e5f6" }]);
  const first = tick(dir, T, 1, roster);
  assert.match(first, /SHIP board-x/); assert.match(first, /CLOSE board-y/);
  // #C682: the repeat is two hours (it was ten minutes), so a card that is open on purpose does not wake the lead every run.
  const H = 60 * MIN;
  assert.equal(tick(dir, T + 5 * MIN, 1, roster), null, "five minutes on: nothing");
  assert.equal(tick(dir, T + 10 * MIN, 1, roster), null, "ten minutes: nothing any more");
  assert.equal(tick(dir, T + 2 * H - 1e3, 1, roster), null, "just under two hours");
  const again = tick(dir, T + 2 * H, 1, roster);
  assert.equal(again.split("\n").length, 1, "two hours: the CLOSE line only");
  assert.match(again, /^CLOSE board-y/);
  assert.equal(tick(dir, T + 3 * H, 1, roster), null, "the clock restarts at each print");
  assert.match(tick(dir, T + 4 * H, 1, roster), /^CLOSE board-y/, "and again two hours after that");
  write([{ kind: "ship", card: "board-x", sha: "a1b2c3d4e5f6" }]);
  assert.equal(tick(dir, T + 4 * H + 11 * MIN, 1, roster), null, "the card's status is done: no more CLOSE lines, and SHIP is not repeated");
  write([{ kind: "ship", card: "board-x", sha: "a1b2c3d4e5f6" }, { kind: "close", card: "board-y", sha: "b1b2c3d4e5f6" }]);
  assert.match(tick(dir, T + 4 * H + 12 * MIN, 1, roster), /^CLOSE board-y/, "a card that comes back is asked at once");
  assert.equal(JSON.parse(readFileSync(join(dir, TRUTH_SEEN_FILE), "utf8")).items["close board-y"].at, T + 4 * H + 12 * MIN, "the seen file keeps the print time");
  // an older seen file (the sha alone) reads as printed long ago
  writeFileSync(join(dir, TRUTH_SEEN_FILE), JSON.stringify({ items: { "close board-y": "b1b2c3d4e5f6", "ship board-x": "a1b2c3d4e5f6" } }));
  const old = tick(dir, T + 4 * H + 13 * MIN, 1, roster);
  assert.match(old, /^CLOSE board-y/);
  assert.equal(old.includes("SHIP"), false);
});

test("the watch prints SHIP and CLOSE for a new tip, and forgets what left the list", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-truth-watch-"));
  const write = (items) => writeFileSync(join(dir, TRUTH_FILE), JSON.stringify({ at: T, items }));
  write([{ kind: "ship", card: "board-x", sha: "a1b2c3d4e5f6" }, { kind: "close", card: "board-y", sha: "b1b2c3d4e5f6" }]);
  const first = tick(dir, T, 1, ["Manager", "Release"]);
  assert.match(first, /SHIP board-x: every sign-off its level needs is on a1b2c3d and it is not on main; tell Release to ship it/);
  assert.match(first, /CLOSE board-y: its commits are live .* set status done in the same batch/);
  assert.equal(tick(dir, T + 5000, 1, ["Manager", "Release"]), null, "once");
  write([{ kind: "ship", card: "board-x", sha: "c1b2c3d4e5f6" }]);
  assert.match(tick(dir, T + 10000, 1, ["Manager", "Release"]), /SHIP board-x: .* on c1b2c3d /, "a new tip is a new line");
  write([]);
  assert.equal(tick(dir, T + 15000, 1, ["Manager", "Release"]), null);
  write([{ kind: "ship", card: "board-x", sha: "c1b2c3d4e5f6" }]);
  assert.match(tick(dir, T + 20000, 1, ["Manager", "Release"]), /SHIP board-x/, "back on the list after it left: again");
});

test("no SHIP line when the roster has no Release; CLOSE still prints; odd entries are dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-truth-roster-"));
  writeFileSync(join(dir, TRUTH_FILE), JSON.stringify({ at: T, items: [{ kind: "ship", card: "board-x", sha: "a1b2c3d4e5f6" }, { kind: "close", card: "board-y", sha: "b1b2c3d4e5f6" }, { kind: "ship", card: "Bad Card!", sha: "a1b2c3d4e5f6" }, { kind: "run", card: "board-z", sha: "a1b2c3d4e5f6" }, { kind: "ship", card: "board-w", sha: "short" }] }));
  const out = tick(dir, T, 1, ["Manager", "Builder"]);
  assert.equal(out.split("\n").length, 1);
  assert.match(out, /^CLOSE board-y/);
  assert.deepEqual(truthPending(JSON.parse(readFileSync(join(dir, TRUTH_FILE), "utf8")), null).map((a) => a.card), ["board-x", "board-y"], "only well-formed entries");
  assert.deepEqual(truthSeen(null), { items: {} });
  assert.match(truthLine({ kind: "close", card: "c", sha: "a1b2c3d4e5f6" }), /^CLOSE c:/);
  assert.ok(TRUTH_SEEN_FILE);
});

test("a SHIP line held back while Release is off the roster prints once Release is back on it", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-truth-held-"));
  writeFileSync(join(dir, TRUTH_FILE), JSON.stringify({ at: T, items: [{ kind: "ship", card: "board-x", sha: "a1b2c3d4e5f6" }] }));
  assert.equal(tick(dir, T, 1, ["Manager", "Builder"]), null, "held back");
  assert.match(tick(dir, T + 5000, 1, ["Manager", "Release"]), /^SHIP board-x/, "printed once Release is on the roster");
  assert.equal(tick(dir, T + 10000, 1, ["Manager", "Release"]), null, "then once");
});

// ---- the page: the card says it from the live state
function page(card, probeCard, agents = {}) {
  const b = loadNames(["liveCard", "versionNote", "versionNoteBase", "liveRun", "shipNow", "probeEvent", "asShown", "closeableNow"]);
  b.state.initRaw = [{ id: card, num: 617, status: "active" }];
  b.state.derived = [{ id: "all", cards: {} }];
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 20e3 }, cards: { [card]: { headSha12: "a1b2c3d4e5f6", onMain: false, ...probeCard } }, agents } } });
  return b;
}

test("the card says Shipping now, Signed waiting for Release, or Waiting for <role>, from the live state", () => {
  assert.equal(page("board-x", { phase: "ship", shipping: true }).versionNote({ id: "board-x" }), "<b>Shipping now</b>");
  assert.equal(page("board-x", { phase: "ship", shipping: false }).versionNote({ id: "board-x" }), "Signed, waiting for Release");
  assert.equal(page("board-x", { phase: "checker" }).versionNote({ id: "board-x" }), "Waiting for Checker");
  assert.equal(page("board-x", { phase: "security" }).versionNote({ id: "board-x" }), "Waiting for Security");
  assert.equal(page("board-x", { phase: "build" }).versionNote({ id: "board-x" }), "Building", "building says what it did before");
  assert.equal(page("board-x", { phase: "ship", onMain: true }).versionNote({ id: "board-x" }), "", "on main: the export's word (deploying, live)");
});

test("a card whose commits are live by the probe's reading shows as done at once; one with a check to run, or off main, does not", () => {
  const b = page("board-x", { phase: "live", onMain: true });
  b.state.initRaw = [{ id: "board-x", status: "active" }];
  const shown = (i) => JSON.parse(JSON.stringify(loadAsShown(b, i)));
  function loadAsShown(bb, i) { return bb.asShown(i); }
  assert.equal(shown({ id: "board-x", status: "active" }).status, "done");
  assert.equal(shown({ id: "board-x", status: "active" }).doneByEvidence, true);
  assert.equal(shown({ id: "board-x", status: "queued" }).status, "done");
  assert.equal(shown({ id: "board-x", status: "active", checkAt: Date.now() + 3e5 }).status, "active", "Verifying: waits for its check");
  assert.equal(shown({ id: "board-x", status: "done" }).doneByEvidence, undefined, "already done: as it is");
  assert.equal(shown({ id: "board-x", status: "dropped" }).dropped, true, "dropped: as before");
  assert.equal(shown({ id: "board-y", status: "active" }).status, "active", "a card the probe doesn't list");
  assert.equal(page("board-x", { phase: "live", onMain: false }).asShown({ id: "board-x", status: "active" }).status, "active", "not on main");
  assert.equal(page("board-x", { phase: "ship", onMain: true }).asShown({ id: "board-x", status: "active" }).status, "active", "on main but not deployed: still shipping");
});

test("a ship run the probe read counts as a ship now for the restart pill and the Don't-restart line", () => {
  const b = page("board-x", { phase: "ship", shipping: true });
  assert.equal(JSON.stringify(b.shipNow()), JSON.stringify({ id: "board-x", version: null }));
  assert.equal(page("board-x", { phase: "ship", shipping: false }).shipNow(), null);
  assert.equal(page("board-x", { phase: "ship", shipping: true, onMain: true }).shipNow(), null, "on main: deploying, not a run");
});
