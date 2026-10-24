// Board v2, step 1: threads. Every item is a thread of messages; Owner
// replies under any item or starts a thread; Manager answers in the thread. Cases from Manager's list of the week's misses.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames, renderWaitingHtml } from "./harness.mjs";

const T = 1_800_000_000_000;
const NAMES = ["threadOf", "threadOpen", "openThreads", "threadResolved", "threadTitle", "wakeMode", "threadPing", "threadWrites", "replyWrites", "threadHtml", "threadsHtml", "initRow", "enrich", "gates", "keep"];
// Objects made inside the board's sandbox, as plain ones for deepEqual.
const plain = (x) => JSON.parse(JSON.stringify(x));
const board = (st = {}) => { const b = loadNames(NAMES); Object.assign(b.state, st); return b; };
const msg = (thread, from, text, at, extra = {}) => ({ id: `m${at}`, thread, from, text, at, ...extra });

test("a thread: its own messages only, oldest first and newest last", () => {
  const b = board({ messages: [msg("a", "Manager", "second", T + 2), msg("b", "Owner", "other", T + 1), msg("a", "Owner", "first", T + 1), { thread: "a", from: "Owner", text: "no time" }] });
  assert.deepEqual(b.threadOf("a").map((m) => m.text), ["first", "second"]);
});

test("case 5: Manager's answer shows in the thread under the ask, not only in a comment the board never shows", () => {
  const html = renderWaitingHtml([{ id: "w1", kind: "action", text: "Click it", since: T }], { messages: [msg("w1", "Owner", "Which button?", T + 1), msg("w1", "Manager", "The green one.", T + 2)] });
  assert.match(html, /class="thread" data-thread="w1"/);
  assert.ok(html.indexOf("Which button?") < html.indexOf("The green one."), "newest last");
  assert.match(html, /data-tsend="w1"/, "a reply box in the thread");
});

test("a message is shown as text: markup escaped, links made safe, files only from the board's own store", () => {
  const b = board({ messages: [msg("a", "<b>Manager</b>", "<img src=x onerror=alert(1)> see https://example.com/x", T, { assets: [{ id: "abcdefgh12", name: "<s>.png" }, { id: "javascript:alert(1)", name: "bad" }] })] });
  const html = b.threadHtml("a", "panel");
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;b&gt;Manager&lt;\/b&gt;/);
  assert.match(html, /<a href="https:\/\/example.com\/x" target="_blank" rel="noopener">/);
  assert.match(html, /href="\/_blob\/abcdefgh12"/);
  assert.match(html, /&lt;s&gt;\.png/);
  assert.doesNotMatch(html, /javascript:/);
});

test("the ping Manager keys on, exactly: Board thread [<thread>]: Owner: …; a new thread says its kind", () => {
  const b = board();
  assert.equal(b.threadPing("w1", "Which button?"), "Board thread [w1]: Owner: Which button?");
  assert.equal(b.threadPing("t-1", "Can we add X?", "idea"), "Board thread [t-1]: Owner: (new idea) Can we add X?");
  assert.equal(b.threadPing("w1", "x".repeat(3000)).length, 1900);
});

test("a message from Owner: one message doc with its thread, sender, text (capped), time, files and kind", () => {
  const b = board();
  const [w] = b.threadWrites("t-5", "y".repeat(2500), [{ id: "abcdefgh12", name: "a.png", type: "image/png", size: 9 }], T, "question", "r1");
  assert.equal(w.op, "set");
  assert.equal(w.path, `messages/m${T}-r1`);
  assert.deepEqual({ ...w.data, text: w.data.text.length }, { thread: "t-5", from: "Owner", text: 2000, at: T, assets: [{ id: "abcdefgh12", name: "a.png", type: "image/png", size: 9 }], kind: "question" });
  assert.deepEqual(Object.keys(b.threadWrites("w1", "hi", [], T, null, "r")[0].data).sort(), ["at", "from", "text", "thread"]);
});

