// The lead's word the newest: the thread is under Needs you (#C451, last-word-needs-you: the owner on #T1104, an answer
// he acked with a note, then two Manager answers in its thread, done still false; it sat under With the team, as the
// page never checked who wrote last on an answered ask).
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const msg = (thread, from, text, at, extra = {}) => ({ id: `m${at}${from}${thread}`, thread, from, text, at, ...extra });
const card = { id: "card-9", num: 900, name: "In flight", size: "S", status: "active", phase: "build", thread: "t-c", etaLive: T + 36e5, createdAt: T - 60 * MIN };
function board(messages) {
  const b = loadNames(["waitsOn", "youItems", "tabCounts", "threadsHtml", "threadRow", "renderWaiting", "trefPlace"]);
  Object.assign(b.state, {
    steps: [], derived: [], todo: [], ideas: [], threads: [], initRaw: [card], initiatives: [card],
    // The #T1104 case: an answer item, acked with a note (a question in it, so it isn't settled), done false.
    waiting: [{ id: "ping-device", kind: "answer", text: "The ping button reaches the device", since: T - 50 * MIN, response: { status: "ack", note: "ok, but which device?", at: T - 40 * MIN } }],
    messages,
  });
  return b;
}
const twoAnswers = [msg("ping-device", "Manager", "The one paired last", T - 30 * MIN), msg("ping-device", "Manager", "And it says so on the button now", T - 20 * MIN)];

test("the owner's #T1104: an acked answer, then two Manager answers, lands in Needs you, not With the team", () => {
  const b = board(twoAnswers);
  assert.equal(b.waitsOn("ping-device", T), "you");
  assert.equal(b.youItems(T, "").asks.map((w) => w.id).join(), "ping-device");
  assert.doesNotMatch(b.threadsHtml(T), /data-id="ping-device"/, "not under With the team");
  b.renderWaiting();
  const html = b.els.waiting.innerHTML;
  assert.match(html, /data-id="ping-device"[\s\S]*waiting on you[\s\S]*And it says so on the button now/, "drawn there, its thread with it");
  assert.equal(JSON.stringify(b.trefPlace("ping-device", T)), '{"tab":"you"}');
});

test("the owner's word the newest, or no word after the reply: With the team, as before", () => {
  const b = board([...twoAnswers, msg("ping-device", "Owner", "And the old one?", T - 10 * MIN)]);
  assert.equal(b.waitsOn("ping-device", T), "lead", "the owner wrote last");
  assert.equal(board([]).waitsOn("ping-device", T), "lead", "only the reply: Manager has not answered it");
  assert.equal(board([msg("ping-device", "Manager", "Before the reply", T - 45 * MIN)]).waitsOn("ping-device", T), "lead", "a Manager word older than the reply");
});

test("a card in flight whose newest word is the lead's is in Needs you, its Building chip kept; its building word alone stays with the team", () => {
  const ask = [msg("t-c", "Owner", "Make it ping", T - 60 * MIN), msg("t-c", "Manager", "Card #C900", T - 55 * MIN, { kind: "building" })];
  const b = board([...ask, msg("t-c", "Owner", "When?", T - 20 * MIN), msg("t-c", "Manager", "Within the hour", T - 10 * MIN)]);
  assert.equal(b.waitsOn("t-c", T), "answered");
  assert.equal(b.youItems(T, "").answered.join(), "t-c");
  assert.match(b.threadRow("t-c", T), /<span class="kind building">Building<span class="kn"> #C900<\/span><\/span>/);
  assert.equal(board(ask).waitsOn("t-c", T), "lead", "Manager's card word hands it to the team");
});
