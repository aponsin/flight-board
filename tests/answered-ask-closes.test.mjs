// answered-ask-left-open (#C987; the owner, 11-11 ~11:05 pm MT, on #T1837, #T1839 and #T1827 still listed With the team: "those look stuck?").
// (1) An answered Decision that Manager has taken, whose card's next_note or waiting_on changed after the answer, gets one line to Manager
// ("the board closes it at <time>"), then the store closes it 30 minutes after the card moved on. (2) A closed ask never lists as unanswered
// under With the team for the owner's word written before it closed.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { loadNames } from "./harness.mjs";
import { createCard, updateCard, createAsk, answerAsk, wakeAsk, takeInbox, reopenAsk } from "../worker/board-store.mjs";
import { movedOnAsks, AUTO_CLOSE_AFTER_MS, AUTO_CLOSED_BY } from "../worker/board-rules.mjs";

const T = 1_800_000_000_000, MIN = 60_000;
const decision = { type: "Decision", title: "Pick", asked_by: "Manager", question: "A or B?", options: ["A", "B"], recommended: "A" };
const askRow = (db, id) => db.prepare("SELECT * FROM asks WHERE id = ?").bind(id).first();
const cardRow = (db, id) => db.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first();

// A card with an answered Decision on it, the answer taken by Manager's inbox read.
async function answered(db, { take = true } = {}) {
  assert.equal((await createCard(db, T, "Manager", { id: "c", title: "C", next_note: "build it" })).ok, true);
  const a = await createAsk(db, T + MIN, { ...decision, card_id: "c" });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal((await answerAsk(db, T + 2 * MIN, "owner", { id: a.id, answer: "B" })).ok, true);
  if (take) await takeInbox(db, T + 3 * MIN);
  return a;
}
const lines = async (db, now) => (await takeInbox(db, now)).stalls.map((s) => s.reason);

test("moved_at: set when next_note or waiting_on changes value, not for the same words or another field", async () => {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "c", title: "C", next_note: "build it" });
  assert.equal((await cardRow(db, "c")).moved_at, null, "a new card has not moved on");
  await updateCard(db, T + 1, "Manager", { id: "c", next_note: "build it", title: "C2" });
  assert.equal((await cardRow(db, "c")).moved_at, null, "the same words and a title are no move");
  await updateCard(db, T + 2, "Manager", { id: "c", next_note: "ship it" });
  assert.equal((await cardRow(db, "c")).moved_at, T + 2);
  await updateCard(db, T + 3, "Manager", { id: "c", waiting_on: "Checker" });
  assert.equal((await cardRow(db, "c")).moved_at, T + 3);
  const direct = await updateCard(db, T + 4, "Manager", { id: "c", moved_at: 5 });
  assert.ok(!direct.ok || direct.changed === 0, "nobody writes it directly");
  assert.equal((await cardRow(db, "c")).moved_at, T + 3);
});

test("(1) an answered, taken Decision whose card moved on: one line to Manager, then closed by the board 30 min after the move", async () => {
  const db = makeDb(); const a = await answered(db);
  const moved = T + 10 * MIN;
  await updateCard(db, moved, "Manager", { id: "c", next_note: "the owner chose B: building it" });
  await wakeAsk(db, moved + MIN);
  const said = await lines(db, moved + MIN);
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.match(said[0], new RegExp(`^#T${a.num} is answered and #C\\d+ has moved on: the board closes it at \\d{1,2}:\\d\\d [ap]m MT$`));
  assert.doesNotMatch(said[0], /\d\dZ|UTC/, "Mountain Time, never Z");
  await wakeAsk(db, moved + AUTO_CLOSE_AFTER_MS - 1);
  assert.equal((await askRow(db, a.id)).closed_at, null, "not a minute early");
  assert.deepEqual(await lines(db, moved + AUTO_CLOSE_AFTER_MS - 1), [], "the line is told once");
  await wakeAsk(db, moved + AUTO_CLOSE_AFTER_MS);
  const r = await askRow(db, a.id);
  assert.equal(r.closed_at, moved + AUTO_CLOSE_AFTER_MS);
  assert.equal(r.closed_by, AUTO_CLOSED_BY);
  assert.equal(r.auto_closed_at, moved + AUTO_CLOSE_AFTER_MS);
  assert.equal(r.answer, "B", "the answer stays");
});

test("(1) must still allow: an answer Manager has not taken stays open, however long the card has moved on", async () => {
  const db = makeDb(); const a = await answered(db, { take: false });
  await updateCard(db, T + 10 * MIN, "Manager", { id: "c", waiting_on: "Checker" });
  await wakeAsk(db, T + 5 * 60 * MIN);
  assert.equal((await askRow(db, a.id)).closed_at, null);
});

