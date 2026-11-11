// #C955 (11-11 ~3:14 pm MT): a turn began with the app's compaction summary, which quotes the owner's earlier chat lines. The Stop hook read a
// quoted question as a new one and blocked the stop with an empty inbox. The summary is the app's, never the owner's words.
import test from "node:test";
import assert from "node:assert/strict";
import { ownTurnText } from "../gate/stop.mjs";

const user = (text, extra = {}) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, ...extra });
const asString = (text, extra = {}) => ({ type: "user", message: { role: "user", content: text }, ...extra });
const SUMMARY = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.\n\nSummary:\nThe user asked: "Which of the two cards should go first?" and "Can you ship it tonight?"';

test("#C955: a compaction summary that quotes the owner's questions is not the owner's words, as text, as a string, or marked by the transcript", () => {
  assert.equal(ownTurnText([user(SUMMARY)]), "");
  assert.equal(ownTurnText([asString(SUMMARY)]), "");
  assert.equal(ownTurnText([asString(SUMMARY.replace("This session is being", "Reworded"), { isCompactSummary: true })]), "", "the transcript's own mark is enough");
  assert.equal(ownTurnText([user(`  \n${SUMMARY}`)]), "", "leading blank space does not hide it");
});

test("#C955 must still count: a real owner question typed after a compaction, a question that quotes the summary's sentence mid-text, and the #C954 cases", () => {
  const typed = "Which of the two cards should go first?";
  assert.equal(ownTurnText([user(SUMMARY), user(typed)]), typed, "the summary drops, the question typed after it stays");
  assert.equal(ownTurnText([asString(SUMMARY, { isCompactSummary: true }), asString(typed)]), typed);
  const quoting = `Why did you write "This session is being continued from a previous conversation" at the top? Should it go?`;
  assert.equal(ownTurnText([user(quoting)]), quoting, "only a text that begins with the sentence is the app's");
  assert.equal(ownTurnText([user('<cross-session-message from="local_x">\nShould I rebase?\n</cross-session-message>')]), "", "a peer's question is still not the owner's (#C954)");
  assert.equal(ownTurnText([user(typed, { isCompactSummary: false })]), typed);
});
