// #C1284 (the owner, #T2132 and t-1795129984181: "there is no A button" on a decision with pictures). Two causes: (1) an option is a button but read as a
// caption under a picture; (2) he wrote under the decision, a newer message came after it, the thread read as a question and the decision's buttons
// were gone, its text down in the scroll box. Now an option has a clear button look (CSS: a bordered "Choose A" bar with hover and focus, board tokens
// only), and an unanswered decision stays pinned above the thread's messages, with its buttons, until the owner's "Chose ..." comes after it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const css = page.slice(page.indexOf("<style>"), page.indexOf("</style>"));
const now = Date.now();
const two = [{ key: "A", label: "Left" }, { key: "B", label: "Right" }];
const owner = (id, at, text = "where is the A button?") => ({ id, thread: "t1", from: "Owner", text, at });
const decision = (at) => ({ id: "m-dec", thread: "t1", from: "Manager", text: "Pick one\n\nA or B?", at, kind: "decision", options: two, images: [{ url: "https://example.test/a.png", label: "Left", option: "A" }] });
const plain = (id, at) => ({ id, thread: "t1", from: "Manager", text: "a note", at });
const buttons = (html) => [...html.matchAll(/data-topt="([^"]*)"[^>]*data-choice="([^"]*)"/g)].map((m) => `${m[1]}:${m[2]}`);
const load = (messages) => { const b = loadNames(["threadHtml", "threadState", "threadOptions", "openDecision", "optionText"]); b.state.messages = messages; b.state.threads = [{ id: "t1", num: 1 }]; return b; };

test("a decision with newer messages after it keeps its buttons and sits pinned above the scrolling messages", () => {
  const b = load([decision(now - 5000), owner("m2", now - 4000), plain("m3", now - 3000)]);
  const html = b.threadHtml("t1", "ask", { decide: true });
  assert.deepEqual(buttons(html), ["t1:A", "t1:B"], "the owner wrote after it, yet the options stay");
  const pin = html.match(/<div class="t-pin"[^>]*>([\s\S]*?)<\/div><div class="t-hist"/);
  assert.ok(pin && /Pick one/.test(pin[1]), "the decision is pinned above the history");
  assert.ok(!/Pick one/.test(html.slice(html.indexOf('class="t-hist"'))), "and is not drawn a second time inside the scroll box");
  assert.match(html.slice(html.indexOf('class="t-hist"')), /where is the A button\?/, "the other messages stay in the scroll box");
});

test("once the owner has picked, nothing is pinned and no option shows", () => {
  const b = load([decision(now - 5000), owner("m2", now - 1000, "Chose A: Left")]);
  const html = b.threadHtml("t1", "ask", { decide: true });
  assert.deepEqual(buttons(html), []);
  assert.doesNotMatch(html, /t-pin/);
});

test("a thread that asks for neither acts nor decide draws no pin, as before; and the pick still sends the decision's label", () => {
  const b = load([decision(now - 5000), plain("m3", now - 3000)]);
  assert.doesNotMatch(b.threadHtml("t1", "ask", {}), /t-pin/);
  assert.equal(b.optionText("t1", "B"), "Chose B: Right", "the options come from the pinned decision, not the last note");
});

// Checker 2's F1 on eace32ce: a decision whose thread was closed without a pick is not pinned and draws no buttons (a click would send a stale "Chose A" that reopens a closed thread).
test("a decision closed without a pick is not pinned: Manager resolves it, the owner resolves in words, the owner's closer, a resolved mark after it", () => {
  const closed = (name, messages) => { const b = load(messages); const html = b.threadHtml("t1", "ask", { decide: true }); const html2 = b.threadHtml("t1", "ask", { acts: true }); for (const h of [html, html2]) { assert.deepEqual(buttons(h), [], `${name}: no buttons`); assert.doesNotMatch(h, /t-pin/, `${name}: not pinned`); } };
  closed("Manager no longer needed, resolved", [decision(now - 5000), { ...plain("m2", now - 3000), text: "No longer needed", resolved: true }]);
  closed("owner resolves in words", [decision(now - 5000), { ...owner("m2", now - 3000, "go with A"), resolved: true }]);
  closed("owner's closer", [decision(now - 5000), plain("m2", now - 4000), owner("m3", now - 3000, "thanks")]);
  closed("a resolved mark after it", [decision(now - 5000), { ...plain("m2", now - 3000), resolved: true }]);
});

test("the owner's question or a plain note after the decision keeps it open and pinned (his A button is still there)", () => {
  for (const messages of [[decision(now - 5000), owner("m2", now - 3000)], [decision(now - 5000), plain("m2", now - 3000)]]) {
    const h = load(messages).threadHtml("t1", "ask", { decide: true });
    assert.deepEqual(buttons(h), ["t1:A", "t1:B"]);
    assert.match(h, /t-pin/);
  }
});

test("the look: an option is a bordered bar that says Choose, with hover and focus, in board tokens only", () => {
  assert.match(css, /\.cchoice button\.opt,\.opt-line>button\.opt,\.opt-grid>button\.opt\{[^}]*border:2px solid var\(--accent\)[^}]*min-height:44px/);
  assert.match(css, /button\.opt::before\{content:"Choose "/);
  assert.match(css, /button\.opt:hover\{background:var\(--accent\)/);
  assert.match(css, /button\.opt:hover \.recl\{color:var\(--panel\)\}/, "Manager's pick stays readable on the filled hover bar (Designer's F1)");
  assert.match(css, /\.t-pin \.t-msg\.t-new\{background:none;border-left:0/, "no second blue edge inside the pin");
  assert.match(css, /button\.opt:focus-visible\{outline:3px solid var\(--accent\)/);
  assert.match(css, /\.t-pin\{[^}]*border:2px solid var\(--accent\)/);
  assert.ok(!/(button\.opt[^{]*|\.t-pin)\{[^}]*#[0-9a-fA-F]{3,6}/.test(css), "no colour of its own");
});
