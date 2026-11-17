// #C1166: four small duplicate readings, each now one rule. (1) the Board-Id trailer is tested in board-id-one-reading.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";
import * as probe from "../collector/pairs.mjs";
import * as worker from "../worker/board-rules.mjs";

// (2) "is this the board's own repository": one answer for the probe, the dispatch and the Worker.
const WORDS = ["flight-board", "board", "Flight-Board", " board ", "aponsin/flight-board", "flight-board.git", "someone/Board.git", "other-repo", "", null, undefined, 5, "boards", "flight-boards"];

test("the board's own repository is read one way: the probe's pairs.mjs and the Worker's copy agree on every word, spelling aside", () => {
  for (const w of WORDS) {
    assert.equal(worker.repoKey(w), probe.repoKey(w), `key of ${JSON.stringify(w)}`);
    assert.equal(worker.isBoardRepo(w), probe.isBoardRepo(w), `isBoardRepo ${JSON.stringify(w)}`);
    assert.equal(worker.isBoardCard({ repo: w }), probe.isBoardCard({ repo: w }), `isBoardCard ${JSON.stringify(w)}`);
  }
  assert.deepEqual([...worker.LANDED_REPO_WORDS].sort(), [...probe.BOARD_REPO_WORDS].sort());
  for (const w of ["flight-board", "board", "Flight-Board", " board ", "aponsin/flight-board", "flight-board.git"]) assert.equal(probe.isBoardRepo(w), true, w);
  for (const w of ["other-repo", "", null, undefined, 5, "boards"]) assert.equal(probe.isBoardRepo(w), false, String(w));
  // A card with no word is the board's (stack mode, dependency checks, reviewer key); a word of another repository is not; the pair step wants the word itself.
  assert.equal(probe.isBoardCard({}), true);
  assert.equal(probe.isBoardCard({ repo: "" }), true);
  assert.equal(probe.isBoardCard({ repo: "other-repo" }), false);
  assert.equal(probe.isBoardRepo(undefined), false);
});

// (3, F2 of Checker 2 on 609267eb) the store's own call: syncStalls hands slowWakes the stack switch. Card "c" sits at ship past the slow limit and depends on "d", the same owner's card, pushed
// and not live: with the switch on the dependency holds nothing, so c is named slow; with it off c is held behind d and is not.
async function slowFor(stackOn) {
  const { makeDb } = await import("./helpers/d1-sqlite.mjs");
  const { createCard, writeEvidence, setStackSwitch } = await import("../worker/board-store.mjs");
  const { beat, wakeAsk, takeInbox } = await import("./helpers/beating-store.mjs");
  const db = makeDb(), at = T + worker.SHIP_SLOW_MS + 2 * MIN;
  for (const f of [{ id: "c1-dep", title: "The dependency", owner_role: "Boardsmith" }, { id: "c2-card", title: "The card", owner_role: "Boardsmith", depends_on: ["c1-dep"] }]) { const r = await createCard(db, T, "Manager", f); assert.ok(r.ok, JSON.stringify(r)); }
  await writeEvidence(db, T, "probe", "cards.c1-dep", rd("build"));
  await writeEvidence(db, T, "probe", "cards.c2-card", rd("ship"));
  assert.equal((await setStackSwitch(db, T, "owner", { repo: "board", stack: stackOn })).ok, true); // set both ways: the switch's default is not the "off" case
  await beat(db, at - 1000);
  await wakeAsk(db, at);
  const num = (await db.prepare("SELECT num FROM cards WHERE id = 'c2-card'").first()).num;
  return (await takeInbox(db, at + 1000)).stalls.map((s) => s.reason).filter((r) => /is slow with no reason/.test(r) && r.includes(`#C${num} `));
}
test("the store passes the stack switch to slowWakes: with it on a card whose same-owner dependency is pushed is named slow, with it off it is held", async () => {
  const off = await slowFor(false);
  assert.equal(off.length, 0, `switch off: held behind its dependency: ${JSON.stringify(off)}`);
  assert.equal((await slowFor(true)).length, 1, "switch on: the dependency is pushed, the card is slow");
});

