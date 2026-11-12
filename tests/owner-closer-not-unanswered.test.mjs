// #C1039 (the owner, 11-12 ~2:50 pm MT: #T1880, #T1887, #T1892, #T1893 showed red "unanswered" and "Manager answering" though Manager had
// answered each; the owner's newest word in every one was a closer). After the team spoke, his word that asks nothing leaves the thread
// answered; a real follow-up still turns it red.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const m = (thread, from, text, at, extra = {}) => ({ id: `m${thread}${at}`, thread, from, text, at, ...extra });
const board = (threads) => {
  const b = loadNames(["threadOpen", "threadOf", "ackOnly", "itemOf", "ownerCloser", "threadState"]);
  Object.assign(b.state, { waiting: [], initRaw: [], initiatives: [], todo: [], ideas: [], threads: [], messages: threads.flat() });
  return b;
};
// A thread: the owner asks, Manager answers, the owner's newest word is `last`.
const thread = (id, last, extra = {}, opening = "Did the badge clear?") => [m(id, "Owner", opening, 1), m(id, "Manager", "Yes, it is live.", 2), m(id, "Owner", last, 3, extra)];

test("the four real shapes stay answered: a bare ok, \"I'll let you know\", \"archived it\", and a decision pick", () => {
  const cases = [["t-1880", "ok"], ["t-1887", "I'll let you know"], ["t-1892", "archived it"], ["t-1893", "Chose B: Ship it Monday"]];
  const b = board(cases.map(([id, last]) => thread(id, last)));
  for (const [id, last] of cases) { assert.equal(b.threadOpen(id), false, last); assert.notEqual(b.threadState(id), "question", last); }
});

test("more closers stay answered", () => {
  const closers = ["ok.", "OK!", "thanks", "Thank you", "got it", "I will let you know", "I'll check", "archived", "I archived it already", "deleted it", "Chose A: Red"];
  const b = board(closers.map((c, i) => thread(`t-c${i}`, c)));
  closers.forEach((c, i) => assert.equal(b.threadOpen(`t-c${i}`), false, c));
});

test("a real follow-up still turns red: a question, a request without a question mark, a closer with a request in it, a long note, a file", () => {
  const real = ["Why not sooner?", "ok, but can you also fix the badge?", "Please add a Close button", "thanks, but the badge is still red", "I'll let you know what I think but change the colour please",
    "archived it and now I need the other three archived too", "thanks, but fix it", "archived it, please add X", "I'll check, also add X", "thanks, still red", "Is it live?", "ok\nAnd one more thing: add the date", "x".repeat(200)];
  const b = board(real.map((c, i) => thread(`t-r${i}`, c)));
  real.forEach((c, i) => assert.equal(b.threadOpen(`t-r${i}`), true, c.slice(0, 40)));
  const withFile = board([thread("t-f", "ok", { assets: [{ name: "shot.png" }] })]);
  assert.equal(withFile.threadOpen("t-f"), true, "a file with it is not a closer");
  assert.equal(b.threadState("t-r0"), "question");
});

test("a closer needs the team to have spoken: the owner's own lone 'ok' still waits; a resolved or empty thread is unchanged", () => {
  const b = board([[m("t-a", "Owner", "I'll let you know", 1)], [m("t-b", "Owner", "archived it", 1), m("t-b", "Owner", "ok", 2)], []]);
  assert.equal(b.threadOpen("t-a"), true, "nobody has answered");
  assert.equal(b.threadOpen("t-b"), true, "only the owner's own words");
  assert.equal(b.threadOpen("t-none"), false);
  const c = board([[m("t-x", "Owner", "Q?", 1), m("t-x", "Manager", "A", 2), m("t-x", "Owner", "ok", 3, { resolved: true })]]);
  assert.equal(c.threadOpen("t-x"), false);
});

test("the decision pick is the page's own text: optionText's \"Chose K: label\" is a closer", () => {
  const b = board([]);
  assert.equal(b.ownerCloser({ text: "Chose B: Red" }), true);
  assert.equal(b.ownerCloser({ text: "chose B : red" }), true);
  assert.equal(b.ownerCloser({ text: "I chose B" }), false, "free text that merely mentions a choice is the owner's own word");
});
