// #C1266 (the owner: he writes in a card's thread, moves on, and misses the reply): a card whose thread holds replies he has not read
// shows a "N new replies" pill on its title line, and those replies sit on a soft blue background with a "new" tag. Collapsing the
// thread marks its replies as read. What counts as read is kept in the browser, per device (localStorage), never in the store, and
// the words say "new reply", never "seen" (that word is the tick under your message, DATA.md row 20).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const css = page.slice(page.indexOf("<style>"), page.indexOf("</style>"));
const NAMES = ["threadOf", "initRow", "enrich", "gates", "newReplies", "seenAt", "markThreadSeen", "OWNER", "threadHtml", "msgHtml"];
const T = 1_800_000_000_000;
const msg = (from, text, at) => ({ id: `m${at}`, thread: "x", from, text, at });
const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), dump: m }; };
function board({ messages = [], storage = memory(), now = T } = {}) {
  const realNow = Date.now; Date.now = () => now;
  const b = loadNames(NAMES, { localStorage: storage });
  Date.now = realNow;
  b.state.steps = []; b.state.waiting = []; b.state.messages = messages;
  b.storage = storage;
  return b;
}
const card = (b) => b.initRow(b.gates(b.enrich({ id: "x", name: "X", status: "active", level: "Quick", skip: ["plan"] })));
// A board first opened at T, so what came before T is not new. Replies at T+10m and T+20m from the team; one of the owner's.
const thread = (b) => { b.state.messages = [msg("Owner", "can you check?", T - 600_000), msg("Manager", "old answer", T - 300_000), msg("Owner", "and this?", T + 300_000), msg("Manager", "first reply", T + 600_000), msg("Builder", "second reply", T + 1_200_000)]; };

test("a reply is new when someone other than the owner wrote it after the board last marked the thread read; the owner's own words never are", () => {
  const b = board();
  thread(b);
  assert.deepEqual([...b.newReplies("x")].map((m) => m.text), ["first reply", "second reply"]);
  assert.ok(![...b.newReplies("x")].some((m) => m.from === b.OWNER), "the owner's own message is never new");
});

test("a board opened for the first time has nothing new: replies that were already there are not flagged (no flood on the first visit)", () => {
  const b = board();
  b.state.messages = [msg("Owner", "q", T - 5000), msg("Manager", "a", T - 1000)];
  assert.equal(b.newReplies("x").length, 0);
  assert.equal(b.seenAt("x"), T, "the first visit's time is the baseline");
});

test("the card shows an N new replies pill on its title line, one reply in the singular, and no pill when nothing is new", () => {
  const b = board();
  thread(b);
  const html = card(b);
  assert.match(html, /<strong>X<\/strong><span class="newpill" title="2 replies you have not read yet">2 new replies<\/span>/);
  b.state.messages = [msg("Owner", "q", T + 1), msg("Manager", "a", T + 2)];
  assert.match(card(b), /<span class="newpill"[^>]*>1 new reply<\/span>/);
  b.state.messages = [msg("Owner", "q", T + 1)];
  assert.doesNotMatch(card(b), /newpill/);
});

test("the card still shows what it showed: its Thread (N) label with the message count, and the badge", () => {
  const b = board();
  thread(b);
  assert.match(card(b), /<summary>Thread \(5\)<\/summary>/);
  b.state.messages = [msg("Owner", "Is this still on?", T + 1)];
  assert.match(card(b), /<details class="i-thread" data-id="ith-x"><summary>Thread \(1\)<span class="t-badge open">with the team/, "the owner's word last: the badge, and no new-reply mark");
});

test("with replies waiting the thread's label is marked, and its new replies carry a background class and a 'new' tag; older ones and the owner's do not", () => {
  const b = board();
  thread(b);
  const html = card(b);
  assert.match(html, /<details class="i-thread has-new" data-id="ith-x">/);
  const news = html.match(/<div class="t-msg t-new">/g) ?? [];
  assert.equal(news.length, 2, "the two replies waiting");
  assert.equal((html.match(/<span class="t-newtag">new<\/span>/g) ?? []).length, 2);
  const tail = html.slice(html.indexOf("old answer") - 200, html.indexOf("old answer") + 40);
  assert.doesNotMatch(tail, /t-new/, "an older reply is plain");
  assert.match(html, /<div class="t-msg t-owner"><span class="t-from">Owner<\/span> <span class="t-at">/, "the owner's own messages stay plain");
});

