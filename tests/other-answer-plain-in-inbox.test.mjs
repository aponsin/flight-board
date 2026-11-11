// #C932: an imported "something else" answer (the old response object kept whole as the answer string, no answer_status) reached Manager's
// inbox as raw JSON. takeInbox now returns the owner's typed text, as it does for a native answer; no row is rewritten. Fictional text.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createAsk, answerAsk, takeInbox } from "../worker/board-store.mjs";

const T = 1_800_000_000_000;
const TEXT = "Use the green one, but darker";
const decision = (title) => ({ type: "Decision", title, question: "Which colour?", options: ["Blue", "Green"], recommended: "Green", asked_by: "Manager" });
const asked = async (db, title, d = decision(title)) => { const r = await createAsk(db, T, d); assert.equal(r.ok, true, JSON.stringify(r)); return r.id; };
const importAnswer = (db, id, answer) => db.prepare("UPDATE asks SET answered_at = ?, answer = ?, answered_by = 'owner', answer_status = NULL, answer_note = NULL WHERE id = ?").bind(T + 5, answer, id).run();

test("an imported something-else answer reaches the inbox as the typed text, not as the response object; the stored row stays as it was", async () => {
  const db = makeDb(), id = await asked(db, "Hero colour");
  const raw = JSON.stringify({ status: "chose", choice: "something else", note: TEXT, at: T + 5 });
  await importAnswer(db, id, raw);
  const got = await takeInbox(db, T + 10);
  assert.equal(got.answers.length, 1);
  assert.equal(got.answers[0].answer, TEXT);
  assert.doesNotMatch(JSON.stringify(got.answers[0]), /"status\\?":|something else/, "no object in what Manager reads");
  assert.equal((await db.prepare("SELECT answer FROM asks WHERE id = ?").bind(id).first()).answer, raw, "no row rewritten");
});

test("an imported answer whose note is empty reads as Something else, as a native one does", async () => {
  const db = makeDb(), id = await asked(db, "Empty note");
  await importAnswer(db, id, JSON.stringify({ status: "chose", choice: "something else", note: "  " }));
  assert.equal((await takeInbox(db, T + 10)).answers[0].answer, "Something else");
});

test("must still read as before: a native something-else, a chosen option, an answer with a status, plain text, and text that only looks like JSON", async () => {
  const db = makeDb();
  const native = await asked(db, "Native other"), option = await asked(db, "Option"), plain = await asked(db, "Plain"), broken = await asked(db, "Broken"), withStatus = await asked(db, "Has status");
  assert.equal((await answerAsk(db, T + 2, "owner", { id: native, status: "chose", other: true, note: TEXT })).ok, true);
  assert.equal((await answerAsk(db, T + 2, "owner", { id: option, answer: "Blue" })).ok, true);
  await importAnswer(db, plain, "just words");
  await importAnswer(db, broken, "{not json");
  await importAnswer(db, withStatus, '{"note":"looks like json"}');
  await db.prepare("UPDATE asks SET answer_status = 'other', answer_note = 'typed in the store' WHERE id = ?").bind(withStatus).run();
  const by = Object.fromEntries((await takeInbox(db, T + 10)).answers.map((a) => [a.title, a.answer]));
  assert.deepEqual(by, { "Native other": TEXT, Option: "Blue", Plain: "just words", Broken: "{not json", "Has status": '{"note":"looks like json"}' });
});
