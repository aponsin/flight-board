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
  const b = loadNames(["waitsOn", "youItems", "tabCounts", "threadsHtml", "threadRow", "renderWaiting", "trefPlace", "closeWrites", "ackWrites"]);
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

// #C460 (the owner's #T1150 on #T1145: a card in flight, Manager's answer the newest, sat under Needs you with no Ack to
// clear it) gave such a thread an Ack; #C510 (the owner: "your answers are leaving the thread with the team and not in my
// section") undid #C460's other half, which had kept it with the team: Manager's newest word in a thread whose card is in
// flight is the owner's to read, under Needs you with an Ack (its Building chip kept); the Ack puts it back with the team.
const t1145 = [msg("t-c", "Owner", "I keep getting failed-job emails", T - 60 * MIN), msg("t-c", "Manager", "The site is fine; these should stop", T - 55 * MIN),
  msg("t-c", "Owner", "got another one", T - 30 * MIN), msg("t-c", "Owner", "Do I need to tell anyone?", T - 28 * MIN),
  msg("t-c", "Manager", "Found it: a fork's copy. Fix carded as #C900", T - 25 * MIN), msg("t-c", "Manager", "No need to tell anyone", T - 10 * MIN)];
test("#C510: a building thread with an unread Manager answer is under Needs you, with an Ack, its Building chip kept", () => {
  const b = board(t1145);
  assert.equal(b.waitsOn("t-c", T), "answered");
  assert.equal(b.youItems(T, "").answered.join(), "t-c", "under Needs you");
  assert.ok(!b.threadsHtml(T).includes(b.threadRow("t-c", T)), "not under With the team");
  assert.match(b.threadRow("t-c", T), /<span class="kind building">Building<span class="kn"> #C900<\/span><\/span>/);
  assert.match(b.threadRow("t-c", T), /data-tack="t-c"/, "an Ack");
  assert.equal(board(t1145.slice(0, 4)).waitsOn("t-c", T), "lead", "the owner's word the newest: with the team, as before");
});

test("#C510: after the Ack, under With the team again, its card still in flight; Close as before once the owner wrote last", () => {
  const b = board(t1145);
  const w = b.ackWrites("t-c", T, "x1");
  assert.equal(JSON.stringify(w), JSON.stringify([{ op: "set", path: `messages/m${T}-x1`, data: { thread: "t-c", from: "Owner", text: "Ack.", at: T, resolved: true, kind: "ack" } }]), "one message, read and resolved for Manager's gates; no item write");
  const acked = board([...t1145, w[0].data]);
  assert.equal(acked.waitsOn("t-c", T), "lead");
  assert.equal(acked.youItems(T, "").answered.join(), "");
  assert.ok(acked.threadsHtml(T).includes(acked.threadRow("t-c", T)), "under With the team");
  assert.match(acked.threadRow("t-c", T), /kind building/);
  assert.match(acked.threadRow("t-c", T), /data-tclose="t-c"/, "Close, as #C460 gave it");
  assert.equal(board([...t1145, w[0].data, msg("t-c", "Manager", "It's in review now", T + MIN)]).waitsOn("t-c", T + 2 * MIN), "answered", "a newer answer is his to read again");
  const c = b.closeWrites("t-c", T, "x2");
  assert.equal(board([...t1145, c[0].data]).waitsOn("t-c", T), "resolved", "Close still resolves it");
  const mgr = t1145.map((m, i) => (i === t1145.length - 1 ? { ...m, resolved: true } : m));
  assert.equal(board(mgr).waitsOn("t-c", T), "resolved", "Manager's resolved on the newest message closes it");
  const done = { ...card, status: "done" };
  const live = board([...t1145, w[0].data]);
  live.state.initRaw = [done];
  live.state.initiatives = [done];
  assert.equal(live.waitsOn("t-c", T), "resolved", "an Ack once the card is done closes it");
});

test("a card in flight: Manager's decision the newest is the owner's to pick, under Needs you", () => {
  const b = board([...t1145, msg("t-c", "Manager", "Turn the fork's checks off, or wait?", T - 5 * MIN, { kind: "decision", options: [{ key: "A", label: "Turn off" }, { key: "B", label: "Wait" }] })]);
  assert.equal(b.waitsOn("t-c", T), "answered");
  assert.equal(b.youItems(T, "").answered.join(), "t-c");
});
