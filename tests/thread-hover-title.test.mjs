// Hovering a thread shows its title (#C380, the owner: "just like for Initiatives"): a #T link anywhere ("from #T979",
// a #T in a message or an ask, Resolved in the last 24 h) shows the card bubble's twin on a mouse's hover or a keyboard's
// focus: its number and title, then whom it waits on, its newest word and how long ago. All text escaped; no new data.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const T = Date.now();
function board() {
  const b = loadNames(["linkify", "threadBubble", "cardBubble", "cbubShow", "cbubHide"]);
  Object.assign(b.state, {
    steps: [], derived: [], todo: [], ideas: [], waiting: [], initiatives: [], events: [],
    threads: [{ id: "t-5", num: 5, title: "Ack <placement>" }, { id: "t-6", num: 6 }],
    messages: [
      { id: "m1", thread: "t-5", from: "Manager", at: T - 30 * 6e4, text: "Two mock-ups." },
      { id: "m2", thread: "t-5", from: "Owner", at: T - 12 * 6e4, text: "I like B  &\nkeep   the row " + "x".repeat(120) },
      { id: "m3", thread: "t-6", from: "Owner", at: T - 2 * 6e4, text: "What about the hover?" },
    ],
  });
  return b;
}

test("the bubble: #T number and title, then whom it waits on, the newest word cut to one line, and its age; escaped", () => {
  const b = board();
  const h = b.threadBubble("t-5", T);
  assert.match(h, /^<b>#T5 Ack &lt;placement&gt;<\/b><br>[A-Z][a-z ]+ · Owner: I like B &amp; keep the row x+… · 12 min ago$/, h);
  assert.ok(h.length < 260, "the newest word is cut, so it stays two lines");
  assert.match(b.threadBubble("t-6", T), /^<b>#T6 What about the hover\?<\/b><br>.* · Owner: What about the hover\? · 2 min ago$/, "an untitled thread: its first words, as the rows show it");
});

test("a #T link in text shows its thread's bubble; a card's link keeps the card's", () => {
  const b = board();
  const cbub = b.document.getElementById("cbub");
  cbub.style ??= {};
  const ref = (data) => ({ dataset: data, setAttribute() {}, removeAttribute() {}, getBoundingClientRect: () => ({ left: 10, top: 10, bottom: 30 }) });
  assert.match(b.linkify("see #T5"), /<a href="#" class="t-ref" data-tref="t-5">#T5<\/a>/);
  b.cbubShow(ref({ tref: "t-5" }));
  assert.equal(cbub.hidden, false);
  assert.match(cbub.innerHTML, /^<b>#T5 Ack &lt;placement&gt;<\/b>/);
  b.cbubHide();
  cbub.innerHTML = "";
  b.cbubShow(ref({ tref: "t-gone" }));
  assert.equal(cbub.innerHTML, "", "a thread the board doesn't have: no bubble");
});

test("wiring: hover (a mouse only) and focus show it for #T and #C links; a click hides it before opening the thread", () => {
  assert.match(page, /const BUB_REFS="\[data-cref\],\[data-tref\]";/);
  assert.match(page, /addEventListener\("mouseover",e=>\{if\(!HOVER\(\)\)return;const a=e\.target\.closest&&e\.target\.closest\(BUB_REFS\)/, "a phone's tap goes straight to the thread");
  assert.match(page, /addEventListener\("focusin",e=>\{const a=e\.target\.closest&&e\.target\.closest\(BUB_REFS\)/);
  assert.match(page, /closest\("\[data-tref\]"\);if\(!a\)return;e\.preventDefault\(\);cbubHide\(\);/);
});
