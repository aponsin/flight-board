// Every reply box is #C359's compact box (#C368, the owner's A in #T980): the choices as chips above it, the box with its
// own Attach and Send. The box's Send sends the note as the "with a note" outcome: Something else (a decision), Change
// something (an approval), Something went wrong (an action), a follow-up (an answer, whose Ack is its choice). Enter
// presses that Send. Empty, the box is one line; with text or files it grows. The laptop bar says files paste or drop
// (Checker's LOW on #C359); a phone has the paperclip and shorter placeholders.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames, renderWaitingHtml } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const since = Date.now();
const ask = (w) => renderWaitingHtml([{ since, done: false, ...w }], { assets: true });
const choices = (html) => (html.match(/<div class="cchoice btns">([\s\S]*?)<\/div><div class="cbox">/) || [, ""])[1];
const send = (html) => (html.match(/<button type="button" class="ok" data-act="(\w+)" data-id="[^"]*" data-csend>([^<]*)<\/button>/) || []).slice(1);
const ph = (html) => (html.match(/<textarea id="note-[^"]*" rows="1" placeholder="([^"]*)">/) || [, null])[1];

test("a decision: its options and a dashed 'Something else' above; the box sends as something else", () => {
  const h = ask({ id: "d1", kind: "decision", text: "Where from?", options: [{ key: "A", label: "The bar", recommended: true }, { key: "B", label: "The map" }] });
  const c = choices(h);
  assert.match(c, /data-act="chose" data-choice="A" data-id="d1"><b>A<\/b> The bar <span class="recl">Manager's pick<\/span><\/button>/);
  assert.match(c, /<button type="button" class="other" data-focus="note-d1">Something else \(say what\)<\/button>$/, "it puts the cursor in the box; it sends nothing");
  assert.deepEqual(send(h), ["other", "Send as something else"]);
  assert.equal(ph(h), "Anything to add? (optional)");
  assert.match(h, /<div class="keys">Enter sends it as “Something else” · paste or drop files<\/div>/);
});

test("an approval: OK and Change something above; the box's note is a change", () => {
  const h = ask({ id: "p1", kind: "decision", text: "OK to publish?" });
  assert.equal(choices(h), '<button type="button" class="ok" data-act="ok" data-id="p1">OK</button><button type="button" data-act="change" data-id="p1">Change something</button>');
  assert.deepEqual(send(h), ["change", "Send"]);
  assert.equal(ph(h), "What should change? (optional)");
});

test("an action: Done and Something went wrong above; the box's note asks for help", () => {
  const h = ask({ id: "x1", kind: "action", text: "Install", steps: ["x"] });
  assert.equal(choices(h), '<button type="button" class="ok" data-act="done" data-id="x1">Done</button><button type="button" class="help" data-act="help" data-id="x1">Something went wrong, help</button>');
  assert.deepEqual(send(h), ["help", "Send"]);
  assert.equal(ph(h), "A note (optional): what you saw");
});

test("an answer: Ack above (closing it needs no typing); the box sends a follow-up", () => {
  const h = ask({ id: "n1", kind: "answer", text: "They're in.", question: "q" });
  assert.equal(choices(h), '<button type="button" class="ok" data-act="ack" data-id="n1">Ack</button>');
  assert.deepEqual(send(h), ["ack", "Send"]);
  assert.equal(ph(h), "Reply to Manager");
});

test("one compact box: one line empty (no .has), the files' chips at its top, Attach and Send in its bar", () => {
  const h = ask({ id: "x1", kind: "action", text: "Install", steps: ["x"] });
  assert.match(h, /<div class="reply cmp" data-reply="x1"><div class="cchoice btns">/);
  assert.match(h, /<div class="cbox"><div class="cfiles"><\/div><textarea id="note-x1" rows="1"[^>]*><\/textarea><div class="cbar"><div class="keys">[^<]*<\/div><span class="cbtns btns"><button type="button" class="attach" data-attach="x1"/);
  const none = renderWaitingHtml([{ id: "x1", kind: "action", text: "Install", steps: ["x"], since }]);
  assert.doesNotMatch(none, /cfiles|data-attach|paste or drop/, "a board that can't store files says nothing of them");
  for (const r of [".cmp:not(.has) .cbox{grid-template-columns:minmax(0,1fr) auto}", ".cmp:not(.has) :is(.cfiles,.cbar .keys){display:none}", ".cmp:not(.has) textarea{height:2.1em}"]) assert.ok(page.includes(r), r);
  assert.match(page, /@media \(max-width:600px\)\{\.cchoice\{flex-direction:column;align-items:stretch\}/, "a phone: the choices stack full width");
});

test("it grows with text or a waiting file, and shrinks back", () => {
  const b = loadNames(["cmpHas", "pendingFiles"]);
  const cls = new Set(), c = { dataset: { reply: "x1" }, classList: { toggle: (k, on) => (on ? cls.add(k) : cls.delete(k)) } };
  const t = { value: "", closest: () => c };
  b.cmpHas(t); assert.ok(!cls.has("has"));
  t.value = "hi"; b.cmpHas(t); assert.ok(cls.has("has"));
  t.value = " "; b.cmpHas(t); assert.ok(!cls.has("has"), "spaces alone: still empty");
  b.pendingFiles.set("x1", [{ name: "a.png" }]); b.cmpHas(t); assert.ok(cls.has("has"), "a file waiting");
  assert.match(page, /function fitBox\(t\)\{if\(!t\|\|t\.tagName!=="TEXTAREA"\|\|!t\.style\)return;cmpHas\(t\);/, "on every input and every restored draft");
});

test("Enter presses the box's own Send (whatever the choices above); an empty box sends nothing", () => {
  const { enterKey } = loadNames(["enterKey"]);
  const cs = { sel: "[data-csend]" }, opt = { sel: "[data-act=other]" };
  const box = { querySelector: (s) => (s === "[data-csend]" ? cs : s === "[data-act=other]" ? opt : null), querySelectorAll: () => [] };
  const key = (value) => ({ key: "Enter", target: { tagName: "TEXTAREA", value, closest: () => box }, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, keyCode: 13 });
  assert.equal(enterKey(key("a note")).button, cs);
  assert.equal(enterKey(key("  ")).act, "none");
  assert.match(page, /hasAttribute\("data-csend"\)&&!note\.trim\(\)&&!files\.length\)\{msg\.textContent="Write your note first, or pick a choice above\.";focus\(\);return\}/, "the box's Send with nothing in it: says so, never acks");
});

test("a thread's box: its Ack, Close or a decision's options above; Send in the box", () => {
  const b = loadNames(["threadHtml"]);
  const T = Date.now();
  Object.assign(b.state, { steps: [], derived: [], waiting: [], ideas: [], initRaw: [], initiatives: [], threads: [],
    messages: [{ id: "m1", thread: "t-a", from: "Owner", text: "Q", at: T - 2e3 }, { id: "m2", thread: "t-a", from: "Manager", text: "A", at: T - 1e3 }] });
  const h = b.threadHtml("t-a", "panel", { acts: true });
  assert.match(h, /<div class="reply cmp" data-reply="th:t-a"><div class="cchoice btns"><button type="button" class="ok" data-tack="t-a" data-where="panel">Ack<\/button><\/div><div class="cbox">/);
  assert.match(h, /<button type="button" class="ok" data-tsend="t-a" data-where="panel" data-csend>Send<\/button>/);
  assert.match(h, /placeholder="Reply to Manager"/);
  assert.match(b.threadHtml("t-a", "panel"), /<div class="cchoice btns"><button type="button" data-tclose="t-a"/, "a card's own thread: Close, as before");
  const none = b.threadHtml("t-none", "panel");
  assert.doesNotMatch(none, /cchoice/, "nothing to choose: no row");
  assert.match(none, /placeholder="Start a thread on this"/);
});

test("the new-thread box's bar says files paste or drop too (Checker's LOW on #C359)", () => {
  assert.match(page, /document\.querySelectorAll\("\[data-keys\]"\)\.forEach\(x=>\{x\.textContent=CMP_HINT\.send\+DROP_HINT\}\)/);
  assert.match(page, /const DROP_HINT=" · paste or drop files";/);
  for (const s of ['"Reply"', '"Anything to add?"', '"What should change?"', '"A note (optional)"']) assert.ok(page.includes(`narrow?${s}`) || page.includes(`?${s}:`), `a phone's placeholder ${s}`);
});
