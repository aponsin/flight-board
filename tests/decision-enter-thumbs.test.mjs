// A decision's box on a laptop (#C353, the owner on a decision item): Enter in "Anything to add?" did nothing; with a
// note typed it now sends it as "Something else", and ⌘/Ctrl+Enter stays a new line. Each option's pictures (#C344)
// sat in a ~50 px column, labels one word a line: now each shows at a readable width (about 240 px on a laptop, full
// width on a phone), its label on one or two lines, its button beside it (under it on a phone).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames, renderWaitingHtml } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
function press({ value = "the third one", meta = false, ctrl = false, buttons }) {
  const found = (sel) => buttons.find((b) => sel.split(",").includes(b.sel)) ?? null;
  const box = { querySelector: (sel) => found(sel), querySelectorAll: (sel) => (sel === ".btns button" ? buttons.filter((b) => b.sel.startsWith(".btns button")) : []) };
  return { key: "Enter", target: { tagName: "TEXTAREA", value, closest: () => box }, shiftKey: false, metaKey: meta, ctrlKey: ctrl, altKey: false, isComposing: false, keyCode: 13 };
}
const decision = () => [{ sel: ".btns button.opt" }, { sel: ".btns button.opt" }, { sel: "[data-act=other]" }];

test("Enter in a decision's box sends the note as 'Something else'; ⌘/Ctrl+Enter is a new line; an empty box sends nothing", () => {
  const { enterKey } = loadNames(["enterKey"]);
  const buttons = decision();
  assert.equal(enterKey(press({ buttons })).button, buttons[2], "the note goes as Something else");
  assert.equal(enterKey(press({ buttons, meta: true })).act, "line");
  assert.equal(enterKey(press({ buttons, ctrl: true })).act, "line");
  assert.equal(enterKey(press({ buttons, value: "  " })).act, "none", "no note: it never picks an option for the owner");
  assert.equal(enterKey(press({ buttons: [{ sel: ".btns button.opt" }, { sel: "[data-act=other]", disabled: true }] })).act, "none", "a disabled button");
  assert.equal(enterKey(press({ buttons: [{ sel: ".btns button.ok" }, { sel: ".btns button.help" }] })).act, "none", "Done or 'Something went wrong' still never guesses (Checker)");
});

test("a decision's box says what Enter does", () => {
  const html = renderWaitingHtml([{ id: "d1", kind: "decision", text: "Pick one", options: [{ key: "A", label: "a" }, { key: "B", label: "b" }], since: Date.now(), done: false }]);
  assert.match(html, /<div class="keys">Enter sends it as “Something else” · Ctrl\+Enter for a new line<\/div>/);
  const ok = renderWaitingHtml([{ id: "d2", kind: "decision", text: "OK to ship?", since: Date.now(), done: false }]);
  assert.match(ok, /Click a button to send/, "OK or Change something: still two outcomes");
});

test("each option's pictures at a readable width: ~240 px beside the button on a laptop, full width above it on a phone", () => {
  const html = renderWaitingHtml([{ id: "d1", kind: "decision", text: "Which hero?", options: [{ key: "A", label: "the oval one" }, { key: "B", label: "two" }], images: [{ url: "/_blob/abcdefgh", option: "A", label: "Laptop, oval hero over the sky photo" }], since: Date.now(), done: false }]);
  assert.match(html, /<div class="opt-line"><div class="opt-shots"><button type="button" class="thumb"[^>]*><img[^>]*><span>Laptop, oval hero over the sky photo<\/span><\/button><\/div><button type="button" class="opt"/);
  assert.match(page, /\.opt-line\{display:grid;grid-template-columns:minmax\(0,240px\) minmax\(0,1fr\);/, "a 240 px column beside the button");
  assert.match(page, /\.opt-shots \.thumb\{width:100%;max-width:none;/, "the picture fills its column");
  assert.match(page, /\.opt-shots \.thumb span\{[^}]*-webkit-line-clamp:2/, "its label on one or two lines");
  assert.match(page, /@media \(max-width:760px\)\{\.opt-line\{grid-template-columns:minmax\(0,1fr\)\}/, "full width on a phone, the button under it");
});