test("(1) must still allow: a card that has not moved since the answer leaves the ask open", async () => {
  const db = makeDb(); const a = await answered(db);
  await updateCard(db, T + 30, "Manager", { id: "c", next_note: "asked the owner" }); // before the answer: no move after it
  await wakeAsk(db, T + 5 * 60 * MIN);
  assert.equal((await askRow(db, a.id)).closed_at, null);
  await updateCard(db, T + 6 * 60 * MIN, "Manager", { id: "c", title: "renamed" });
  await wakeAsk(db, T + 9 * 60 * MIN);
  assert.equal((await askRow(db, a.id)).closed_at, null, "a title is no move");
});

test("(1) an ask the board closed and someone reopened is not closed again", async () => {
  const db = makeDb(); const a = await answered(db);
  await updateCard(db, T + 10 * MIN, "Manager", { id: "c", next_note: "building" });
  await wakeAsk(db, T + 10 * MIN + AUTO_CLOSE_AFTER_MS);
  assert.ok((await askRow(db, a.id)).closed_at);
  assert.equal((await reopenAsk(db, T + 60 * MIN, "owner", a.id)).changed, 1);
  await wakeAsk(db, T + 3 * 60 * MIN);
  assert.equal((await askRow(db, a.id)).closed_at, null);
});

test("movedOnAsks: a help answer, another type, a withdrawn, closed or already auto-closed ask is left alone", () => {
  const cards = [{ id: "c", num: 7, moved_at: T + 10 * MIN }];
  const base = { id: "t-1", num: 5, type: "Decision", card_id: "c", answered_at: T + 2 * MIN, answer_taken_at: T + 3 * MIN, answer_status: "chose" };
  const one = movedOnAsks({ now: T + 41 * MIN, asks: [base], cards });
  assert.equal(one.length, 1); assert.equal(one[0].due, true); assert.equal(one[0].closeAt, T + 40 * MIN); assert.equal(one[0].card_id, "c");
  for (const [why, a] of [["help", { answer_status: "help" }], ["Action", { type: "Action" }], ["withdrawn", { withdrawn_at: T }], ["closed", { closed_at: T }], ["auto-closed once", { auto_closed_at: T }], ["not taken", { answer_taken_at: null }], ["no card", { card_id: "x" }]])
    assert.deepEqual(movedOnAsks({ now: T + 99 * MIN, asks: [{ ...base, ...a }], cards }), [], why);
  assert.deepEqual(movedOnAsks({ now: T + 99 * MIN, asks: [base], cards: [{ id: "c", num: 7, moved_at: T + 2 * MIN }] }), [], "moved at the answer, not after it");
  const late = movedOnAsks({ now: T, asks: [{ ...base, answer_taken_at: T + 20 * MIN }], cards });
  assert.equal(late[0].closeAt, T + 50 * MIN, "taken after the move: 30 min from the take");
  assert.equal(late[0].due, false);
});

// ---- (2) the page ----
function page(waiting, messages) {
  const b = loadNames(["waitsOn", "threadOpen", "lateTag", "OWNER"]);
  Object.assign(b.state, { initRaw: [], ideas: [], steps: [], waiting, derived: [], messages: messages.map((m) => ({ ...m, from: b.OWNER })), threads: [], initiatives: [], events: [] });
  return b;
}
const OWNER_SAYS = (at, text = "Is this done with pc39?") => ({ id: `m-${at}`, thread: "t-1", text, at });

test("(2) a closed ask with the owner's word before the close never lists as unanswered With the team", () => {
  const b = page([{ id: "t-1", kind: "decision", done: true, doneAt: T + 10 * MIN, since: T }], [OWNER_SAYS(T + 5 * MIN)]);
  assert.equal(b.threadOpen("t-1"), false);
  assert.notEqual(b.waitsOn("t-1", T + 60 * MIN), "lead");
  assert.equal(b.lateTag("t-1", T + 60 * MIN), "");
});

test("(2) must still allow: the owner's real question after the close waits on the team, and an open ask is unchanged", () => {
  const after = page([{ id: "t-1", kind: "decision", done: true, doneAt: T + 10 * MIN, since: T }], [OWNER_SAYS(T + 20 * MIN)]);
  assert.equal(after.threadOpen("t-1"), true);
  assert.equal(after.waitsOn("t-1", T + 60 * MIN), "lead");
  const open = page([{ id: "t-1", kind: "decision", since: T, response: { status: "chose", choice: "B", at: T + 2 * MIN } }], [OWNER_SAYS(T + 5 * MIN)]);
  assert.equal(open.threadOpen("t-1"), true, "an ask not closed: his word is still his question");
});
