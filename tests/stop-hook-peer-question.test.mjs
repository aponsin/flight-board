// #C954 (11-11 ~2:50 pm MT): Manager's Stop hook demanded a board answer for a question that came from a peer agent, not from the owner.
// The hook counts only what a person typed (ownTurnText): never another session's message, a task notification, an app event or a notice.
import test from "node:test";
import assert from "node:assert/strict";
import { ownTurnText } from "../gate/stop.mjs";

const user = (text) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const asString = (text) => ({ type: "user", message: { role: "user", content: text } });
const PEER = 'Should I rebase the chain first?\n<cross-session-message from="local_x" from-name="Boardsmith">\nShould I rebase the chain first?\n</cross-session-message>';

test("#C954: a question in a peer's message, a notification or an app event is not the owner's words", () => {
  const notOwner = [
    `Another Claude session sent a message:\n${PEER}`,
    `<system-reminder id="a1">\nAnother Claude session sent a message while you were working:\n${PEER}\n</system-reminder>`,
    '<task-notification><task-id>b1</task-id><summary>Which of the two should run next?</summary></task-notification>',
    "<side-sessions-event>The session you started finished. Want me to archive it?</side-sessions-event>",
    "<ci-monitor-event>The check failed. Fix it?</ci-monitor-event>",
    "[Cross-session delivery notice] your message to Security is held. Resend?",
    "[Cross-session idle notice] Checker is idle. Anything else?",
  ];
  for (const t of notOwner) {
    assert.equal(ownTurnText([user(t)]), "", t.slice(0, 60));
    assert.equal(ownTurnText([asString(t)]), "", `${t.slice(0, 40)} (as a string)`);
  }
  assert.equal(ownTurnText(notOwner.map(user)), "", "all of them together");
});

test("#C954 must still count: the owner's typed chat question, with or without a peer's message in the same turn, and with a reminder stripped", () => {
  const typed = "Which of the two cards should go first?";
  assert.equal(ownTurnText([user(typed)]), typed);
  assert.equal(ownTurnText([asString(typed)]), typed);
  assert.equal(ownTurnText([user(`Another Claude session sent a message:\n${PEER}`), user(typed)]), typed, "the peer's message drops, the owner's stays");
  assert.equal(ownTurnText([user(`${typed}<system-reminder>\nnoise\n</system-reminder>`)]).trim(), typed, "a reminder is cut from a typed line, as before");
});
