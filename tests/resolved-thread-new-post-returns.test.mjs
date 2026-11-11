// resolved-thread-new-post-returns (#C941, the owner on #T1825): Manager closed an ask, then answered his follow-up in the same thread; the thread
// had gone to Resolved and he never saw the answer. A team post newer than the close brings it back under Needs you until his own word is the newest.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000, MIN = 60_000;
const NAMES = ["threadSets", "waitsOn", "youCount", "threadResolved", "set:(s)=>{Object.assign(state,s)}"];
const msg = (thread, from, text, at, extra = {}) => ({ id: `m${at}${from}`, thread, from, text, at, ...extra });
const board = (st) => { const b = loadNames(NAMES); b.set({ initRaw: [], initiatives: [], ...st }); return b; };
// an ask Manager closed at T - 30 min (the store's closed_at reads as done + doneAt)
const closedAsk = (id = "t-1825") => ({ id, kind: "action", text: "Run the pair", done: true, doneAt: T - 30 * MIN });
const owner = "Owner";

test("a Manager answer after the ask was closed brings the thread back under Needs you, not Resolved", () => {
  const b = board({ waiting: [closedAsk()], messages: [msg("t-1825", "Manager", "Verified.", T - 40 * MIN), msg("t-1825", owner, "and did it also fix the page?", T - 20 * MIN), msg("t-1825", "Manager", "Yes, the page too.", T - 5 * MIN, { kind: "answer" })] });
  assert.equal(b.threadResolved("t-1825"), false);
  assert.equal(b.waitsOn("t-1825", T), "answered");
  assert.deepEqual([...b.threadSets(T).answered], ["t-1825"]);
  assert.equal(b.youCount(T, ""), 1);
});

test("the owner's own Ack or Close after that answer puts it back to Resolved", () => {
  const base = [msg("t-1825", owner, "and did it also fix the page?", T - 20 * MIN), msg("t-1825", "Manager", "Yes, the page too.", T - 5 * MIN, { kind: "answer" })];
  for (const mine of [msg("t-1825", owner, "Ack.", T - 2 * MIN, { resolved: true, kind: "ack" }), msg("t-1825", owner, "Closed.", T - 2 * MIN, { resolved: true })]) {
    const b = board({ waiting: [closedAsk()], messages: [...base, mine] });
    assert.equal(b.waitsOn("t-1825", T), "resolved", mine.text);
    assert.equal(b.youCount(T, ""), 0);
  }
});

test("still Resolved: no post after the close, and a thread of agents' notes only", () => {
  let b = board({ waiting: [closedAsk()], messages: [msg("t-1825", "Manager", "Verified.", T - 40 * MIN), msg("t-1825", owner, "thanks", T - 31 * MIN)] });
  assert.equal(b.waitsOn("t-1825", T), "resolved", "the last word is before the close");
  b = board({ waiting: [closedAsk()], messages: [msg("t-1825", "Manager", "Verified.", T - 31 * MIN)] });
  assert.equal(b.waitsOn("t-1825", T), "resolved", "Manager's word before the close");
  b = board({ waiting: [closedAsk()], messages: [msg("t-1825", owner, "ok", T - 31 * MIN), msg("t-1825", "Manager", "Then it is Safari", T - 29 * MIN)] });
  assert.equal(b.waitsOn("t-1825", T), "resolved", "a reply just after the close, with nothing from him after it, is part of the close");
  b = board({ waiting: [closedAsk()], messages: [msg("t-1825", "Builder", "pushed", T - 3 * MIN), msg("t-1825", "Checker", "looked fine", T - 2 * MIN)] });
  assert.equal(b.waitsOn("t-1825", T), "resolved", "every message an agent's (#C919): not his to read, so the close still stands");
});

test("a done card's thread stays resolved even with his thanks and Manager's 'shipped' after the done time: asks only", () => {
  const card = { id: "card-y", thread: "card-y", num: 902, name: "Y", status: "done", doneAt: T - 20 * MIN };
  const b = board({ initRaw: [card], initiatives: [card], messages: [msg("card-y", owner, "Thanks", T - 10 * MIN), msg("card-y", "Manager", "Shipped", T - 5 * MIN)] });
  assert.equal(b.waitsOn("card-y", T), "resolved");
});

test("a thread already resolved by a resolved message stays so; so does a card thread marked done with no later post", () => {
  let b = board({ messages: [msg("t-x", "Manager", "Done.", T - 9 * MIN, { resolved: true })] });
  assert.equal(b.waitsOn("t-x", T), "resolved");
  const card = { id: "card-x", thread: "card-x", num: 901, name: "X", status: "done", doneAt: T - 20 * MIN };
  b = board({ initRaw: [card], initiatives: [card], messages: [msg("card-x", "Manager", "Shipped.", T - 25 * MIN)] });
  assert.equal(b.waitsOn("card-x", T), "resolved");
});