test("a reply reopens a resolved ask or idea; an open one is left as it is; an initiative is never reopened here", () => {
  const b = board({ waiting: [{ id: "w-done", done: true }, { id: "w-open", done: false }], ideas: [{ id: "i-done", done: true }], initRaw: [{ id: "x", status: "done" }] });
  assert.deepEqual(plain(b.threadWrites("w-done", "again", [], T, null, "r")[1]), { op: "update", path: "waiting/w-done", data: { done: false, reopenedAt: T } });
  assert.deepEqual(plain(b.threadWrites("i-done", "again", [], T, null, "r")[1]), { op: "update", path: "ideas/i-done", data: { done: false, reopenedAt: T } });
  assert.equal(b.threadWrites("w-open", "more", [], T, null, "r").length, 1);
  assert.equal(b.threadWrites("x", "more", [], T, null, "r").length, 1, "the collector owns phases");
});

test("open while Owner has the last word; answered once Manager replies; resolved with its item, or by Manager's resolved mark", () => {
  const b = board({ waiting: [{ id: "w1", done: true }, { id: "w2" }], messages: [msg("w1", "Owner", "q", T), msg("w2", "Owner", "q", T), msg("w2", "Manager", "a", T + 1), msg("t-9", "Owner", "q", T), msg("t-9", "Manager", "done", T + 1, { resolved: true })] });
  assert.equal(b.threadOpen("w1"), true);
  assert.equal(b.threadResolved("w1"), false, "an item done with the owner's question open is not resolved");
  assert.equal(b.threadOpen("w2"), false);
  assert.equal(b.threadResolved("w2"), false, "answered, still in flight");
  assert.equal(b.threadResolved("t-9"), true);
  assert.deepEqual([...b.openThreads()], ["w1"]);
  b.state.messages.push(msg("t-9", "Owner", "one more thing", T + 2));
  assert.equal(b.threadOpen("t-9"), true, "a reply reopens");
  assert.equal(b.threadResolved("t-9"), false);
});

test("the Threads panel: waiting on Manager first, then answered, then resolved of the last 7 days folded; older resolved out of view", () => {
  const DAY = 864e5;
  const b = board({ waiting: [{ id: "old", done: true, text: "Old ask" }, { id: "new", done: true, text: "New ask" }], messages: [
    msg("t-1", "Owner", "Question one", T, { kind: "question" }), msg("t-2", "Owner", "Idea two", T, { kind: "idea" }), msg("t-2", "Manager", "Noted", T + 1),
    msg("new", "Owner", "q", T), msg("new", "Manager", "a", T + 1), msg("old", "Owner", "q", T - 9 * DAY), msg("old", "Manager", "a", T - 9 * DAY + 1)] });
  const html = b.threadsHtml(T + 10);
  const at = (s) => html.indexOf(s);
  assert.ok(at("Question one") > -1 && at("Question one") < at("Idea two") && at("Idea two") < at("Resolved threads"), html);
  assert.match(html, /Question one<span class="t-badge open">waiting on Manager/);
  assert.match(html, /Resolved threads, last 7 days \(1\)/);
  assert.match(html, /New ask/);
  assert.doesNotMatch(html, /Old ask/);
});

test("case 6: a bare Ack on an answer closes it; an Ack with a follow-up keeps it open and puts the question in its thread", () => {
  const b = board();
  const [bare] = b.replyWrites({ id: "ans-x", kind: "answer" }, "ack", "", [], T, null, "r");
  assert.deepEqual(plain(bare), { op: "update", path: "waiting/ans-x", data: { response: { status: "ack", note: "", at: T }, done: true, doneAt: T } });
  const follow = b.replyWrites({ id: "ans-x", kind: "answer" }, "ack", "But why?", [], T, null, "r");
  assert.equal(follow[0].data.done, undefined);
  assert.deepEqual(plain(follow[1].data), { thread: "ans-x", from: "Owner", text: "But why?", at: T });
});

