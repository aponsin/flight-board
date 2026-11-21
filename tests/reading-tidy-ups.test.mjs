// #C1388: the four facts the page used to take from the evidence and now takes from the card's reading: waitsFor, building, branches (tests/one-row-per-branch.test.mjs has the branch
// records), version. And the page's four functions that read them, fed readings and nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import { reading } from "../worker/reading.mjs";
import { groupWaitsFor } from "../worker/group-rule.mjs";
import { loadNames } from "./harness.mjs";

const NOW = 1_795_208_000_000, SHA = "a".repeat(40);
const card = { id: "board-a", num: 1, repo: "flight-board", owner_role: "Boardsmith", batch: "g1" };
const ev = (over = {}) => ({ headSha: SHA, headSha12: SHA.slice(0, 12), phase: "checker", lit: ["checker"], onMain: false, stack: { tip: SHA.slice(0, 12), size: 2 }, at: NOW, ...over });
const read = (c, e, ctx = {}, agents = {}) => reading(c, e, [], agents, {}, NOW, ctx);

test("a card at review waits for its group: `waitsFor` names the cards, with id and number", () => {
  const mate = { id: "board-b", num: 2, batch: "g1" }, other = { id: "board-c", num: 3, batch: "g1" };
  const ctx = { cards: [card, mate, other], evidence: { "board-b": ev({ phase: "build", lit: ["build"] }), "board-c": undefined } };
  const r = read(card, ev(), ctx);
  assert.equal(r.wait, "group");
  assert.deepEqual(r.waitsFor, [{ id: "board-b", num: 2 }, { id: "board-c", num: 3 }]);
  assert.equal(groupWaitsFor(card, ev(), ctx.cards, ctx.evidence).length > 0, true, "the group wait is the same rule: the list is not empty");
  const built = read(card, ev(), { cards: [card, mate], evidence: { "board-b": ev({ lit: ["checker"] }) } });
  assert.notEqual(built.wait, "group");
  assert.equal("waitsFor" in built, false, "no group wait, no list");
});

test("`building`: a session on it, or a push of its own that is not on main; never a card on main, a queued card, a done card", () => {
  const agent = (role, cardId) => ({ [role]: { state: "working", card: cardId } });
  assert.equal(read({ ...card, batch: undefined }, ev(), {}).building, true, "pushed, not on main, nobody on it: waiting at its phase is building");
  assert.equal(read({ ...card, batch: undefined }, ev({ onMain: true, signed: ["checker"], packed: true, installed: true, phase: "live", lit: ["live"] }), {}).building, false, "live and done");
  assert.equal(read({ ...card, batch: undefined }, ev({ onMain: true, phase: "ship", lit: ["ship"], signed: ["checker"] }), {}).building, false, "on main, waiting for its pack or deploy");
  assert.equal(read({ ...card, batch: undefined }, undefined, {}).building, false, "no push, nobody on it: queued");
  assert.equal(read({ ...card, batch: undefined }, undefined, {}, agent("Boardsmith", "board-a")).building, true, "a session on it, nothing pushed yet");
  assert.equal(read({ ...card, batch: undefined }, ev({ stale: true, staleSince: NOW - 6e5 }), {}).building, true, "a stale reading keeps its last good state, so it is still a card with a push of its own");
  assert.equal(read({ ...card, batch: undefined }, ev({ stale: true, staleSince: NOW - 6e5 }), {}, agent("Checker", "board-a")).working, false, "but a stale reading is never working");
});

test("`version`: a live card's version as a plain fact, null for any other", () => {
  const live = ev({ onMain: true, phase: "live", lit: ["live"], packed: true, installed: true, liveVersion: "1.226.10", signed: ["checker"] });
  assert.equal(read({ ...card, batch: undefined, repo: "flight-board" }, live).version, "1.226.10");
  assert.equal(read({ ...card, batch: undefined }, ev({ liveVersion: "1.226.10" })).version, null, "not live yet");
  assert.equal(read({ ...card, batch: undefined }, ev({ phase: "live", lit: ["live"], liveVersion: "v1; <b>" })).version, null, "an odd value is not carried");
});

test("versionNote's group wait names the cards the reading says it waits for, one by number, several by count", () => {
  const b = loadNames(["liveCard", "versionNote", "versionNoteBase", "liveRun", "probeEvent", "readingOf"], { documentElement: { getAttribute: () => "store" } });
  b.state.initRaw = [{ id: "board-x", num: 1, status: "active" }];
  b.state.derived = [{ id: "all", cards: {} }];
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 20e3 }, cards: { "board-x": { headSha12: "a1b2c3d4e5f6", onMain: false, phase: "checker" } }, agents: {} } } });
  b.state.readings = [{ id: "board-x", phase: "checker", state: "waiting", wait: "group", with: "Checker", working: false, waitsFor: [{ id: "board-y", num: 1357 }] }];
  assert.equal(b.versionNote({ id: "board-x" }), "Waiting for #C1357");
  b.state.readings[0].waitsFor = [{ id: "a", num: 1 }, { id: "b", num: 2 }];
  assert.equal(b.versionNote({ id: "board-x" }), "Waiting for 2 cards");
  b.state.readings[0] = { ...b.state.readings[0], wait: "turn", waitsFor: undefined };
  assert.equal(b.versionNote({ id: "board-x" }), "Waiting for Checker", "no group wait in the reading: the reviewer, as before");
});

test("the page: closeableNow, groupWaitFor and liveBuilding say what the reading says, and nothing else", () => {
  const b = loadNames(["closeableNow", "groupWaitFor", "liveBuilding", "readingOf"], { documentElement: { getAttribute: () => "store" } });
  const R = (id, over) => ({ id, phase: "checker", state: "waiting", wait: null, with: "Checker", working: false, building: false, ...over });
  b.state.readings = [R("d", { state: "done", phase: "live" }), R("g", { wait: "group", waitsFor: [{ id: "x", num: 5 }, { id: "y" }] }), R("w", { building: true }), R("s", { state: "unknown", stale: true })];
  assert.equal(b.closeableNow({ id: "d", status: "active" }), true);
  assert.equal(b.closeableNow({ id: "d", status: "active", checkAt: Date.now() + 1e5 }), false, "a check still to run");
  assert.equal(b.closeableNow({ id: "d", status: "done" }), false);
  assert.equal(b.closeableNow({ id: "s", status: "active" }), false, "stale: never closes");
  assert.equal(b.closeableNow({ id: "nobody", status: "active" }), false, "no reading: no guess");
  assert.equal(b.liveBuilding("w"), true);
  assert.equal(b.liveBuilding("g"), false);
  assert.equal(b.liveBuilding("nobody"), false);
  assert.deepEqual(b.groupWaitFor({ id: "g", status: "active" }).map((k) => k.num ?? k.id), [5, "y"]);
  assert.equal(b.groupWaitFor({ id: "g", status: "paused" }).length, 0, "a paused card waits for no one");
  assert.equal(b.groupWaitFor({ id: "w", status: "active" }).length, 0, "a reading with no group wait");
});
