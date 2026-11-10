// The dry run reads the PAGE's rules (Director's ruling on step 4): the Resolved list counts a thread with messages whose newest message is
// resolved, or whose ask is closed, or whose card is done; its clock is the thread's newest message; the In flight count is what the page
// draws (a card that reads live, on main, with no check date is hidden); a dropped card (status "dropped") is not open work.
import test from "node:test";
import assert from "node:assert/strict";
import { planHistory } from "../collector/import-history.mjs";
import { compareTabs, oldResolved, storeResolvedAfter } from "../collector/import-compare.mjs";

const DAY = 86_400_000, NOW = 1_794_348_480_000;
const msg = (thread, at, extra = {}) => ({ thread, from: "Manager", text: "hi", at, ...extra });
const hist = (docs, have = {}) => planHistory(docs, { now: NOW, days: 30, owner: "Owner", roster: ["Manager"], lead: "Manager", have: { historyCardIds: new Set(), cardIds: new Set(), ...have } });
const done = (extra = {}) => ({ status: "done", name: "A done card", doneAt: NOW - 3 * DAY, ...extra });

test("the thread of a DONE card comes in whatever its last message says, when its newest message is in the window", () => {
  const docs = { initiatives: { "fin-1": done(), "old-1": done({ doneAt: NOW - 3 * DAY }), "open-1": { status: "active", name: "x" } }, messages: { a: msg("fin-1", NOW - 2 * DAY), b: msg("old-1", NOW - 40 * DAY), c: msg("open-1", NOW - DAY) }, threads: { "fin-1": { num: 900 }, "old-1": { num: 901 }, "open-1": { num: 902 } }, waiting: {} };
  const h = hist(docs);
  assert.deepEqual(h.messages.map((m) => m.thread_id), ["fin-1"], "the done card's thread, not the old one (newest message outside), not the open card's");
  assert.equal(h.report.resolved.viaDoneCard, 1);
  assert.deepEqual(h.threads.map((t) => t.id), ["fin-1"], "with its #T row");
});

test("a done card the store does not keep as a history card brings no thread", () => {
  const docs = { initiatives: { "fin-1": done({ doneAt: NOW - 90 * DAY }) }, messages: { a: msg("fin-1", NOW - DAY) }, threads: { "fin-1": { num: 900 } }, waiting: {} };
  assert.equal(hist(docs).messages.length, 0, "outside the window, so no history card, so the page would not call it done");
  assert.equal(hist(docs, { historyCardIds: new Set(["fin-1"]) }).messages.length, 1, "a history card the store already holds does");
});

test("the Resolved clock is the newest message: a ask closed long ago whose thread is still talking comes in, and shows", () => {
  const docs = { initiatives: {}, waiting: { "ask-1": { done: true, kind: "answer", text: "q", doneAt: NOW - 45 * DAY, thread: "ask-1" } }, messages: { a: msg("ask-1", NOW - 2 * DAY) }, threads: { "ask-1": { num: 950 } } };
  const h = hist(docs);
  assert.equal(h.asks.length, 1, "closed 45 days ago, newest message 2 days ago: in");
  const docsOld = { ...docs, messages: { a: msg("ask-1", NOW - 45 * DAY) } };
  assert.equal(hist(docsOld).asks.length, 0, "both old: out");
  const after = storeResolvedAfter({ threads: { messages: [] }, asks: [], historyCards: [] }, h, NOW);
  assert.equal(after.get("ask-1").why, "ask-closed");
});

test("the store's resolved set follows the page: a thread with no message is not listed, a done card's thread is", () => {
  const view = { threads: { messages: [{ id: "m1", thread_id: "card-t", created_at: NOW - DAY, resolved: 0 }, { id: "m2", thread_id: "plain", created_at: NOW - DAY, resolved: 0 }] }, asks: [{ id: "no-msgs", closed_at: NOW - DAY }], historyCards: [{ id: "card-t" }] };
  const r = storeResolvedAfter(view, null, NOW);
  assert.deepEqual([...r.keys()], ["card-t"], "closed ask with no message: not listed; plain open thread: not resolved");
  assert.equal(r.get("card-t").why, "card-done");
});

test("the old rule counts a done card's thread too (it was 19 short of the page)", () => {
  const docs = { initiatives: { "fin-1": done(), "gone-1": done({ dropped: true }) }, messages: { a: msg("fin-1", NOW - DAY), b: msg("gone-1", NOW - DAY) }, waiting: {}, threads: {} };
  assert.deepEqual([...oldResolved(docs, NOW).keys()], ["fin-1"]);
});

