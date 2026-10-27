// Text boxes grow with their text (#C357, the owner in #T964, changed: about 6 lines, then scroll inside): a new line
// (⌘+Enter or a wrap), a paste or a restored draft fits the box to its text, up to six lines, and keeps the line with the
// cursor in view (⌘+Enter's setRangeText never scrolled the box, so the text went out of view). Sending shrinks it back.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
// A text box as the browser reports it: content height, visible height (after the page sets it) and the cursor.
const box = (value, contentH, at = value.length) => ({ tagName: "TEXTAREA", style: {}, value, scrollHeight: contentH, selectionEnd: at, scrollTop: 0, get clientHeight() { return parseFloat(this.style.height) - 2; } });
const MAX = 21 * 6 + 14; // six 21 px lines and the padding, when the page can't read the styles

test("a box grows with its text, no scroll bar while it fits", () => {
  const { fitBox } = loadNames(["fitBox"]);
  const t = box("one\ntwo\nthree", 80);
  fitBox(t);
  assert.equal(t.style.height, "82px");
  assert.equal(t.style.overflowY, "hidden");
});

test("past about six lines it stops growing and scrolls inside, the cursor's line in view", () => {
  const { fitBox } = loadNames(["fitBox"]);
  const end = box("x\n".repeat(20), 440);
  fitBox(end);
  assert.equal(end.style.height, `${MAX}px`);
  assert.equal(end.style.overflowY, "auto");
  assert.equal(end.scrollTop, 440, "the cursor at the end: scrolled to the end");
  const mid = box("x\n".repeat(20), 440, 2 * 15);
  mid.scrollTop = 0;
  fitBox(mid);
  assert.equal(mid.scrollTop, 15 * 21 + 21 - (MAX - 2), "the cursor on line 16: scrolled just enough to show that line at the bottom");
  const top = box("x\n".repeat(20), 440, 2);
  top.scrollTop = 300;
  fitBox(top);
  assert.equal(top.scrollTop, 21, "a cursor above the view brings the view up to it");
});

test("it fits on input, after ⌘+Enter, on a restored draft and after sending", () => {
  const { takeDraft } = loadNames(["takeDraft"]);
  const t = box("a long note\nsecond line", 60);
  t.style.height = "62px";
  const d = takeDraft(t);
  assert.equal(t.value, "");
  assert.equal(d.text, "a long note\nsecond line");
  assert.equal(t.style.overflowY, "hidden", "emptied: fitted again (the browser then reports the empty box's height)");
  assert.match(page, /document\.addEventListener\("input",e=>fitBox\(e\.target\)\)/, "typing, a paste and ⌘+Enter (it dispatches input) refit the box");
  assert.match(page, /function takeDraft\(ta\)\{const text=\(ta&&ta\.value\|\|""\)\.trim\(\);if\(ta\)\{ta\.value="";fitBox\(ta\)\}/, "sending shrinks it back");
  assert.match(page, /if\(t&&!t\.value\)\{t\.value=text;fitBox\(t\)\}/, "a failed send's text comes back fitted");
  assert.match(page, /Object\.entries\(drafts\)\.forEach\(\(\[id,v\]\)=>\{const t=document\.getElementById\(id\);if\(t\)\{t\.value=v;fitBox\(t\)\}\}\)/, "a draft restored after a re-draw is fitted");
  assert.match(page, /Object\.entries\(drafts\)\.forEach\(\(\[id,v\]\)=>\{const x=document\.getElementById\(id\);if\(x\)\{x\.value=v;fitBox\(x\)\}\}\)/, "Needs you's own restore too");
});
