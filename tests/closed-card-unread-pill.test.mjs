// #C1283 (the owner, t-1795129984181: the "N new replies" pill showed only on an open card, but his default is closed cards): a card inside a
// group shows the same pill on its closed summary line, with today's count (#C1266: replies from anyone but the owner, after the thread was last
// marked read). No pill when nothing is new. Which messages count is not changed here.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const NAMES = ["groupRow", "gates", "enrich", "probeEvent", "state", "newReplies", "seenAt", "newPill", "threadOf", "OWNER", "initRow"];
const T = 1_800_000_000_000;
const msg = (from, text, at) => ({ id: `m${at}`, thread: "x", from, text, at });
function board(messages) {
  const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const store = new Map();
  const realNow = Date.now; Date.now = () => T;
  const b = loadNames(NAMES, { document, localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => void store.set(k, String(v)) } });
  b.seenAt("x"); // the first visit at T is the baseline
  Date.now = realNow;
  const raw = [{ id: "x", num: 1, name: "X", size: "S", level: "Quick", status: "active", phase: "build", who: "Boardsmith", repo: "flight-board", batch: "g", createdAt: T }];
  Object.assign(b.state, { initRaw: raw, initiatives: raw.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages, threads: [] });
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 20e3 }, cards: {}, agents: {} } } }, {});
  // the summary line is what a closed card shows: the text between <summary> and </summary> of the g-card
  return () => { const html = b.groupRow("g", b.state.initiatives); return html.match(/<div class="g-card"><details[^>]*><summary>(.*?)<\/summary>/s)[1]; };
}

test("a closed card in a group shows the new-reply pill on its summary line, one reply in the singular", () => {
  const summary = board([msg("Owner", "q", T + 1), msg("Manager", "a", T + 2)]);
  assert.match(summary(), /<strong>X<\/strong><span class="newpill"[^>]*>1 new reply<\/span>/);
});

test("it is today's count: the owner's own words and replies from before the baseline do not count, and several read as replies", () => {
  const summary = board([msg("Manager", "old", T - 5), msg("Owner", "q", T + 1), msg("Manager", "a", T + 2), msg("Manager", "b", T + 3)]);
  assert.match(summary(), /<span class="newpill"[^>]*>2 new replies<\/span>/);
});

test("with nothing new there is no pill", () => {
  const summary = board([msg("Owner", "q", T + 1)]);
  assert.doesNotMatch(summary(), /newpill/);
});
