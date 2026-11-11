// #C887: an owner message that only acknowledges never shows "answer coming"; a question does until Manager posts in its thread.
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

test("an 'Ack.' needs no answer: the chip stays 'Manager listening'", () => {
  for (const text of ["Ack.", "ok", "Thanks!", "  Got it  ", "OK."]) {
    const b = page((o, now) => [msg(o, now - 2 * MIN, text)]);
    assert.deepEqual({ ...b.managerChip() }, { cls: "ok", text: "Manager listening" }, text);
  }
});

test("a question shows 'answer coming' until Manager posts in that thread", () => {
  const b = page((o, now) => [msg(o, now - 2 * MIN, "Can you move the deploy to Friday?")]);
  assert.match(b.managerChip().text, /answer coming$/);
  b.state.messages.push(msg("Manager", Date.now() - 10e3, "Yes, moved."));
  assert.equal(b.managerChip().text, "Manager listening");
  // an answer in another thread does not count
  const c = page((o, now) => [msg(o, now - 2 * MIN, "Can you move the deploy to Friday?"), msg("Manager", now - 10e3, "hi", "t2")]);
  assert.match(c.managerChip().text, /answer coming$/);
});

test("an ack word inside a longer message is still a message that wants an answer", () => {
  const b = page((o, now) => [msg(o, now - 2 * MIN, "ok but why is the build red?")]);
  assert.match(b.managerChip().text, /answer coming$/);
});
