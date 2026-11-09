// #C697, #C701: the probe and the derive step see the cards as the board has them now (the gate's journal over the
// hourly mirror), so a card closed after the export is no longer dispatched to or nudged about.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalCards, readJournal, liveMirror } from "../gate/gate.mjs";
import { dispatchItems } from "../gate/reset.mjs";
import { closed, liveCards } from "../collector/state.mjs";

const MIN = 60e3, now = Date.parse("2026-11-10T18:00:00Z");
const mirror = (cards, atDoc, extra = {}) => ({ docs: { initiatives: cards, steps: [{ id: "s1" }], ...extra }, at: 0, atBy: {}, atDoc: { initiatives: atDoc } });
const card = (id, o = {}) => ({ id, status: "active", who: "Demos", phase: "build", ...o });
const w = (doc_id, data, at, op = "update", collection = "initiatives") => ({ op, collection, doc_id, data, at });

test("a card closed after the export is closed in the cards", () => {
  const m = mirror([card("a-b"), card("c-d")], { "a-b": now - 50 * MIN, "c-d": now - 50 * MIN });
  const out = journalCards(m, [w("a-b", { status: "done" }, now - 10 * MIN)]);
  assert.equal(out.docs.initiatives.find((k) => k.id === "a-b").status, "done");
  assert.equal(out.docs.initiatives.find((k) => k.id === "c-d").status, "active");
  assert.deepEqual(m.docs.initiatives[0].status, "active", "the mirror itself is not changed");
});

test("a write the export already holds does not count; a later reopening does", () => {
  const m = mirror([card("a-b")], { "a-b": now - 5 * MIN });
  assert.equal(journalCards(m, [w("a-b", { status: "done" }, now - 10 * MIN)]).docs.initiatives[0].status, "active", "older than the listing");
  const m2 = mirror([card("a-b")], { "a-b": now - 50 * MIN });
  const out = journalCards(m2, [w("a-b", { status: "done" }, now - 20 * MIN), w("a-b", { status: "active" }, now - 10 * MIN)]);
  assert.equal(out.docs.initiatives[0].status, "active", "reopened since");
});

test("only the cards change: other collections and other writes are left alone", () => {
  const m = mirror([card("a-b")], { "a-b": now - 50 * MIN });
  const out = journalCards(m, [w("s1", { x: 1 }, now - 1 * MIN, "update", "steps"), w("a-b", { nextNote: "hi" }, now - 1 * MIN)]);
  assert.deepEqual(out.docs.steps, [{ id: "s1" }]);
  assert.equal(out.docs.initiatives[0].nextNote, "hi");
  assert.equal(journalCards(m, []), m, "no journal: the same mirror");
  assert.equal(journalCards(m, null), m, "no journal: the same mirror");
  assert.equal(journalCards(null, [w("a-b", {}, now)]), null);
});

test("a journal key named like an object's machinery is skipped", () => {
  const m = mirror([card("a-b")], { "a-b": now - 50 * MIN });
  const out = journalCards(m, [w("a-b", JSON.parse('{"__proto__": {"status": "done"}, "constructor": 1}'), now - 1 * MIN)]);
  assert.equal(out.docs.initiatives[0].status, "active");
  assert.equal(Object.hasOwn(out.docs.initiatives[0], "constructor"), false);
});

test("readJournal: the gate's journal, or nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "jc-"));
  writeFileSync(join(dir, "gate.json"), JSON.stringify({ journal: [w("a-b", { status: "done" }, 5)] }));
  assert.equal(readJournal(join(dir, "gate.json")).length, 1);
  writeFileSync(join(dir, "bad.json"), "not json");
  assert.deepEqual(readJournal(join(dir, "bad.json")), []);
  writeFileSync(join(dir, "nojournal.json"), JSON.stringify({ journal: "x" }));
  assert.deepEqual(readJournal(join(dir, "nojournal.json")), []);
  assert.deepEqual(readJournal(join(dir, "missing.json")), []);
});

test("dispatch skips a card the journal closed, and still dispatches an open one (the #C694 and #C688 cases)", () => {
  const cards = [card("done-late"), card("still-open")];
  const m = mirror(cards, { "done-late": now - 50 * MIN, "still-open": now - 50 * MIN });
  const agents = { Demos: { state: "idle", since: now - 30 * MIN } };
  const args = (list) => ({ cards: list.filter((k) => !closed(k)), agents, roster: ["Demos"], lead: "Manager", now });
  assert.deepEqual(dispatchItems(args(m.docs.initiatives)).items.map((i) => i.card), ["done-late", "still-open"], "from the stale export both are dispatched");
  const fresh = journalCards(m, [w("done-late", { status: "done" }, now - 20 * MIN)]).docs.initiatives;
  assert.deepEqual(dispatchItems(args(fresh)).items.map((i) => i.card), ["still-open"]);
});

