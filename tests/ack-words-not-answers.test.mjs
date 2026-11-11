// #C933: "yes", "yep", "great" and "perfect" are acks only when the team's last post in the thread asked nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

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

test("yes, yep, yup, great and perfect after a team question get 'answer coming'", () => {
  for (const text of ["yes", "Yep.", "yup!", "Great", "perfect"]) {
    const b = page((o, now) => [msg("Manager", now - 5 * MIN, "Shall I move the deploy to Friday?"), msg(o, now - 2 * MIN, text)]);
    assert.match(b.managerChip().text, /answer coming$/, text);
  }
});

test("the same words after a team post that asked nothing, or with no team post, are still acks", () => {
  for (const text of ["yes", "Yep.", "great", "Perfect!"]) {
    const after = page((o, now) => [msg("Manager", now - 5 * MIN, "The deploy went out."), msg(o, now - 2 * MIN, text)]);
    assert.deepEqual({ ...after.managerChip() }, LISTENING, `after a statement: ${text}`);
    const alone = page((o, now) => [msg(o, now - 2 * MIN, text)]);
    assert.deepEqual({ ...alone.managerChip() }, LISTENING, `no team post: ${text}`);
  }
});

test("Ack, ok, thanks and noted stay acks everywhere, even after a question", () => {
  for (const text of ["Ack.", "ok", "Thanks!", "noted"]) {
    const b = page((o, now) => [msg("Manager", now - 5 * MIN, "Shall I move the deploy to Friday?"), msg(o, now - 2 * MIN, text)]);
    assert.deepEqual({ ...b.managerChip() }, LISTENING, text);
  }
});

test("only the team's last post before the owner's message counts, in that thread", () => {
  // a question in another thread does not make 'yes' an answer here
  const other = page((o, now) => [msg("Manager", now - 5 * MIN, "Shall I move it?", "t2"), msg(o, now - 2 * MIN, "yes")]);
  assert.deepEqual({ ...other.managerChip() }, LISTENING);
  // an older question followed by a statement: the last post asked nothing
  const older = page((o, now) => [msg("Manager", now - 9 * MIN, "Shall I move it?"), msg("Checker", now - 5 * MIN, "Moved."), msg(o, now - 2 * MIN, "yes")]);
  assert.deepEqual({ ...older.managerChip() }, LISTENING);
});
