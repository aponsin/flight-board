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
import { shipRuns, shipsCard, cardState, SHIP_TITLE } from "../collector/state.mjs";
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

test("a run is for a card when its branch is the tip's (whole or last part) or its sha starts the tip or head", () => {
  const tip = { branch: "build/live-now", sha: "c5dc81c0" + "0".repeat(32) }, head = { sha: "9db172c9" + "0".repeat(32) };
  assert.equal(shipsCard([{ branch: "build/live-now", sha: "1111111" }], tip, head), true);
  assert.equal(shipsCard([{ branch: "live-now", sha: "1111111" }], tip, head), true, "the last part");
  assert.equal(shipsCard([{ branch: "elsewhere", sha: "c5dc81c" }], tip, head), true, "the tip's sha");
  assert.equal(shipsCard([{ branch: "elsewhere", sha: "9db172c" }], tip, head), true, "the head's sha");
  assert.equal(shipsCard([{ branch: "elsewhere", sha: "1111111" }], tip, head), false);
  assert.equal(shipsCard([], tip, head), false);
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

test("the watch prints SHIP and CLOSE once per card and tip, again for a new tip, and forgets what left the list", () => {
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

// ---- the page: the card says it from the live state
function page(card, probeCard, agents = {}) {
  const b = loadNames(["liveCard", "versionNote", "versionNoteBase", "liveRun", "shipNow", "probeEvent"]);
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

test("a ship run the probe read counts as a ship now for the restart pill and the Don't-restart line", () => {
  const b = page("board-x", { phase: "ship", shipping: true });
  assert.equal(JSON.stringify(b.shipNow()), JSON.stringify({ id: "board-x", version: null }));
  assert.equal(page("board-x", { phase: "ship", shipping: false }).shipNow(), null);
  assert.equal(page("board-x", { phase: "ship", shipping: true, onMain: true }).shipNow(), null, "on main: deploying, not a run");
});