test("case 10: Done with a note in it keeps the note as the owner's thread message, so the question waits for Manager", () => {
  const b = board({ waiting: [{ id: "board-link-manager", kind: "action" }] });
  const writes = b.replyWrites({ id: "board-link-manager", kind: "action" }, "done", "Done, but where is the link?", [], T, null, "r");
  assert.deepEqual(plain(writes[0].data), { response: { status: "done", note: "Done, but where is the link?", at: T } });
  assert.deepEqual(plain(writes[1]), { op: "set", path: `messages/m${T}-r`, data: { thread: "board-link-manager", from: "Owner", text: "Done, but where is the link?", at: T } });
  b.state.messages.push({ id: "m", ...writes[1].data });
  assert.equal(b.threadOpen("board-link-manager"), true);
});

test("the buttons work as before: a choice, an OK or a Done without a note write only the response", () => {
  const b = board();
  assert.deepEqual(plain(b.replyWrites({ id: "d", kind: "decision" }, "chose", "", [], T, "A", "r")), [{ op: "update", path: "waiting/d", data: { response: { status: "chose", note: "", at: T, choice: "A" } } }]);
  assert.deepEqual(plain(b.replyWrites({ id: "d", kind: "decision" }, "other", "C please", [], T, null, "r")[0].data.response), { status: "chose", note: "C please", at: T, choice: "something else" });
  assert.equal(b.replyWrites({ id: "a", kind: "action" }, "done", "", [], T, null, "r").length, 1);
  assert.equal(b.replyWrites({ id: "a", kind: "action" }, "ack", "", [], T, null, "r")[0].data.done, undefined, "only an answer closes on Ack");
});

test("wake: at once by default; meta/board.wake \"batch\" saves without a ping, for Manager's 5-minute check", () => {
  const b = board();
  assert.equal(b.wakeMode(), "now");
  b.state.meta.push({ id: "board", wake: "batch" });
  assert.equal(b.wakeMode(), "batch");
  b.state.meta[0].wake = "anything else";
  assert.equal(b.wakeMode(), "now");
});

test("an initiative carries its thread, folded, marked when Manager owes an answer", () => {
  const b = board({ steps: [], waiting: [], messages: [msg("x", "Owner", "Is this still on?", T)] });
  const html = b.initRow(b.gates(b.enrich({ id: "x", name: "X", status: "active", level: "Quick", skip: ["plan"] })));
  assert.match(html, /<details class="i-thread" data-id="ith-x"><summary>Thread \(1\)<span class="t-badge open">waiting on Manager/);
  assert.match(html, /Is this still on\?/);
});

test("a new thread box with Question and Idea sits at the top of the board, before Waiting on Owner", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(html, /<form class="newthread" id="newthread">[\s\S]*<option value="question">Question<\/option><option value="idea">Idea<\/option>/);
  assert.ok(html.indexOf('id="newthread"') < html.indexOf('id="h-wait"'));
  assert.match(html, /"messages"\]\.forEach\(sub\)/, "the board listens to messages");
});

test("a re-draw keeps what Owner is typing and which folds are open", () => {
  const b = board();
  const ta = { id: "tnote-panel-t-1", value: "half a sentence" };
  const det = { dataset: { id: "th-t-1" }, open: true };
  const fresh = { id: "tnote-panel-t-1", value: "" }, freshDet = { dataset: { id: "th-t-1" }, open: false };
  let drawn = false;
  const el = { querySelectorAll: (q) => (drawn ? (q.startsWith("details") ? [freshDet] : [fresh]) : q === "details[open]" ? [det] : q === "textarea[id]" ? [ta] : []) };
  b.els[ta.id] = fresh;
  b.keep(el, () => { drawn = true; });
  assert.equal(fresh.value, "half a sentence");
  assert.equal(freshDet.open, true);
});