test("in flight is what the page draws: live + on main + no check date is hidden; a dropped card is not open work", () => {
  const cards = [{ id: "live-1" }, { id: "checked-1", check_at: NOW + DAY }, { id: "ship-1" }, { id: "bare-1" }];
  // A reading the page accepts (a known phase, a 12-hex head, a fresh time): the page decides which cards it draws, not a rule here.
  const ev = (phase, onMain) => ({ value: { lit: [phase], num: 900, phase, headSha12: "a1b2c3d4e5f6", signed: [], onMain, ci: "none", ciMin: null, liveVersion: phase === "live" ? "1.2.3" : null, at: NOW - 5e3 } });
  const view = { now: NOW, cards, asks: [], threads: { messages: [] }, evidence: { "cards.live-1": ev("live", true), "cards.checked-1": ev("live", true), "cards.ship-1": ev("ship", false) } };
  const docs = { initiatives: { "live-1": { status: "active" }, "checked-1": { status: "active" }, "ship-1": { status: "active" }, "bare-1": { status: "active" }, "drop-1": { status: "dropped" }, "done-1": { status: "done" } }, messages: {}, waiting: {} };
  const t = compareTabs({ docs, view, p: { insert: [] }, a: { counts: {} }, h: null, now: NOW, expect: { inflight: 4 } });
  // The store's compat view marks a card read at its last phase done (applyShips), a check date or not: the page then does not draw it.
  // That is read off the page here, not decided here.
  assert.deepEqual(t.inflight.hiddenByEvidence.ids, ["checked-1", "live-1"]);
  assert.deepEqual(t.inflight.drawn.map((d) => d.id), ["bare-1", "ship-1"]);
  assert.equal(t.inflight.ours, 2);
  assert.equal(t.inflight.storeOpen, 4);
  assert.equal(t.inflight.oldPageByRule, 4, "the dropped card is not counted open on the old side");
  assert.equal(t.inflight.drawn.find((d) => d.id === "bare-1").why, "no evidence (no commit carries its id yet)");
});

test("a #T number a closed ask finds taken is listed with its holder, and whether it is the same item", () => {
  const docs = { initiatives: {}, waiting: { "ask-a": { done: true, kind: "answer", text: "q", doneAt: NOW - DAY, thread: "ask-a" }, "ask-b": { done: true, kind: "answer", text: "q2", doneAt: NOW - DAY, thread: "ask-b" } }, messages: { a: msg("ask-a", NOW - DAY), b: msg("ask-b", NOW - DAY) }, threads: { "ask-a": { num: 960 }, "ask-b": { num: 960 } } };
  const h = hist(docs, { threadNums: new Set([960]), threadNumHolders: new Map([[960, "ask-a"]]) });
  assert.equal(h.report.closedAsks.numTaken, 2);
  const byAsk = Object.fromEntries(h.report.closedAsks.numTakenList.map((x) => [x.ask, x]));
  assert.deepEqual([byAsk["ask-a"].heldBy, byAsk["ask-a"].sameItem], ["thread:ask-a", true], "the store's thread is this very item: the owner sees the same #T");
  assert.deepEqual([byAsk["ask-b"].heldBy, byAsk["ask-b"].sameItem], ["thread:ask-a", false], "another item holds it");
});

test("a closed ask that lost its #T to ANOTHER item brings its thread with only the newest message flagged resolved; one whose number is its own thread's does not (Security W3, W4)", () => {
  const docs = { initiatives: {}, waiting: { "ask-a": { done: true, kind: "answer", text: "q", doneAt: NOW - DAY, thread: "ask-a" }, "ask-b": { done: true, kind: "answer", text: "q2", doneAt: NOW - DAY, thread: "ask-b" } },
    messages: { a1: msg("ask-a", NOW - 2 * DAY), a2: msg("ask-a", NOW - DAY), b1: msg("ask-b", NOW - 2 * DAY), b2: msg("ask-b", NOW - DAY) }, threads: { "ask-a": { num: 960 }, "ask-b": { num: 960 } } };
  const h = hist(docs, { threadNums: new Set([960]), threadNumHolders: new Map([[960, "ask-a"]]) });
  const flags = (thread) => h.messages.filter((m) => m.thread_id === thread).sort((x, y) => x.created_at - y.created_at).map((m) => m.resolved);
  assert.deepEqual(flags("ask-a"), [], "the same item holds the number: the store already holds that thread, nothing is brought or flagged");
  assert.deepEqual(flags("ask-b"), [0, 1], "another item holds it: only the newest message is the closing one");
  assert.equal(h.report.closedAsks.clashResolved, 1);
});

test("the thread of a card the old board finished comes in when the store holds that card as a live card too (c722-portfolio-add-photo)", () => {
  const docs = { initiatives: { "fin-1": done() }, messages: { a: msg("fin-1", NOW - DAY) }, threads: { "fin-1": { num: 900 } }, waiting: {} };
  const old = { ...docs, initiatives: { "fin-1": done({ doneAt: NOW - 90 * DAY }) } };
  assert.equal(hist(old, { cardIds: new Set(["fin-1"]) }).messages.length, 1);
  assert.equal(hist(old).messages.length, 0, "a card the store knows neither way (finished long ago, no history card) brings nothing");
});

test("what is refused is named by old id and rule: a history card, a step, a message", () => {
  const docs = {
    initiatives: { "nodone-1": { status: "done", name: "No time" } }, waiting: {},
    steps: { "s-bad": { init: "x-1", at: NOW - DAY, kind: "build", phase: "build" }, "s-wait": { init: "x-1", at: NOW - DAY, kind: "start", phase: "build", wait: "Checker's turn" } },
    messages: { "m-empty": msg("t-1", NOW - DAY, { text: " ", resolved: true }), "m-ok": msg("t-1", NOW - DAY, { resolved: true }) }, threads: { "t-1": { num: 970 } },
  };
  const h = hist(docs);
  assert.deepEqual(h.report.historyCards.refusedList, [{ id: "nodone-1", rule: "no-done-time" }]);
  assert.deepEqual(h.report.steps.refusedList.map((x) => [x.id, x.rule]), [["s-bad", "kind build"], ["s-wait", "wait Checker's tu"]]);
  assert.deepEqual(h.report.resolved.refusedList.map((x) => [x.id, x.rule]), [["m-empty", "no-text"]]);
});
