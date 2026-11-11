// #C831: a conversation held on a card (thread id = card id) must show once the card is finished. On the store a card never gets status
// done (only evidence closes it: live, on main, no check date), so itemOf must hand the page the card AS SHOWN, as a Collector-closed card
// was on the old board; before, the raw card kept itemShown true for ever and the thread was in no thread tab.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const NOW = Date.now(), MIN = 60e3, ID = "fin-card";
const reading = (cards) => ({ v: 1, board: { boardId: "TestBoard42xyz", at: NOW - 5e3, probe: null, pageVersion: null }, cards, agents: {} });
const live = { num: 700, phase: "live", headSha12: "a1b2c3d4e5f6", signed: [], onMain: true, ci: "none", ciMin: null, liveVersion: "1.2.3", at: NOW - 5e3 };
const msg = (thread, from, text, at, extra = {}) => ({ id: `m${at}`, thread, from, text, at, ...extra });
function board({ card = {}, cards = { [ID]: live }, messages }) {
  const b = loadNames(["probeEvent", "itemOf", "itemShown", "threadResolved", "waitsOn"]);
  Object.assign(b.state, { initRaw: [{ id: ID, name: "A finished card", status: "active", phase: "live", ...card }], waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages, threads: [], plan: [], timings: [], steps: [] });
  b.probeEvent({ type: "data", result: { payload: reading(cards) } }, {});
  return b;
}

test("a card that reads live and on main is done for its thread: the thread lists under Resolved", () => {
  const b = board({ messages: [msg(ID, "Owner", "a question", NOW - 20 * MIN), msg(ID, "Manager", "answered", NOW - 10 * MIN)] });
  assert.equal(b.itemOf(ID).doc.status, "done", "the card as shown");
  assert.equal(b.itemShown(ID, NOW), false, "no longer drawn with its thread under it");
  assert.equal(b.threadResolved(ID), true);
  assert.equal(b.waitsOn(ID, NOW), "resolved");
});

test("with the owner's word last and unresolved the thread waits on the team, not resolved", () => {
  const b = board({ messages: [msg(ID, "Manager", "done", NOW - 20 * MIN), msg(ID, "Owner", "one more thing", NOW - 10 * MIN)] });
  assert.equal(b.waitsOn(ID, NOW), "lead");
  assert.equal(b.itemShown(ID, NOW), false);
});

test("a card still in flight keeps its thread under it (not live, or with a check date)", () => {
  const msgs = [msg(ID, "Owner", "q", NOW - 20 * MIN), msg(ID, "Manager", "a", NOW - 10 * MIN)];
  const building = board({ messages: msgs, cards: { [ID]: { ...live, phase: "build", onMain: false } } });
  assert.equal(building.itemOf(ID).doc.status, "active");
  assert.equal(building.itemShown(ID, NOW), true);
  const checked = board({ messages: msgs, card: { checkAt: NOW + 60 * MIN } });
  assert.equal(checked.itemShown(ID, NOW), true, "a check date keeps it open");
  assert.notEqual(checked.waitsOn(ID, NOW), "resolved");
});

test("itemOf hands the page a copy: the raw card is never changed (a write path must not send the shown status back)", () => {
  const b = board({ messages: [msg(ID, "Owner", "q", NOW - MIN)] });
  b.itemOf(ID);
  assert.equal(b.state.initRaw[0].status, "active");
  assert.equal(b.state.initRaw[0].doneByEvidence, undefined);
});
