// You can always add a message to any thread (#C386, the owner in t-1793166144265): an ask the owner had answered
// ("You chose B. Sent to Manager.", with the team) showed no box at all until its thread had a message, so there was no
// way to add more context. An answered ask now always draws its thread's box, under the answer line.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, renderWaitingHtml } from "./harness.mjs";

const T = 1_800_000_000_000, HOUR = 3600e3;
const board = (st = {}) => { const b = loadNames(["threadsHtml", "threadHtml", "threadRows"]); Object.assign(b.state, st); return b; };
const boxes = (html) => (html.match(/<div class="reply(?: cmp(?: has)?)?" data-reply="/g) ?? []).length;
const decision = (at) => ({ id: "dec-ack-placement", kind: "decision", text: "Where should Ack and Close sit?", since: T, options: [{ key: "A", label: "On the Send line" }, { key: "B", label: "Keep the row" }], response: { status: "chose", choice: "B", note: "", at }, ping: "sent" });

test("an answered decision with no thread yet, with the team: a box to add more, under the answer line", () => {
  const html = board({ waiting: [decision(T + 1)], messages: [] }).threadsHtml(T + HOUR);
  assert.match(html, /You chose B/);
  assert.equal(boxes(html), 1);
  assert.match(html, /data-reply="th:dec-ack-placement"/);
  assert.match(html, /data-tsend="dec-ack-placement"/);
  assert.match(html, /placeholder="Add more for Manager"/, "not 'Start a thread on this' under an answer");
  assert.ok(html.indexOf("You chose B") < html.indexOf('data-reply="th:dec-ack-placement"'));
});

test("the same right after answering, while it still shows under Needs you", () => {
  const html = renderWaitingHtml([decision(Date.now())], { messages: [] });
  assert.match(html, /You chose B/);
  assert.match(html, /data-reply="th:dec-ack-placement"/);
});

test("every answered kind still open keeps its box; an unanswered ask keeps only its own", () => {
  for (const [kind, status, note] of [["action", "help", "it failed"], ["action", "done", "done, but where is the link?"], ["decision", "ok", ""], ["decision", "change", "smaller"], ["answer", "ack", "and one more thing"]]) {
    const ask = { id: "w", kind, text: "x", since: T, response: { status, note, at: T + 1 }, ping: "sent" };
    const html = board({ waiting: [ask], messages: [] }).threadsHtml(T + HOUR);
    assert.match(html, /data-reply="th:w"/, `${kind}/${status}`);
    assert.equal(boxes(html), 1, `${kind}/${status}`);
  }
  const open = renderWaitingHtml([{ id: "w", kind: "action", text: "Do it", since: T }], { messages: [] });
  assert.equal(boxes(open), 1);
  assert.doesNotMatch(open, /data-reply="th:w"/);
});