// (7) the install the settings pin has one reader: the release job's, the pickup pass's and the dispatch watch's are the same function and agree on every settings text.
test("the pinned install is read one way: current.mjs, wake-watch.mjs and config.mjs agree on every settings text, and two commits name none", async () => {
  const { pinnedCommit: fromCurrent } = await import("../scripts/current.mjs");
  const { pinnedInstallOf, pinnedLaunch } = await import("../scripts/wake-watch.mjs");
  const { pinnedCommit } = await import("../scripts/config.mjs");
  const A = "a".repeat(40), B = "b".repeat(40);
  const hook = (sha, file) => `node '/h/.flight-board/install/${sha}/gate/${file}.mjs' --config '/c.json'`;
  const TEXTS = [
    [hook(A, "stop"), A],
    [`${hook(A, "stop")}\n${hook(A, "publish")}`, A],
    [`${hook(A, "stop")}\n${hook(B, "publish")}`, null],   // the Stop hook and the publish hook disagree: no pin, for every reader
    [`${hook(A, "gate")}\n${hook(A, "stop")}`, A],
    [`${hook(A, "stop")}\n${hook(B, "stop")}`, null],
    ["/h/.flight-board/current/gate/stop.mjs", null],
    ["", null], [null, null], [undefined, null],
  ];
  for (const [text, want] of TEXTS) {
    assert.equal(pinnedCommit(text), want, JSON.stringify(text));
    assert.equal(fromCurrent(text), want, `current.mjs: ${JSON.stringify(text)}`);
    assert.equal(pinnedInstallOf(text), want, `wake-watch.mjs: ${JSON.stringify(text)}`);
  }
  assert.equal(fromCurrent, pinnedCommit, "the very same function");
  assert.equal(pinnedInstallOf, pinnedCommit, "the very same function");
  assert.ok(pinnedLaunch({ settingsText: `${hook(A, "stop")}\n${hook(B, "publish")}`, installRoot: "/nowhere", self: "/x" }).why, "disagreeing hooks: the --pinned launch has no pin");
});

// (4) a session the probe reads as "unknown" (reset, nothing said yet) is an open session everywhere: the stall rule counts it (#C940), so the page's liveAgent does too.
test("the page reads an unknown session as open and idle since its last activity, as the stall rule does; a role the probe does not list is none", () => {
  const NOW = 1_800_000_000_000, MIN = 60e3;
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(html, /\["working","idle","unknown"\]\.includes\(a\.state\)/);
  const b = loadNames(["derivedOf", "liveCard", "liveAgent", "liveSubstep", "agentOn", "stampText", "probeEvent", "enrich", "crewHtml", "renderAll", "initRow", "stampLine", "evidence", "oldestText"], { Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(NOW); } static now() { return NOW; } } });
  Object.assign(b.state, { initRaw: [], steps: [], waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [], derived: [], initiatives: [] });
  const at = NOW - 40e3;
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { boardId: "TestBoard42xyz", at, probe: null, pageVersion: null }, cards: {}, agents: { Designer: { state: "unknown", lastActivityAt: NOW - 10 * MIN }, Checker: { state: "idle", since: NOW - 20 * MIN, lastActivityAt: NOW - 5 * MIN }, Linguist: { state: "bogus" } } } } }, {});
  const d = b.liveAgent("Designer"); // (the page runs in its own realm: compare the fields, not the object)
  assert.deepEqual([d.state, d.card, d.since], ["idle", null, NOW - 10 * MIN]);
  assert.equal(b.liveAgent("Checker").since, NOW - 5 * MIN);
  assert.equal(b.liveAgent("Linguist"), null);
  assert.equal(b.liveAgent("Nobody"), null);
});

// (3) slowWakes reads a dependency the way the dispatch and the stall check do: with the stack switch on, a dependency the same role has pushed is no hold.
const T = 1_800_000_000_000, MIN = 60e3;
const rd = (phase, extra = {}) => ({ lit: [phase], phase, headSha12: "aaaaaaaaaaaa", signed: [], onMain: false, ...extra });
const slowReasons = (stackOn, cardFields = {}, depFields = {}, depEv = rd("build")) => worker.slowWakes({
  now: T, stackOn,
  cards: [{ id: "c", num: 1166, owner_role: "Boardsmith", paused: 0, dropped: 0, depends_on: JSON.stringify(["d"]), ...cardFields }, { id: "d", num: 1165, owner_role: "Boardsmith", paused: 0, dropped: 0, ...depFields }],
  evidence: { c: rd("ship"), d: depEv }, openAskCards: new Set(), phaseStart: new Map([["c|ship", T - worker.SHIP_SLOW_MS - MIN]]), medians: {}, endsPassed: new Set(),
}).filter((s) => s.id === "c" || s.num === 1166);

test("slowWakes passes the stack switch to the dependency check: a pushed same-owner dependency holds the card with the switch off and not with it on", () => {
  assert.equal(slowReasons(false).length, 0, "switch off: the dependency has not landed, the card is held, not slow");
  assert.equal(slowReasons(true).length, 1, "switch on: the same builder pushed it, so the card is slow like any other");
  assert.equal(slowReasons(true, {}, { owner_role: "Designer" }).length, 0, "another role's dependency still holds it");
  assert.equal(slowReasons(true, {}, {}, { lit: ["build"], phase: "build", stack: { outside: true }, headSha12: "bbbbbbbbbbbb" }).length, 0, "a dependency pushed outside the stack still holds it");
  assert.equal(slowReasons(true, { repo: "other-repo" }).length, 0, "a product card is not a board card: the switch does not release it");
});