// A state folder on disk as the probe and the derive step see it: <state>/<board>/mirror/{initiatives/<id>.json, _at.json} and gate.json.
const build = ({ cards, stamp = null, journal }) => {
  const state = mkdtempSync(join(tmpdir(), "jc-state-")), board = join(state, "b"), mdir = join(board, "mirror", "initiatives");
  mkdirSync(mdir, { recursive: true });
  for (const [id, { data, at }] of Object.entries(cards)) { const p = join(mdir, `${id}.json`); writeFileSync(p, JSON.stringify(data)); utimesSync(p, at / 1000, at / 1000); }
  if (stamp !== null) writeFileSync(join(board, "mirror", "_at.json"), JSON.stringify({ at: stamp }));
  if (journal) writeFileSync(join(board, "gate.json"), JSON.stringify({ journal }));
  return { state, board };
};
const statusOf = (list, id) => list.find((k) => k.id === id)?.status;

test("liveCards (the probe): a close after the export applies; a write the export already holds does not (the file's own time is used)", () => {
  const { state } = build({
    cards: { "a-b": { data: { status: "active", who: "Demos" }, at: now - 50 * MIN }, "c-d": { data: { status: "active", who: "Demos" }, at: now - 5 * MIN }, "e-f": { data: { status: "active" }, at: now - 50 * MIN } },
    journal: [w("a-b", { status: "done" }, now - 10 * MIN), w("c-d", { status: "done" }, now - 10 * MIN), w("e-f", { status: "done" }, now - 20 * MIN), w("e-f", { status: "active" }, now - 10 * MIN)],
  });
  const cards = liveCards(state, "b");
  assert.equal(statusOf(cards, "a-b"), "done", "closed after the export");
  assert.equal(statusOf(cards, "c-d"), "active", "the export (5 min old) is newer than the close (10 min old): a card the lead closed and the owner reopened on the page stays open");
  assert.equal(statusOf(cards, "e-f"), "active", "closed, then reopened, both after the export");
});

test("liveCards without a journal or a mirror is the mirror's cards, or none", () => {
  const { state } = build({ cards: { "a-b": { data: { status: "active" }, at: now } } });
  assert.deepEqual(liveCards(state, "b").map((k) => k.id), ["a-b"]);
  assert.deepEqual(liveCards(join(state, "nowhere"), "b"), []);
});

test("Checker's timeline: the run read at 10:01, the lead closed at 10:03, the merge wrote the card's file at 10:05: still closed (the probe and the derive step)", () => {
  const T = (hhmm) => Date.parse(`2026-11-10T${hhmm}:00Z`);
  const { state, board } = build({ cards: { "a-b": { data: { status: "active", who: "Demos" }, at: T("10:05") } }, stamp: T("10:00"), journal: [w("a-b", { status: "done" }, T("10:03"))] });
  assert.equal(statusOf(liveCards(state, "b"), "a-b"), "done", "the probe");
  const m = liveMirror(join(board, "mirror"), join(board, "gate.json"));
  assert.equal(m.docs.initiatives.find((k) => k.id === "a-b").status, "done", "the derive step");
  // The same file with no stamp (a mirror from a whole export) is held to its own time: the close is older than it.
  const plain = build({ cards: { "a-b": { data: { status: "active" }, at: T("10:05") } }, journal: [w("a-b", { status: "done" }, T("10:03"))] });
  assert.equal(statusOf(liveCards(plain.state, "b"), "a-b"), "active");
  // A close before the run began is the run's to have seen: not applied again over a later reopening.
  const seen = build({ cards: { "a-b": { data: { status: "active" }, at: T("10:05") } }, stamp: T("10:04"), journal: [w("a-b", { status: "done" }, T("10:03"))] });
  assert.equal(statusOf(liveCards(seen.state, "b"), "a-b"), "active");
});

test("liveMirror: only the cards change; another collection and a missing mirror are left as they are", () => {
  const { board } = build({ cards: { "a-b": { data: { status: "active" }, at: now - 50 * MIN } }, journal: [w("a-b", { status: "done" }, now - 10 * MIN), w("s1", { x: 1 }, now - 1 * MIN, "update", "steps")] });
  mkdirSync(join(board, "mirror", "steps"), { recursive: true });
  writeFileSync(join(board, "mirror", "steps", "s1.json"), JSON.stringify({ y: 2 }));
  const m = liveMirror(join(board, "mirror"), join(board, "gate.json"));
  assert.equal(m.docs.initiatives[0].status, "done");
  assert.deepEqual(m.docs.steps, [{ id: "s1", y: 2 }]);
  assert.equal(liveMirror(join(board, "no-mirror"), join(board, "gate.json")), null);
});

test("a journal entry whose doc_id is not a string is skipped", () => {
  const m = mirror([card("a-b")], { "a-b": now - 50 * MIN });
  const out = journalCards(m, [w(5, { status: "done" }, now - 1 * MIN), w(null, { status: "done" }, now - 1 * MIN), w("a-b", { nextNote: "x" }, now - 1 * MIN)]);
  assert.deepEqual(out.docs.initiatives.map((k) => k.id), ["a-b"]);
  assert.equal(out.docs.initiatives[0].nextNote, "x");
});
