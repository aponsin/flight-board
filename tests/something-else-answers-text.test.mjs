// #C912: an imported "something else" answer kept the old response object whole as the answer string; the page drew it as
// raw JSON. The compat view reads it as the owner's typed text, the way a native answer shows. Store-era rows are untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { waitingDoc, compatView } from "../worker/compat-view.mjs";
import { drawPage } from "./helpers/draw-page.mjs";

const NOW = Date.now(), MIN = 60e3;
const TEXT = "Use the green one, but darker";
// An old waiting doc answered with "something else" and a typed note, as the one-time import wrote it into the store (the importer is gone; this is the row it made):
// the old response object as JSON in the answer column and no answer_status. The row is kept here as data so the view's reading of it stays tested.
const AT = NOW - 2 * 36e5;
const old = { response: { status: "chose", choice: "something else", note: TEXT, at: AT } };
const imported = () => ({ id: "hero-colour", num: 41, type: "Decision", title: "Hero colour", asked_by: "Manager", card_id: null,
  body: JSON.stringify({ question: "Which hero colour?", options: ["Blue", "Green"], recommended: "Green" }), eta_at: null, eta_precondition: null,
  created_at: NOW - 3 * 36e5, answered_at: AT, answer: JSON.stringify({ status: "chose", choice: "something else", note: TEXT, at: AT }), answered_by: "owner", answer_taken_at: AT, closed_at: null });

test("the imported row's answer is the old object as a string, and the view reads the typed text from it, the way a native answer reads", () => {
  const row = imported();
  assert.match(row.answer, /^\{.*something else/, "the real imported shape: the object as JSON in the answer column, no answer_status");
  assert.equal(row.answer_status ?? null, null);
  const doc = waitingDoc(row);
  assert.deepEqual({ ...doc.response }, { status: "chose", choice: "something else", note: TEXT, at: old.response.at, taken: true });
  const native = waitingDoc({ ...row, answer: TEXT, answer_status: "other", answer_note: TEXT, answer_taken_at: row.answered_at });
  assert.deepEqual({ ...native.response }, { ...doc.response }, "same as a native something-else answer");
});

test("the page shows the owner's typed text for an imported something-else answer, never the response object", () => {
  const { collections, probe } = compatView({ tag: "t", now: NOW, live: { state: "unknown", age: null }, cards: [], asks: [imported()], lists: [], evidence: {} });
  const d = drawPage(collections, { probe, host: "store" });
  assert.ok(d.html.includes(TEXT), "the typed text is drawn");
  assert.ok(!/status(&quot;|")\s*:/.test(d.html) && !d.html.includes("something else&quot;"), "no raw JSON");
});

test("store-era rows are not touched: an option's label, an answer with an answer_status, and plain typed text keep their readings", () => {
  const row = imported();
  const label = waitingDoc({ ...row, answer: "Blue", answer_taken_at: row.answered_at }).response;
  assert.equal(label.choice, "A");
  assert.equal(label.note, undefined);
  const withStatus = waitingDoc({ ...row, answer: '{"note":"looks like json"}', answer_status: "other", answer_note: "typed in the store" }).response;
  assert.equal(withStatus.note, "typed in the store", "answer_status wins; the answer string is not parsed");
  const plain = waitingDoc({ ...row, answer: "just words" }).response;
  assert.equal(plain.note, "just words", "a plain string is the note, as before");
  const notObject = waitingDoc({ ...row, answer: "{not json" }).response;
  assert.equal(notObject.note, "{not json");
  const action = waitingDoc({ ...row, type: "Action", title: "Do it", body: "{}", answer: JSON.stringify({ status: "done", note: "x" }) }).response;
  assert.equal(action.note, undefined, "only a Decision's something-else is read this way");
});
