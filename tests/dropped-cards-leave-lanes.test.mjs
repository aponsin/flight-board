// #C995 (11-11 ~10:40 pm MT: the owner counted 12 cards at the Checker step; #C29, #C874, #C875 and #C892 were dropped or done long ago, but
// their last evidence still said "checker"). The probe stops reading a closed card and the store keeps its last reading, so the page's data
// (compat view) drops the phase of a dropped or done card unless it is live, and no agent tile names a closed card. Must still allow: a re-opened
// card returning to its lane; done cards still visible in Live and history.
import test from "node:test";
import assert from "node:assert/strict";
import { initiativeDoc, derivedDoc, probeDoc } from "../worker/compat-view.mjs";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000;
const ev = (phase, extra = {}) => ({ value: { lit: [phase], phase, headSha12: "aaaaaaaaaaaa", signed: [], liveVersion: extra.liveVersion, ...extra }, readAt: T });
const view = (cards) => ({ now: T, cards, evidence: Object.fromEntries(cards.map((c) => [`cards.${c.id}`, ev(c.lit, c.extra)])), history: [], asks: [] });
const card = (id, lit, f = {}) => ({ id, num: 1, title: id, owner_role: "Boardsmith", dropped: 0, done_at: null, lit, ...f });

test("a dropped or done card at a review phase has no phase in the page's data; an open one keeps it", () => {
  const v = view([card("open", "checker"), card("gone", "checker", { dropped: 1 }), card("closed", "checker", { done_at: T - 9e6 }), card("shipped", "live", { done_at: T, extra: { liveVersion: "3.1.0" } })]);
  const d = derivedDoc(v).cards, p = probeDoc(v).cards;
  assert.equal(d.open.phase, "checker");
  assert.equal(p.open.phase, "checker");
  for (const id of ["gone", "closed"]) {
    assert.equal(d[id].phase, undefined, `derived ${id}`);
    assert.equal(p[id].phase, undefined, `probe ${id}`);
    assert.equal(initiativeDoc(v.cards.find((c) => c.id === id), v.evidence[`cards.${id}`]).phase, undefined, `initiative ${id}`);
    assert.equal(p[id].headSha12, "aaaaaaaaaaaa", "the rest of the reading stays");
  }
  assert.equal(d.shipped.phase, "live", "a done card that went live keeps its Live phase (Live and history)");
  assert.equal(d.shipped.version, "3.1.0");
  assert.equal(initiativeDoc(v.cards[3], v.evidence["cards.shipped"]).status, "done");
});

test("a re-opened card returns to its lane: the same evidence, read once it is open again", () => {
  const reopened = view([card("back", "checker", { dropped: 0, done_at: null })]);
  assert.equal(derivedDoc(reopened).cards.back.phase, "checker");
  assert.equal(initiativeDoc(reopened.cards[0], reopened.evidence["cards.back"]).phase, "checker");
});

test("no agent tile names a dropped or done card the live reading last named; an open one is named", () => {
  const tileFor = (cardId) => {
    const b = loadNames(["agentOn", "probeEvent"]);
    b.state.initiatives = [{ id: "gone", status: "dropped" }, { id: "closed", status: "done" }, { id: "open", status: "active" }];
    b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 20e3 }, cards: {}, agents: { Checker: { state: "working", card: cardId, lastActivityAt: Date.now(), since: Date.now() - 60e3 } } } } }, {});
    return b.agentOn("Checker", [], "", Date.now()).items.map((i) => i.id);
  };
  assert.deepEqual([...tileFor("open")], ["open"]);
  assert.deepEqual([...tileFor("gone")], [], "dropped");
  assert.deepEqual([...tileFor("closed")], [], "done");
});
