// #C864 step 3, #C999: the probe's cards are the store's cards as they are (collector/store-cards.mjs writes them from the store into
// <state>/<board>/store-cards.json; a close is already on the store's card). The old gate's journal and the old board's mirror/ went
// with the old Collector: a gate.json or a mirror/ folder beside the file is not read.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveCards, readStoreCards } from "../collector/state.mjs";

const MIN = 60e3, now = Date.parse("2026-11-10T18:00:00Z");

// A state folder on disk as the probe sees it: <state>/<board>/store-cards.json, optionally with the old files beside it.
const build = ({ cards, at = now, old = false }) => {
  const state = mkdtempSync(join(tmpdir(), "jc-state-")), board = join(state, "b");
  mkdirSync(board, { recursive: true });
  if (cards) writeFileSync(join(board, "store-cards.json"), JSON.stringify({ at, cards }));
  if (old) {
    mkdirSync(join(board, "mirror", "initiatives"), { recursive: true });
    writeFileSync(join(board, "mirror", "initiatives", "old-one.json"), JSON.stringify({ status: "active" }));
    writeFileSync(join(board, "mirror", "_at.json"), JSON.stringify({ at: now }));
    writeFileSync(join(board, "gate.json"), JSON.stringify({ journal: [{ op: "update", collection: "initiatives", doc_id: "a-b", data: { status: "done" }, at: now - MIN }] }));
  }
  return { state, board };
};
const statusOf = (list, id) => list.find((k) => k.id === id)?.status;

test("liveCards: the store's cards as they are, each with its id; an old gate.json or mirror/ folder beside them is not read", () => {
  const { state } = build({ cards: { "a-b": { status: "active", who: "Demos" }, "c-d": { status: "done", who: "Demos" } }, old: true });
  try {
    const cards = liveCards(state, "b");
    assert.deepEqual(cards.map((k) => k.id).sort(), ["a-b", "c-d"], "the old mirror's card is not there");
    assert.equal(statusOf(cards, "a-b"), "active", "a close in the old journal is not laid over the store's card");
    assert.equal(statusOf(cards, "c-d"), "done");
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("liveCards without the file, or with a torn or odd one, is none; readStoreCards gives the read's time", () => {
  const { state } = build({ cards: { "a-b": { status: "active" } }, at: now - 5 * MIN });
  const none = build({ old: true }), odd = build({});
  try {
    assert.deepEqual(liveCards(state, "b").map((k) => k.id), ["a-b"]);
    assert.equal(readStoreCards(state, "b").at, now - 5 * MIN);
    assert.deepEqual(liveCards(join(state, "nowhere"), "b"), []);
    assert.deepEqual(liveCards(none.state, "b"), [], "only the old mirror: no cards");
    writeFileSync(join(odd.board, "store-cards.json"), "{not json");
    assert.deepEqual(liveCards(odd.state, "b"), []);
    assert.deepEqual(readStoreCards(odd.state, "b"), { at: 0, cards: {} });
    writeFileSync(join(odd.board, "store-cards.json"), JSON.stringify({ at: 5 }));
    assert.deepEqual(liveCards(odd.state, "b"), [], "whole JSON with no cards key: none, no throw");
    writeFileSync(join(odd.board, "store-cards.json"), JSON.stringify({ at: 5, cards: [{ id: "x" }] }));
    assert.deepEqual(liveCards(odd.state, "b"), [], "cards as a list: none");
  } finally { for (const d of [state, none.state, odd.state]) rmSync(d, { recursive: true, force: true }); }
});
