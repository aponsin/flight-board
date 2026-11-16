// #C864 step 3: the probe's cards are the store mirror's cards as they are (collector/store-cards.mjs writes them from the store; a close is already on the
// store's card). The old gate's journal (gate/gate.mjs journalCards, readJournal, liveMirror) went with the old gate; a gate.json beside the mirror is not read.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveCards } from "../collector/state.mjs";

const MIN = 60e3, now = Date.parse("2026-11-10T18:00:00Z");
const w = (doc_id, data, at, op = "update", collection = "initiatives") => ({ op, collection, doc_id, data, at });

// A state folder on disk as the probe sees it: <state>/<board>/mirror/{initiatives/<id>.json, _at.json} and gate.json.
const build = ({ cards, stamp = null, journal }) => {
  const state = mkdtempSync(join(tmpdir(), "jc-state-")), board = join(state, "b"), mdir = join(board, "mirror", "initiatives");
  mkdirSync(mdir, { recursive: true });
  for (const [id, { data, at }] of Object.entries(cards)) { const p = join(mdir, `${id}.json`); writeFileSync(p, JSON.stringify(data)); utimesSync(p, at / 1000, at / 1000); }
  if (stamp !== null) writeFileSync(join(board, "mirror", "_at.json"), JSON.stringify({ at: stamp }));
  if (journal) writeFileSync(join(board, "gate.json"), JSON.stringify({ journal }));
  return { state, board };
};
const statusOf = (list, id) => list.find((k) => k.id === id)?.status;

test("liveCards (the probe): the mirror's cards as they are; a gate.json journal beside them is not read (the store's cards already carry a close)", () => {
  const { state } = build({
    cards: { "a-b": { data: { status: "active", who: "Demos" }, at: now - 50 * MIN }, "c-d": { data: { status: "done", who: "Demos" }, at: now - 5 * MIN } },
    journal: [w("a-b", { status: "done" }, now - 10 * MIN), w("c-d", { status: "active" }, now - 1 * MIN)],
  });
  const cards = liveCards(state, "b");
  assert.equal(statusOf(cards, "a-b"), "active", "a close in the old journal is not laid over the store's card");
  assert.equal(statusOf(cards, "c-d"), "done", "nor is a reopening");
});

test("liveCards without a journal or a mirror is the mirror's cards, or none", () => {
  const { state } = build({ cards: { "a-b": { data: { status: "active" }, at: now } } });
  assert.deepEqual(liveCards(state, "b").map((k) => k.id), ["a-b"]);
  assert.deepEqual(liveCards(join(state, "nowhere"), "b"), []);
});

test("a merge that wrote a card's file after a close in the old journal still shows the store's card (the probe no longer reads the journal)", () => {
  const T = (hhmm) => Date.parse(`2026-11-10T${hhmm}:00Z`);
  const { state } = build({ cards: { "a-b": { data: { status: "active", who: "Demos" }, at: T("10:05") } }, stamp: T("10:00"), journal: [w("a-b", { status: "done" }, T("10:03"))] });
  assert.equal(statusOf(liveCards(state, "b"), "a-b"), "active");
});
