// #C1083: the page and the Worker read one ack list. A lone "Closed." or "Done" is an ack on the page too, so it never shows "answer coming" (the Worker already
// raised no owner-last-word line for it, #C1081). The word-for-word drift check is in tests/owner-last-word-stall.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";
import { ownerAck } from "../worker/push-rules.mjs";

const MIN = 60e3;
function page(messages) {
  const b = loadNames(["managerChip", "OWNER", "set:(p)=>{probe=p}"]);
  const now = Date.now();
  b.state.messages = messages(b.OWNER, now);
  b.set({ v: 1, board: { at: now, wakeAliveAt: now - 5e3, wakeSeenAt: now - MIN }, cards: {}, agents: {} });
  return b;
}
const msg = (from, at, text, thread = "t1") => ({ id: `m${at}${from}`, thread, from, text, at });
const LISTENING = { cls: "ok", text: "Manager listening" };

test("a lone Closed. or Done is an ack on the page: no 'answer coming', whatever the team asked before", () => {
  for (const text of ["Closed.", "closed", "Done", "done!", "  Done. "]) {
    const alone = page((o, now) => [msg(o, now - 2 * MIN, text)]);
    assert.deepEqual({ ...alone.managerChip() }, LISTENING, `alone: ${text}`);
    const afterQuestion = page((o, now) => [msg("Manager", now - 5 * MIN, "Shall I close it?"), msg(o, now - 2 * MIN, text)]);
    assert.deepEqual({ ...afterQuestion.managerChip() }, LISTENING, `after a question: ${text}`);
  }
});

test("a sentence that merely starts with Closed or Done is still a word to answer, on the page and in the Worker", () => {
  for (const text of ["Closed. But why did it fail?", "Done? Not yet"]) {
    const b = page((o, now) => [msg(o, now - 2 * MIN, text)]);
    assert.match(b.managerChip().text, /answer coming$/, text);
    assert.equal(ownerAck(text, null), false, text);
  }
  for (const text of ["Closed.", "Done"]) assert.equal(ownerAck(text, null), true, text);
});
