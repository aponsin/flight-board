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
  const b = loadNames(["waitsOn", "youItems", "tabCounts", "threadsHtml", "threadRow", "renderWaiting", "trefPlace", "closeWrites"]);
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

// #C460 (the owner's #T1150 on #T1145: a card in flight, Manager's answer the newest and asking nothing, sat under Needs
// you with no Ack to clear it). A card in flight keeps its thread with the team whatever Manager answers in it; only a
// decision (Manager asks the owner to pick) puts it under Needs you. #C451's answered-ask case above is unchanged.
const t1145 = [msg("t-c", "Owner", "I keep getting failed-job emails", T - 60 * MIN), msg("t-c", "Manager", "The site is fine; these should stop", T - 55 * MIN),
  msg("t-c", "Owner", "got another one", T - 30 * MIN), msg("t-c", "Owner", "Do I need to tell anyone?", T - 28 * MIN),
  msg("t-c", "Manager", "Found it: a fork's copy. Fix carded as #C900", T - 25 * MIN), msg("t-c", "Manager", "No need to tell anyone", T - 10 * MIN)];
test("#T1145: a card in flight whose newest word is Manager's answer stays with the team, its Building chip kept", () => {
  const b = board(t1145);
  assert.equal(b.waitsOn("t-c", T), "lead");
  assert.equal(b.youItems(T, "").answered.join(), "", "not under Needs you");
  assert.ok(b.threadsHtml(T).includes(b.threadRow("t-c", T)), "under With the team");
  assert.match(b.threadRow("t-c", T), /<span class="kind building">Building<span class="kn"> #C900<\/span><\/span>/);
  assert.equal(board(t1145.slice(0, 4)).waitsOn("t-c", T), "lead", "the owner's word the newest: with the team, as before");
});

// #C460 too: #T1145 had no button at all. Its Close clears it; Manager closes one for the owner with update {resolved:
// true} on the thread's newest message (the only one the page reads it from), never on an older one of the owner's.
test("#T1145: the owner can Close a thread whose card is in flight, and Manager can close it on the newest message", () => {
  const b = board(t1145);
  assert.match(b.threadRow("t-c", T), /data-tclose="t-c"/);
  const w = b.closeWrites("t-c", T, "x1");
  assert.equal(JSON.stringify(w), JSON.stringify([{ op: "set", path: `messages/m${T}-x1`, data: { thread: "t-c", from: "Owner", text: "Closed.", at: T, resolved: true } }]), "a thread with no item: one message, no item write");
  assert.equal(board([...t1145, w[0].data]).waitsOn("t-c", T), "resolved");
  const mgr = t1145.map((m, i) => (i === t1145.length - 1 ? { ...m, resolved: true } : m));
  assert.equal(board(mgr).waitsOn("t-c", T), "resolved", "Manager's resolved on the newest message closes it");
  const older = t1145.map((m, i) => (i === 3 ? { ...m, resolved: true } : m));
  assert.equal(board(older).waitsOn("t-c", T), "lead", "resolved on an older message of the owner's doesn't");
});

test("a card in flight: Manager's decision the newest is the owner's to pick, under Needs you", () => {
  const b = board([...t1145, msg("t-c", "Manager", "Turn the fork's checks off, or wait?", T - 5 * MIN, { kind: "decision", options: [{ key: "A", label: "Turn off" }, { key: "B", label: "Wait" }] })]);
  assert.equal(b.waitsOn("t-c", T), "answered");
  assert.equal(b.youItems(T, "").answered.join(), "t-c");
});
