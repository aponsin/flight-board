// Board v2, step 1: threads. Every item is a thread of messages; Owner
// replies under any item or starts a thread; Manager answers in the thread. Cases from Manager's list of the week's misses.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames, renderWaitingHtml } from "./harness.mjs";

const T = 1_800_000_000_000;
const NAMES = ["threadOf", "threadOpen", "openThreads", "threadResolved", "threadTitle", "wakeMode", "threadPing", "threadWrites", "replyWrites", "threadHtml", "threadsHtml", "threadRows", "initRow", "enrich", "gates", "keep"];
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

test("an answered ask moves from Needs you to Waiting on Manager, with its reply and thread, until Manager closes it", () => {
  const ask = { id: "ask-pics", kind: "action", text: "Send the pictures", since: T, response: { status: "done", note: "here they are", at: 1000 }, ping: "sent" }; // answered long ago, on the real clock
  const owner = msg("ask-pics", "Owner", "here they are", T);
  assert.doesNotMatch(renderWaitingHtml([ask], { messages: [owner] }), /Send the pictures/, "no longer under Needs you");
  assert.match(renderWaitingHtml([{ ...ask, response: undefined }]), /Send the pictures/, "unanswered: under Needs you");
  const b = board({ waiting: [ask], messages: [owner] });
  const html = b.threadsHtml(T);
  assert.match(html, /<details class="w-item" data-id="ask-pics">/);
  assert.match(html, /You marked this done/);
  assert.match(html, /class="thread" data-thread="ask-pics"/, "the reply sits under the ask");
  b.state.messages.push(msg("ask-pics", "Manager", "Got them", T + 1));
  assert.match(b.threadsHtml(T), /data-id="ask-pics"/, "Manager answered but hasn't closed it: still waiting on Manager");
  b.state.waiting[0] = { ...ask, done: true };
  assert.doesNotMatch(b.threadsHtml(T), /data-id="ask-pics"/, "closed: gone from the section");
  assert.match(b.threadsHtml(T), /Resolved threads, last 7 days \(1\)[\s\S]*Reply to: <b class="t-name">Send the pictures/, "closed with Manager's word last: resolved, folded");
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

test("Waiting on Manager: answered asks, then threads whose last word is the owner's, then the resolved of 7 days folded; Manager's answers go to Needs you", () => {
  const DAY = 864e5;
  const b = board({ waiting: [{ id: "old", done: true, text: "Old ask" }, { id: "new", done: true, text: "New ask" }], messages: [
    msg("t-1", "Owner", "Question one", T, { kind: "question" }), msg("t-2", "Owner", "Idea two", T, { kind: "idea" }), msg("t-2", "Manager", "Noted", T + 1),
    msg("new", "Owner", "q", T), msg("new", "Manager", "a", T + 1), msg("old", "Owner", "q", T - 9 * DAY), msg("old", "Manager", "a", T - 9 * DAY + 1),
    msg("t-3", "Owner", "Done one", T), msg("t-3", "Manager", "Closed.", T + 1, { resolved: true })] });
  const html = b.threadsHtml(T + 10);
  assert.ok(html.indexOf("Question one") > -1 && html.indexOf("Question one") < html.indexOf("Resolved threads"), html);
  assert.match(html, /Question one<\/b><span class="t-badge open">waiting on Manager/);
  assert.match(html, /Resolved threads, last 7 days \(2\)[\s\S]*Reply to: <b class="t-name">New ask[\s\S]*Done one/);
  assert.doesNotMatch(html, /Idea two|Old ask/, "answered threads are the owner's to read, and older resolved ones are out of view");
  const answered = b.threadRows(T + 10).answered;
  assert.match(answered, /Idea two/, "Manager answered an open thread: under Needs you");
  assert.doesNotMatch(answered, /New ask|Old ask/);
});

test("the reply-card bug: a thread whose item is on the board stays under the item, never as a second row", () => {
  const b = board({ waiting: [{ id: "ask-open", text: "Run the install", since: T }, { id: "ask-answered", text: "Send the pictures", since: T, response: { status: "done", note: "here", at: T } }],
    initRaw: [{ id: "card-live", name: "Tabs", status: "active" }, { id: "card-done", name: "Menu", status: "done" }],
    messages: [msg("ask-open", "Owner", "which folder?", T + 1), msg("ask-answered", "Owner", "here", T), msg("card-live", "Owner", "how far?", T + 1),
      msg("card-done", "Owner", "thanks", T + 1), msg("t-5", "Owner", "New question", T + 1, { kind: "question" })] });
  const html = b.threadsHtml(T + 10_000);
  assert.doesNotMatch(html, /Run the install|Tabs/, "the ask under Needs you and the card in flight keep their threads under them");
  assert.match(html, /New question/);
  assert.equal((html.match(/Send the pictures/g) ?? []).length, 1, "the answered ask once, its thread under it");
  assert.doesNotMatch(html, /Reply to: Send the pictures/);
  b.state.messages.push(msg("ask-answered", "Manager", "Got them", T + 2));
  assert.doesNotMatch(b.threadsHtml(T + 10_000) + b.threadRows(T + 10_000).answered, /Reply to: Send the pictures/, "still on the board until Manager closes it");
  assert.match(html, /Reply to: <b class="t-name">Menu/, "a done card's thread is a row of its own");
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

test("one Threads panel: the new thread box (no kind to pick), then Needs you, then Waiting on Manager", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  const section = html.slice(html.indexOf('<section aria-labelledby="h-threads">'), html.indexOf("</section>", html.indexOf('<section aria-labelledby="h-threads">')));
  assert.match(section, /<form class="newthread" id="newthread"><label for="nttext">Start a thread<\/label><textarea id="nttext"/);
  assert.doesNotMatch(html, /<select id="ntkind"|<option value="idea">/, "no Question or Idea to pick");
  assert.ok(section.indexOf('id="newthread"') < section.indexOf('id="h-wait">Needs you') && section.indexOf('id="h-wait">Needs you') < section.indexOf('id="h-onlead">Waiting on Manager'));
  assert.match(section, /id="waiting"/);
  assert.match(section, /id="threads"/);
  assert.equal((html.match(/<section aria-labelledby="h-wait">/g) ?? []).length, 0, "no second panel");
  assert.match(html, /const kind="question",d=takeDraft\(\$\("nttext"\)\)/, "a new thread is a question in the data");
  assert.match(html, /"messages"[,\]][^\n]*\.forEach\(sub\)/, "the board listens to messages");
  assert.match(html, /"derived"[,\]][^\n]*\.forEach\(sub\)/, "and to the collector's derived phases");
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

test("the stuck line: \"Manager stuck on <item>: <reason>\" for each item the gate stuck on, oldest first; none when cleared", () => {
  const b = loadNames(["stuckLines"]);
  Object.assign(b.state, { waiting: [{ id: "w1", text: "Pick a colour" }], initRaw: [{ id: "x-y", name: "Tabs" }] });
  b.state.meta.push({ id: "stuck", "waiting:w1": { reason: "no steps", at: 2 }, "initiatives:x-y": { reason: "no ETA", at: 1 }, "steps:s9": { __delete__: true } });
  assert.deepEqual([...b.stuckLines()], ["Manager stuck on Tabs: no ETA", "Manager stuck on Pick a colour: no steps"]);
  b.state.meta[0] = { id: "stuck" };
  assert.deepEqual([...b.stuckLines()], []);
});

test("a card shows what the repository says, and a conflict mark when it says otherwise", () => {
  const b = loadNames(["evidence"]);
  b.state.derived.push({ id: "all", cards: { x: { phase: "live", version: "1.4.0", evidence: "abc is on main" }, y: { phase: null } } });
  assert.equal(b.evidence({ id: "x", phase: "build", status: "active" }), '<span class="evidence clash" title="abc is on main">Repository says Live 1.4.0</span>');
  assert.equal(b.evidence({ id: "x", phase: "live", status: "active" }), '<span class="evidence" title="abc is on main">Repository: Live 1.4.0</span>');
  assert.equal(b.evidence({ id: "y", phase: "build" }), "", "nothing known, nothing shown");
  assert.equal(b.evidence({ id: "z", phase: "build" }), "");
});

test("a dropped card is shown closed, as Dropped", () => {
  const b = loadNames(["initRow", "enrich", "gates", "asShown"]);
  Object.assign(b.state, { steps: [], waiting: [] });
  const html = b.initRow(b.gates(b.enrich(b.asShown({ id: "x", name: "X", status: "dropped", dropReason: "r", level: "Quick", skip: ["plan"] }))));
  assert.match(html, /<span class="state done">Dropped<\/span>/);
});

test("Close: the owner's Close marks the thread resolved (and closes an ask or idea), with no ping; the box offers it while open", () => {
  const b = loadNames(["closeWrites", "threadOpen", "threadResolved", "threadHtml"]);
  Object.assign(b.state, { waiting: [{ id: "w1", done: false }], ideas: [{ id: "i1", done: false }], initRaw: [{ id: "x", status: "active" }] });
  const T = 1_800_000_000_000;
  assert.deepEqual(plain(b.closeWrites("t-5", T, "r")), [{ op: "set", path: `messages/m${T}-r`, data: { thread: "t-5", from: "Owner", text: "Closed.", at: T, resolved: true } }]);
  assert.deepEqual(plain(b.closeWrites("w1", T, "r"))[1], { op: "update", path: "waiting/w1", data: { done: true, doneAt: T } });
  assert.deepEqual(plain(b.closeWrites("i1", T, "r"))[1], { op: "update", path: "ideas/i1", data: { done: true, doneAt: T } });
  assert.equal(b.closeWrites("x", T, "r").length, 1, "an initiative's phase stays the collector's");
  b.state.messages.push({ id: "m1", thread: "t-5", from: "Owner", text: "q", at: T });
  assert.match(b.threadHtml("t-5", "panel"), /data-tclose="t-5"/);
  b.state.messages.push({ id: "m2", ...plain(b.closeWrites("t-5", T + 1, "r"))[0].data });
  assert.equal(b.threadOpen("t-5"), false, "the owner's own Close isn't waiting on the lead");
  assert.equal(b.threadResolved("t-5"), true);
  assert.doesNotMatch(b.threadHtml("t-5", "panel"), /data-tclose/, "no Close on a closed thread");
});

test("a message that names the one it answers comes after it, whatever the clocks said: the lead's resolve wins", () => {
  const b = loadNames(["threadOf", "threadOpen", "threadResolved"]);
  b.state.messages.push({ id: "a", thread: "t", from: "Owner", text: "one more?", at: 200 }, { id: "b", thread: "t", from: "Manager", text: "Done.", at: 150, resolved: true, after: "a" });
  assert.deepEqual([...b.threadOf("t")].map((m) => m.id), ["a", "b"]);
  assert.equal(b.threadOpen("t"), false);
  assert.equal(b.threadResolved("t"), true);
  b.state.messages.push({ id: "c", thread: "t", from: "Owner", text: "loop", at: 100, after: "c" });
  assert.equal(b.threadOf("t").length, 3, "a message naming itself doesn't hang");
});

test("Send takes the text out of the box at once (no kept draft, no double send); a failed save puts it back", () => {
  const b = loadNames(["takeDraft"]);
  const ta = { id: "tnote-panel-t-1", value: "  hello  " };
  b.els[ta.id] = ta;
  const d = b.takeDraft(ta);
  assert.equal(d.text, "hello");
  assert.equal(ta.value, "", "cleared before anything is saved or re-drawn");
  assert.equal(b.takeDraft(ta).text, "", "a second press finds nothing to send");
  d.restore();
  assert.equal(ta.value, "hello");
  ta.value = "new typing"; d.restore();
  assert.equal(ta.value, "new typing", "never over what the owner typed since");
});

test("Needs you: the open asks, then the threads Manager answered; empty, it says so", () => {
  const html = renderWaitingHtml([{ id: "w1", kind: "action", text: "Click it", since: T }], { messages: [msg("t-9", "Owner", "Can you check?", T), msg("t-9", "Manager", "Checked: fine.", T + 1)] });
  assert.ok(html.indexOf("Click it") > -1 && html.indexOf("Click it") < html.indexOf("Can you check?"), html);
  assert.match(renderWaitingHtml([], { messages: [msg("t-9", "Owner", "Can you check?", T), msg("t-9", "Manager", "Checked: fine.", T + 1)] }), /Can you check\?/);
  assert.match(renderWaitingHtml([]), /Nothing needs you\./);
  assert.doesNotMatch(renderWaitingHtml([], { messages: [msg("t-9", "Owner", "Waiting", T)] }), /Waiting/, "the owner's own last word waits on Manager, not here");
});

test("a thread message's files: an image opens in the lightbox with that message's other images, Esc-able; any other file downloads in place", () => {
  const b = loadNames(["msgHtml", "openShot", "closeShot"]);
  const id1 = "392a9fe2edba5da37e73585fbc68825a", id2 = "d2ff20e3dc150c8fff5417cd8f4e6544", id3 = "0304d2adb98fa84a699c66a27aab61e9";
  const html = b.msgHtml({ thread: "t-1", from: "Sam", text: "x", at: 1, assets: [
    { id: id1, name: "a.png", type: "image/png" }, { id: id2, name: 'b"<i>.png', type: "image/png" }, { id: id3, name: "log.txt", type: "text/plain" }, { id: "../x", name: "bad", type: "image/png" }] });
  assert.match(html, new RegExp(`<button type="button" class="thumb fthumb" data-full="/_blob/${id1}" data-cap="a.png"><img src="/_blob/${id1}" alt="a.png" loading="lazy"></button>`));
  assert.match(html, /data-cap="b&quot;&lt;i&gt;\.png"/, "a file name is escaped");
  assert.match(html, new RegExp(`<a href="/_blob/${id3}" download="log.txt">log.txt</a>`));
  assert.doesNotMatch(html, /target=|\.\.\/x|<i>/);
  // Clicking the second image opens the lightbox on it, with the message's two images to step through.
  const thumbs = [{ dataset: { full: `/_blob/${id1}`, cap: "a.png" } }, { dataset: { full: `/_blob/${id2}`, cap: "b.png" } }];
  const scope = { querySelectorAll: () => thumbs };
  for (const t of thumbs) t.closest = (sel) => (sel.split(",").includes(".sentfiles") ? scope : null);
  b.els["lb-img"] = { src: "", alt: "", style: {}, classList: { add() {}, remove() {} }, removeAttribute(n) { this[n] = ""; } };
  b.els["lb-close"] = { focus() {} };
  b.els.lightbox = { hidden: true };
  b.openShot(thumbs[1]);
  assert.equal(b.els.lightbox.hidden, false);
  assert.equal(b.els["lb-img"].src, `/_blob/${id2}`);
  assert.match(b.els["lb-cap"].textContent, /b\.png {2}\(2 of 2\)/);
  b.closeShot();
  assert.equal(b.els.lightbox.hidden, true, "Esc's close");
});
