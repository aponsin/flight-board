// #C964 (11-11 about 8:10 pm MT: Manager's Decision, posted into the thread of #T1779 with options A and B, showed the owner only its text: a thread
// drawn under an ask's tile or a card's drew no option buttons, because only the Team-thread rows asked for them). A Decision posted in a thread
// draws its options wherever that thread is drawn; a plain post draws none, and a standalone Decision is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, renderWaitingHtml } from "./harness.mjs";

const now = Date.now();
const two = [{ key: "A", label: "Left" }, { key: "B", label: "Right" }];
const owner = (id, thread, at, text = "what about it?") => ({ id, thread, from: "Owner", text, at });
const decision = (thread, at = now - 1000) => ({ id: "m-dec", thread, from: "Manager", text: "Pick one\n\nA or B?\n\nRecommended: A", at, kind: "decision", options: two });
const plain = (thread, at = now - 1000) => ({ id: "m-plain", thread, from: "Manager", text: "Just a note, nothing to pick", at });
const buttons = (html) => [...html.matchAll(/data-topt="([^"]*)"[^>]*data-choice="([^"]*)"/g)].map((m) => `${m[1]}:${m[2]}`);

const load = (messages) => { const b = loadNames(["threadHtml", "threadState", "threadOptions"]); b.state.messages = messages; b.state.threads = [{ id: "t1779", num: 1779 }]; return b; };

test("a thread drawn with decide shows the Decision's options; without decide or acts it does not, as before", () => {
  const b = load([owner("m1", "t1779", now - 60_000), decision("t1779")]);
  assert.deepEqual(buttons(b.threadHtml("t1779", "ask", { decide: true })), ["t1779:A", "t1779:B"]);
  assert.deepEqual(buttons(b.threadHtml("t1779", "ask", { acts: true })), ["t1779:A", "t1779:B"], "the Team row's way still works");
  assert.deepEqual(buttons(b.threadHtml("t1779", "ask", {})), [], "a thread asking for neither draws none, as before");
});

test("must still allow: a plain post with no options shows no buttons, and neither does an owner's last word after the Decision", () => {
  const p = load([owner("m1", "t1779", now - 60_000), plain("t1779")]);
  assert.deepEqual(buttons(p.threadHtml("t1779", "ask", { decide: true })), []);
  const answered = load([owner("m1", "t1779", now - 60_000), decision("t1779", now - 50_000), owner("m3", "t1779", now - 1000, "Chose A: Left")]);
  assert.deepEqual(buttons(answered.threadHtml("t1779", "ask", { decide: true })), [], "once the owner has picked, the last word is his: no options");
});

test("under an open ask's tile the thread's Decision shows its buttons beside the reply box; a thread with no Decision draws as it did", () => {
  const ask = { id: "t1779", kind: "question", text: "What about it?", since: now - 60_000, done: false };
  const withDecision = renderWaitingHtml([ask], { messages: [owner("m1", "t1779", now - 60_000), decision("t1779")] });
  assert.deepEqual(buttons(withDecision), ["t1779:A", "t1779:B"]);
  const quiet = renderWaitingHtml([ask], { messages: [owner("m1", "t1779", now - 60_000), plain("t1779")] });
  assert.deepEqual(buttons(quiet), []);
  const none = renderWaitingHtml([ask], { messages: [] });
  assert.deepEqual(buttons(none), []);
});
