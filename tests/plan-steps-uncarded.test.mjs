// #C863 (half 1 of 3): an agent cannot close an answered plan or decision while the answer lists steps that name no card (a #C number). The refusal lists the uncarded
// steps; steps all carded, or no steps at all, close as before; the owner's own close is never refused. Halves 2 and 3 are plan-part-on-main and plan-file-without-card.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createAsk, answerAsk, closeAsk, postMessage } from "../worker/board-store.mjs";
import { planStepsRefusal, answerStepLines } from "../worker/board-rules.mjs";

const T = 1_800_000_000_000, MIN = 60_000;
const decision = { type: "Decision", title: "The plan", asked_by: "Manager", question: "Go on the plan?", options: ["A: go", "B: change it"], recommended: "A: go" };

// An answered Decision; the owner's word is the newest message so an agent may try the close.
async function answered(note, answer = "A: go") {
  const db = makeDb();
  const a = await createAsk(db, T, decision);
  assert.equal((await answerAsk(db, T + MIN, "owner", { id: a.id, status: "chose", answer, note })).ok, true);
  await postMessage(db, T + 2 * MIN, "owner", { thread_id: a.id, body: "Ack." });
  return { db, id: a.id };
}
const close = ({ db, id }, role = "agent") => closeAsk(db, T + 3 * MIN, "Manager", id, role);
const closedAt = async ({ db, id }) => (await db.prepare("SELECT closed_at FROM asks WHERE id = ?").bind(id).first()).closed_at;

test("steps that name no card are refused, and the refusal lists them", async () => {
  const w = await answered("1. Build the probe half\n2. Build the Worker half #C901\n3) Write the docs\n- Ship it");
  const r = await close(w);
  assert.equal(r.refused.rule, "plan-steps-uncarded");
  assert.match(r.refused.detail, /3 steps of the answer name no card/);
  assert.match(r.refused.detail, /Build the probe half/);
  assert.match(r.refused.detail, /Write the docs/);
  assert.match(r.refused.detail, /Ship it/);
  assert.doesNotMatch(r.refused.detail, /Worker half/, "a carded step is not listed");
  assert.equal(await closedAt(w), null, "still open");
  assert.equal((await w.db.prepare("SELECT rule FROM refusals").all()).results[0].rule, "plan-steps-uncarded", "the refusal is logged");
});

test("steps that all name a card close; so does an answer that lists no steps", async () => {
  const carded = await answered("1. Probe half: #C901\n2. Worker half: #C902\nStep 3: the docs #C903");
  assert.equal((await close(carded)).ok, true);
  assert.ok(await closedAt(carded));
  for (const note of ["Go as planned, thanks.", "", undefined]) assert.equal((await close(await answered(note))).ok, true, String(note));
});

test("the owner's own close is never refused, and an unrelated ask with list lines is not a plan", async () => {
  const w = await answered("1. no card here");
  assert.equal((await close(w, "owner")).ok, true);
  const db = makeDb();
  const a = await createAsk(db, T, { type: "Later", title: "L", asked_by: "Manager", text: "t", eta_at: T + 86_400_000 });
  await postMessage(db, T + MIN, "owner", { thread_id: a.id, body: "Ack." });
  assert.equal((await closeAsk(db, T + 2 * MIN, "Manager", a.id, "agent")).ok, true);
});

// M1: a plan posted as a Decision whose QUESTION lists the steps, answered "A: go" with no note. A question that uses "- " bullets for context blocks an agent's close too
// (the owner can always close); that is the price of reading the question.
async function answeredQuestion(question, options = ["A: go", "B: change it"]) {
  const db = makeDb();
  const a = await createAsk(db, T, { ...decision, question, options, recommended: options[0] });
  assert.equal((await answerAsk(db, T + MIN, "owner", { id: a.id, status: "chose", answer: options[0] })).ok, true);
  await postMessage(db, T + 2 * MIN, "owner", { thread_id: a.id, body: "Ack." });
  return { db, id: a.id };
}

test("steps listed in the question, answered 'A: go', are refused unless every step names a card", async () => {
  const bad = await answeredQuestion("Plan:\n1. Build the probe half\n2. Build the Worker half #C901\nGo?");
  const r = await close(bad);
  assert.equal(r.refused.rule, "plan-steps-uncarded");
  assert.match(r.refused.detail, /1 step of the answer name no card/);
  assert.match(r.refused.detail, /Build the probe half/);
  assert.equal(await closedAt(bad), null);
  const ok = await answeredQuestion("Plan:\n1. Probe half #C901\n2. Worker half #C902\nGo?");
  assert.equal((await close(ok)).ok, true);
  assert.equal((await close(await answeredQuestion("Plan:\n- context bullet\nGo?"))).refused.rule, "plan-steps-uncarded", "dash bullets in a question count");
  assert.equal((await close(await answeredQuestion("Plan:\n- context bullet\nGo?"), "owner")).ok, true, "the owner always closes");
  const inOption = await answeredQuestion("Go?", ["A: go\n1. do the thing", "B: no"]);
  assert.equal((await close(inOption)).refused.rule, "plan-steps-uncarded", "option text that lists steps counts");
});

test("not steps: '1.5 hours', '-1 point' and a bare '-' (L1)", () => {
  const ask = (note) => ({ id: "a", type: "Decision", answered_at: T, answer: "A", answer_note: note });
  for (const line of ["1.5 hours", "-1 point", "-", "2.5x faster", "*bold*", "3)"]) assert.equal(answerStepLines(ask(line)).length, 0, line);
  assert.equal(planStepsRefusal(ask("1.5 hours\n-1 point\n-")), null);
  assert.equal(answerStepLines(ask("1. a\n- b\n* c")).length, 3);
});

test("the pure rule: step lines, an answer that becomes a card on another type, a typed-other note, an unanswered ask", () => {
  const ask = (extra) => ({ id: "a", type: "Decision", answered_at: T, answer: "A", answer_note: null, ...extra });
  assert.deepEqual(answerStepLines(ask({ answer_note: "Intro\n1. one\n 2) two\n* three\n• four\nStep 5: five\nnot a step" })).length, 5);
  assert.equal(planStepsRefusal(ask({ answer_note: "1. one" })).rule, "plan-steps-uncarded");
  assert.equal(planStepsRefusal(ask({ answer: JSON.stringify({ note: "1. typed step" }) })).rule, "plan-steps-uncarded", "a typed something-else note counts");
  assert.equal(planStepsRefusal(ask({ type: "Answer", answer_note: "1. one" })), null, "not a decision, and it does not say it becomes a card");
  assert.equal(planStepsRefusal(ask({ type: "Answer", answer_note: "This becomes a card:\n1. one" })).rule, "plan-steps-uncarded");
  assert.equal(planStepsRefusal(ask({ answered_at: null, answer_note: "1. one" })), null, "unanswered: the unanswered rule speaks first");
  assert.equal(planStepsRefusal(null), null);
  const many = planStepsRefusal(ask({ answer_note: Array.from({ length: 8 }, (_, i) => `${i + 1}. step ${i}`).join("\n") }));
  assert.match(many.detail, /8 steps/);
  assert.match(many.detail, /; \.\.\.$/, "more than five are cut with an ellipsis");
  assert.match(many.detail, /step 4/);
  assert.doesNotMatch(many.detail, /step 5/, "only the first five steps are listed");
  assert.equal(planStepsRefusal(ask({ answer_note: "1. a real number #C123" })), null);
  assert.equal(planStepsRefusal(ask({ answer_note: "1. too many digits #C1234567" })).rule, "plan-steps-uncarded", "a card number is up to six digits");
});
