// #C1294 (the owner's pick A on #T2139): a decision with options in a card's thread that he has not picked counts as an open ask on that card. The card gates at
// the phase it holds (red and white stripes), reads "Waiting on you", is not stalled, and its thread sits under Needs you with a "waiting on you" badge, until he picks
// ("Chose ...", after it) or the decision is resolved. The worker already treats such a card as asked (decisionHolds, dispatch and stall lines); this is the page.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, readingDoc, setReadings } from "./harness.mjs";

const NAMES = ["gates", "enrich", "initRow", "ownerWait", "waitsOn", "threadSets", "threadRow", "cardDecision", "waitBoxes", "tabCounts", "state"];
const now = Date.now(), MIN = 60e3;
const two = [{ key: "A", label: "Left" }, { key: "B", label: "Right" }];
const decision = (at, extra = {}) => ({ id: "m-dec", thread: "t-1", from: "Manager", text: "Which look?\n\nA or B?", at, kind: "decision", options: two, ...extra });
const owner = (id, at, text) => ({ id, thread: "t-1", from: "Owner", text, at });
const note = (id, at) => ({ id, thread: "t-1", from: "Manager", text: "a note", at });
const raw = (extra = {}) => ({ id: "c1-look", num: 1, name: "Look change", size: "S", level: "Quick", status: "active", phase: "build", who: "Builder", repo: "flight-board", thread: "t-1", lastStepAt: now - 60 * MIN, createdAt: now - 120 * MIN, ...extra });
function load(messages, card = raw()) {
  const b = loadNames(NAMES);
  Object.assign(b.state, { messages, threads: [{ id: "t-1", num: 7 }], waiting: [], steps: [], derived: [], meta: [], todo: [], ideas: [], initRaw: [card] });
  b.state.initiatives = [b.gates(b.enrich(card))];
  return b;
}
const gate = (i) => (i.phaseLog || []).filter((e) => e.wait === "gate");

test("an unpicked decision in the card's thread gates the card at its phase, open, with the owner holding it", () => {
  const b = load([decision(now - 20 * MIN)]);
  const i = b.state.initiatives[0];
  assert.equal(gate(i).length, 1);
  assert.equal(gate(i)[0].phase, "build");
  assert.equal(gate(i)[0].start, now - 20 * MIN);
  assert.equal(gate(i)[0].end, undefined, "still open");
  assert.match(i.waitingOn, /Which look\?/);
  const boxes = b.waitBoxes(i.phaseLog);
  assert.ok(boxes.build && boxes.build.some((w) => w.kind === "gate" && w.open), "the strip draws the open Gated box before Build");
});

test("the card reads Waiting on you and is not stalled while the decision is open", () => {
  const withDec = load([decision(now - 20 * MIN)]);
  assert.ok(withDec.ownerWait(withDec.state.initiatives[0]), "an owner wait is found");
  // #C1382: the Worker's reading of such a card is the ask wait (decisionHolds); the row draws that: the stripes tile and "Waiting on you", no red box before it.
  setReadings(withDec, readingDoc("c1-look", { state: "waiting", wait: "ask", with: "Owner", phase: "build", ask: null }));
  const row = withDec.initRow(withDec.state.initiatives[0]);
  assert.match(row, /ow-line">waiting on you: /, "the card says what it waits on");
  assert.match(row, /<div class="step waits ask" title="Build/, "and its Build tile is the red and white stripes one");
  assert.match(row, /<span class="state [a-z ]*">Waiting on you<\/span>/, "the pill says so");
  assert.doesNotMatch(row, /<div class="wait gate/, "no red Gated box in front of the tile any more");
  // (the page's own stalled() is gone, #C1385: the stall is asked of the reading; the control is that without the decision there is no owner wait)
  const without = load([]);
  assert.equal(without.ownerWait(without.state.initiatives[0]), null);
});

test("its thread sits under Needs you with a waiting-on-you badge, even when others wrote after the decision", () => {
  const wrote = load([decision(now - 20 * MIN), owner("m2", now - 10 * MIN, "can you show me both?")]);
  assert.equal(wrote.waitsOn("t-1", now), "answered", "the owner's own word is the newest: without the rule this thread reads With the team");
  const b = load([decision(now - 20 * MIN), owner("m2", now - 10 * MIN, "can you show me both?"), note("m3", now - 5 * MIN)]);
  assert.equal(b.waitsOn("t-1", now), "answered");
  assert.deepEqual([...b.threadSets(now, "").answered], ["t-1"]);
  assert.match(b.threadRow("t-1", now), /t-badge you/);
  assert.ok(b.tabCounts(now, "").you >= 1, "it counts in the Needs you tab");
});

test("it ends when the owner picks, or when the decision is resolved", () => {
  for (const [name, messages] of [["picked", [decision(now - 20 * MIN), owner("m2", now - 5 * MIN, "Chose A: Left")]], ["resolved", [decision(now - 20 * MIN), note("m2", now - 5 * MIN)].map((m, k) => (k ? { ...m, resolved: 1 } : m))]]) {
    const b = load(messages);
    assert.equal(gate(b.state.initiatives[0]).length, 0, `${name}: no gate`);
    assert.equal(b.ownerWait(b.state.initiatives[0]), null, `${name}: not waiting on the owner`);
    assert.ok(!/t-badge you/.test(b.threadRow("t-1", now)), `${name}: no waiting-on-you badge`);
  }
});

test("a decision in a thread that is not a card's, a plain question and a closed card change nothing", () => {
  const other = load([decision(now - 20 * MIN, { thread: "t-9" })]);
  assert.equal(gate(other.state.initiatives[0]).length, 0);
  const plain = load([{ id: "q", thread: "t-1", from: "Manager", text: "Any thoughts?", at: now - 20 * MIN }]);
  assert.equal(gate(plain.state.initiatives[0]).length, 0);
  const done = load([decision(now - 20 * MIN)], raw({ status: "done" }));
  assert.equal(gate(done.state.initiatives[0]).length, 0);
});

// Checker 2's F1 on 290dca8c: the Needs-you rule is for a card's thread only. A decision in a thread no card holds keeps the bucket it had: the owner wrote after it, so it is With the team ("lead").
test("a decision in a thread no card holds keeps its bucket: the owner's reply after it reads With the team, not Needs you", () => {
  const b = load([decision(now - 20 * MIN, { thread: "t-9" }), { id: "m2", thread: "t-9", from: "Owner", text: "can you show me both?", at: now - 10 * MIN }]);
  assert.equal(b.waitsOn("t-9", now), "lead");
  assert.deepEqual([...b.threadSets(now, "").answered], [], "not under Needs you");
  assert.ok([...b.threadSets(now, "").open].includes("t-9"), "under With the team, as before");
});

test("a card already held by an open ask gets no second gate from the decision", () => {
  const b = loadNames(NAMES);
  Object.assign(b.state, { messages: [decision(now - 20 * MIN)], threads: [{ id: "t-1", num: 7 }], steps: [], derived: [], meta: [], todo: [], ideas: [], initRaw: [raw()],
    waiting: [{ id: "w1", kind: "decision", initiative: "c1-look", text: "Pick the plan", since: now - 30 * MIN, options: two }] });
  assert.equal(gate(b.gates(b.enrich(raw()))).length, 1);
});
