// Options read one per line, the letter bold (#C369, the owner in #T981: #T980's A/B text read as one wall). An option
// marker ("A)", "A:", "Option A"; "1)" as before) at a line's start, or after a sentence, starts its own line with the
// marker bold; a line break is a break; a blank line a small gap. Asks (and answers), thread messages and card summaries.
// Bold only from the page's own markup: the text stays escaped.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const b = loadNames(["askText", "msgHtml", "askHtml", "initRow"]);
Object.assign(b.state, { steps: [], derived: [], waiting: [], ideas: [], messages: [], threads: [], initRaw: [], initiatives: [] });
const k = (m) => `<b class="optk">${m}</b>`;
// #T980, as Manager wrote it.
const T980 = "The compact box for thread replies (#C368). Each mock-up shows a plain reply (empty, then with an image and a PDF), a decision with my pick and 'Something else (say what)', an approval (OK / Change something), and an action (Done / Something went wrong, with a note). A) the choices sit as chips above the box, and the box keeps its own Send, so typing a note and pressing Send counts as 'Something else'. B) the choices sit in the box's bottom bar in place of Send: type a note if you like, then tap a choice, and the note goes with it. Designer and I pick B.";

test("#T980: each option on its own line, its letter bold", () => {
  const h = b.askText(T980);
  assert.ok(h.includes(`with a note).<br>${k("A)")} the choices sit as chips`), h);
  assert.ok(h.includes(`counts as &#39;Something else&#39;.<br>${k("B)")} the choices sit in the box`), h);
  assert.ok(h.includes("in place of Send: type a note"), "'Send:' is no marker");
  assert.equal((h.match(/class="optk"/g) || []).length, 2);
});

test("markers: A), A:, Option A, 1); at a line's start or after a sentence only", () => {
  assert.equal(b.askText("Pick one: A: red. B: blue"), `Pick one:<br>${k("A:")} red.<br>${k("B:")} blue`);
  assert.equal(b.askText("Option A: keep 12.\nOption B) show 20"), `${k("Option A:")} keep 12.<br>${k("Option B)")} show 20`);
  assert.equal(b.askText("Steps: 1) open 2) press"), `Steps:<br>${k("1)")} open<br>${k("2)")} press`);
  assert.equal(b.askText("Plan A: red, then plan B is fine"), "Plan A: red, then plan B is fine", "mid-sentence: plain");
  assert.equal(b.askText("A) <b>x</b>"), `${k("A)")} &lt;b&gt;x&lt;/b&gt;`, "escaped: bold only from the page");
  assert.match(b.askText("see https://x.dev/a?q=A)z. B) next"), /<a href="https:\/\/x\.dev\/a\?q=A\)z"[^>]*>https:\/\/x\.dev\/a\?q=A\)z<\/a>\.<br><b class="optk">B\)<\/b> next/, "never inside a link");
});

test("a blank line is a small gap; a line break a break", () => {
  assert.equal(b.askText("Pick one.\n\nA) Red\nB) Blue"), `Pick one.<span class="pgap"></span>${k("A)")} Red<br>${k("B)")} Blue`);
  assert.equal(b.askText("One\n\n\nTwo\nThree"), `One<span class="pgap"></span>Two<br>Three`);
  assert.equal(b.askText("Do:\n- this\n\nthen that"), `Do:<ul class="w-list"><li>this</li></ul><span class="pgap"></span>then that`);
});

test("in thread messages, answers and card summaries", () => {
  const two = "Which?\n\nA) Red. B) Blue";
  const want = `Which?<span class="pgap"></span>${k("A)")} Red.<br>${k("B)")} Blue`;
  assert.ok(b.msgHtml({ from: "Manager", text: two, at: Date.now() }).includes(`<div class="t-text">${want}</div>`));
  assert.ok(b.askHtml({ id: "a1", kind: "answer", text: two, question: "q", since: Date.now() }, new Set()).includes(`<div class="w-answer">${want}</div>`));
  assert.ok(b.initRow({ id: "c1", name: "C", size: "S", status: "active", phase: "plan", summary: two }).includes(`<div class="w-sub">${want}</div>`));
});
