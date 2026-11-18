// #C1203 (the owner in t-1794938282960, 11-17: "why did this thread come back up ?"): his last word was an "Ack.", stored resolved, and nobody wrote after it, yet the thread came back
// under "with the team". The page held an owner's Ack open whenever ANY card naming the thread was in flight, even one made after his word. His Ack now stays closed unless a card that was
// already in flight when he wrote it still is; a closed thread stays closed until someone writes in it.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000;
const ACK_AT = T + 3000;
const msgs = [
  { id: "m1", thread: "t-1", from: "Owner", text: "can you build it?", at: T },
  { id: "m2", thread: "t-1", from: "Manager", text: "Yes, it is on its way.", kind: "answer", at: T + 1000 },
  { id: "m3", thread: "t-1", from: "Owner", text: "Ack.", kind: "ack", resolved: true, at: ACK_AT },
];
const card = (extra) => ({ id: "card-a", name: "A card", status: "active", thread: "t-1", ...extra });
const page = (initiatives, messages = msgs) => {
  const b = loadNames(["waitsOn", "threadResolved", "threadState"]);
  b.state.messages = messages; b.state.initiatives = initiatives;
  return b;
};

test("an owner's Ack on a thread with no card is resolved, and stays resolved", () => {
  assert.equal(page([]).waitsOn("t-1", ACK_AT + 5_000_000), "resolved");
});

test("a card made AFTER his Ack, in flight and naming the thread, does not bring the thread back", () => {
  for (const status of ["active", "blocked", "paused"]) assert.equal(page([card({ status, createdAt: ACK_AT + 4_000_000 })]).waitsOn("t-1", ACK_AT + 5_000_000), "resolved", status);
});

test("must still hold: a card already in flight when he acked keeps the thread with the team; once it is done or dropped the thread is resolved", () => {
  assert.notEqual(page([card({ createdAt: T + 2000 })]).waitsOn("t-1", ACK_AT + 5_000_000), "resolved");
  assert.equal(page([card({ createdAt: T + 2000, status: "done" })]).waitsOn("t-1", ACK_AT + 5_000_000), "resolved");
  assert.equal(page([card({ createdAt: T + 2000, status: "dropped" })]).waitsOn("t-1", ACK_AT + 5_000_000), "resolved");
  assert.notEqual(page([card({})]).waitsOn("t-1", ACK_AT + 5_000_000), "resolved", "a card with no creation time is read as it was before (in flight)");
});

test("someone writing after the Ack brings the thread back: Manager's word, then the owner's own question", () => {
  const more = { id: "m4", thread: "t-1", from: "Manager", text: "One more thing.", kind: "answer", at: ACK_AT + 1000 };
  assert.notEqual(page([], [...msgs, more]).waitsOn("t-1", ACK_AT + 5_000_000), "resolved");
  const asked = { id: "m5", thread: "t-1", from: "Owner", text: "why?", at: ACK_AT + 2000 };
  assert.equal(page([], [...msgs, more, asked]).waitsOn("t-1", ACK_AT + 5_000_000), "lead");
});
