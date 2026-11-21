// #C1398: an ask the owner has answered is not a wait for the reading, though it stays open in the store until it is closed. Only the reading's `ask` wait follows
// `answered_at`; the open-ask lists, the inbox and the gates still read the open asks as they did. Through the whole path: view -> compatView -> readings.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compatView } from "../worker/compat-view.mjs";

const VIEW = JSON.parse(readFileSync(new URL("./fixtures/view-recorded.json", import.meta.url), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
// An open card of the recorded view with nothing to wait on (state working, no wait).
const ID = "product-card-closes-on-live";
const ask = (num, patch = {}) => ({ id: `t${num}`, num, card_id: ID, closed_at: null, ...patch });
const readingWith = (asks) => { const v = clone(VIEW); v.asks = asks; return compatView(v).collections.readings.find((d) => d.id === ID); };
const answered = () => ({ answered_at: VIEW.now - 60_000, answered_by: "owner", answer: "Done" });

test("control: an open unanswered ask is a wait, with its number", () => {
  const r = readingWith([ask(9001)]);
  assert.equal(r.wait, "ask");
  assert.equal(r.ask, 9001);
});

test("an answered ask that is not closed is no wait: the card reads its next state", () => {
  const base = readingWith([]);
  const r = readingWith([ask(9001, answered())]);
  assert.notEqual(r.wait, "ask");
  assert.ok(!("ask" in r) || r.ask == null);
  assert.equal(r.state, base.state);
  assert.equal(r.wait, base.wait);
});

test("an answered and closed ask is no wait", () => {
  const r = readingWith([ask(9001, { ...answered(), closed_at: VIEW.now - 1000 })]);
  assert.notEqual(r.wait, "ask");
});

test("an answered ask beside a second open unanswered ask: the card waits on the second", () => {
  const r = readingWith([ask(9001, answered()), ask(9002)]);
  assert.equal(r.wait, "ask");
  assert.equal(r.ask, 9002);
});

test("the served reading of the recorded view's own ask row, put on the card: waits while open, no ask wait once answered", () => {
  const served = (patch) => { const v = clone(VIEW); v.asks[0] = { ...v.asks[0], card_id: ID, ...patch }; return compatView(v).collections.readings.find((d) => d.id === ID); };
  assert.equal(served({}).wait, "ask");
  assert.equal(served({}).ask, VIEW.asks[0].num);
  const r = served(answered());
  assert.notEqual(r.wait, "ask");
  assert.notEqual(r.ask, VIEW.asks[0].num);
});