test("a thread drawn anywhere else (no newAt) is not marked: only a card's own thread carries the new-reply look", () => {
  const b = board();
  thread(b);
  assert.doesNotMatch(b.threadHtml("x", "wait", {}), /t-new|t-newtag/);
});

test("collapsing the card's thread marks its replies as read: the pill and the background go, and a later reply is new again", () => {
  const b = loadAndBoard();
  thread(b.b);
  assert.match(card(b.b), /newpill/);
  const d = { tagName: "DETAILS", dataset: { id: "ith-x" }, open: false, classList: { contains: (c) => c === "i-thread" } };
  b.fire("toggle", { target: d });
  const html = card(b.b);
  assert.doesNotMatch(html, /newpill|has-new|t-new/);
  b.b.state.messages.push(msg("Manager", "third reply", T + 2_000_000));
  assert.match(card(b.b), /<span class="newpill"[^>]*>1 new reply<\/span>/);
});
function loadAndBoard() {
  const storage = memory();
  const realNow = Date.now; Date.now = () => T;
  const b = loadNames(NAMES, { localStorage: storage });
  Date.now = realNow;
  b.state.steps = []; b.state.waiting = [];
  return { b, fire: (type, e) => b.listeners[type].forEach((fn) => fn(e)) };
}

test("opening the thread does not clear it, and collapsing some other fold (Details, an ask) does not either", () => {
  const { b, fire } = loadAndBoard();
  thread(b);
  fire("toggle", { target: { tagName: "DETAILS", dataset: { id: "ith-x" }, open: true, classList: { contains: (c) => c === "i-thread" } } });
  assert.match(card(b), /newpill/, "opening it leaves the replies new");
  fire("toggle", { target: { tagName: "DETAILS", dataset: { id: "idet-x" }, open: false, classList: { contains: () => false } } });
  fire("toggle", { target: { tagName: "DETAILS", dataset: { id: "th-ask1" }, open: false, classList: { contains: () => false } } });
  assert.match(card(b), /newpill/, "Details and an ask's row are not the card's thread");
});

test("each thread keeps its own time: reading one card's thread leaves another's replies new", () => {
  const { b, fire } = loadAndBoard();
  b.state.messages = [{ ...msg("Manager", "for y", T + 5), thread: "y" }, msg("Manager", "for x", T + 5)];
  fire("toggle", { target: { tagName: "DETAILS", dataset: { id: "ith-x" }, open: false, classList: { contains: (c) => c === "i-thread" } } });
  assert.equal(b.newReplies("x").length, 0);
  assert.equal(b.newReplies("y").length, 1);
});

test("it lives in the browser, per device: one localStorage key, nothing written to the store, and a browser that blocks storage still works", () => {
  const { b, fire } = loadAndBoard();
  fire("toggle", { target: { tagName: "DETAILS", dataset: { id: "ith-x" }, open: false, classList: { contains: (c) => c === "i-thread" } } });
  const fn = page.slice(page.indexOf("function markThreadSeen"), page.indexOf("function newReplies"));
  assert.ok(fn.includes("localStorage") || page.includes('const SEEN_KEY="flight-board-thread-seen"'), "kept in localStorage under its own key");
  assert.ok(!/applyWrites|fetch\(|window\.claude/.test(fn), "markThreadSeen writes nothing to the store");
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const c = board({ storage: blocked });
  thread(c);
  assert.doesNotThrow(() => card(c));
  assert.doesNotThrow(() => c.markThreadSeen("x"));
});

test("the words say new reply, never 'seen' (that is the tick under your own message)", () => {
  const b = board();
  thread(b);
  const html = card(b);
  const pill = html.match(/<span class="newpill"[^>]*>[^<]*<\/span>/)[0];
  assert.doesNotMatch(pill, /seen/i);
  assert.doesNotMatch(html.match(/<span class="t-newtag">[^<]*<\/span>/)[0], /seen/i);
});

test("the look: a pill in the board's accent, the thread label in the accent, and replies on the soft accent with a bar, in both themes through the board's tokens", () => {
  assert.match(css, /\.newpill\{[^}]*background:var\(--accent\);color:var\(--panel\)/);
  assert.match(css, /\.i-thread\.has-new>summary\{color:var\(--accent\);font-weight:600\}/);
  assert.match(css, /\.t-msg\.t-new\{background:var\(--accent-soft\);border-left:4px solid var\(--accent\)/);
  assert.match(css, /\.t-newtag\{[^}]*color:var\(--accent\)/);
  assert.ok(!/\.(newpill|t-new|t-newtag)\{[^}]*#[0-9a-fA-F]{3,6}/.test(css), "no colour of its own");
});
