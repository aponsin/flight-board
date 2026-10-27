// The owner's word unanswered (#C297, the owner's ask): a thread whose newest message is the owner's, still open 5
// minutes on, any thread a new t-<ms> one included, says "unanswered N min" in red on its row, so a follow-up the lead
// missed shows at a glance.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, loadBoard } from "./harness.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const NAMES = ["threadRows", "threadsHtml", "lateTag"];
const board = (messages) => { const b = loadNames(NAMES); Object.assign(b.state, { messages }); return b; };
const msg = (thread, from, text, at, extra = {}) => ({ id: `m${at}`, thread, from, text, at, ...extra });
const late = (html) => (html.match(/<span class="late">([^<]*)<\/span>/) ?? [])[1];

test("5 minutes after the owner's word with no answer: 'unanswered N min' on the thread's row; not before", () => {
  const b = board([msg("t-1793000000000", "Owner", "a new thread", T)]);
  assert.equal(late(b.threadRows(T + 4 * MIN).open), undefined, "4 min");
  assert.equal(late(b.threadRows(T + 5 * MIN).open), "unanswered 5 min");
  assert.equal(late(b.threadsHtml(T + 75 * MIN)), "unanswered 1 h 15 min", "in the Waiting on Manager section");
});

test("a follow-up after the lead's answer starts its own clock; an answer or the owner's close ends it", () => {
  const thread = [msg("t-1", "Owner", "q", T - 60 * MIN), msg("t-1", "Manager", "a", T - 50 * MIN), msg("t-1", "Owner", "and this?", T)];
  assert.equal(late(board(thread).threadRows(T + 6 * MIN).open), "unanswered 6 min", "the follow-up");
  assert.equal(late(board([...thread, msg("t-1", "Manager", "this too", T + 2 * MIN)]).threadsHtml(T + 6 * MIN)), undefined, "answered");
  assert.equal(late(board([msg("t-2", "Owner", "Closed.", T, { resolved: true })]).threadsHtml(T + 30 * MIN)), undefined, "the owner closed it");
});

test("a follow-up in a card's thread or an answered ask's thread shows it too", () => {
  const now = Date.now(), b = loadBoard();
  b.state.messages = [msg("tabs", "Owner", "any news?", now - 7 * MIN)];
  const html = b.initRow(b.gates(b.enrich({ id: "tabs", name: "Tabs", level: "Quick", status: "active", phase: "build", skip: [] })));
  assert.equal(late(html), "unanswered 7 min", "the card's Thread fold");
  const ask = { id: "ask-1", kind: "action", text: "Do it", since: T, response: { status: "help", note: "step 2 fails", at: now - 8 * MIN } };
  const a = loadNames(NAMES);
  Object.assign(a.state, { waiting: [ask], messages: [msg("ask-1", "Owner", "step 2 fails", now - 8 * MIN)] });
  assert.equal(late(a.threadsHtml(now)), "unanswered 8 min", "the ask, under Waiting on Manager");
});

test("the tag is the page's alone: a number of minutes, never the message's text", () => {
  const b = board([msg("t-3", "Owner", '<img src=x onerror=alert(1)>', T)]);
  assert.equal(b.lateTag("t-3", T + 9 * MIN), '<span class="late">unanswered 9 min</span>');
  assert.equal(b.lateTag("nothing", T), "");
});
