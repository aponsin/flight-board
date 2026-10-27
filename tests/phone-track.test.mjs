// The phase track on a phone (#C292): the current step squeezed to a sliver ("B B"), because the wide-screen rule
// .track>.step.now{flex:2.2 1 0} outranks the phone's .track>.step{flex:1 1 22%}, so the step kept a zero basis and got
// only what its wrapped line had left. On a phone every step, the current one too, now takes the same quarter row.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const phone = (/@media \(max-width:760px\)\{([^@]*?\}\})/.exec(css) ?? ["", ""])[1];

test("on a phone the current step takes a quarter row like the others, never the line's leftover", () => {
  assert.match(css, /\.track>\.step\.now\{flex:2\.2 1 0\}/, "wide screens keep the current step wider");
  assert.match(phone, /\.track>\.step,\.track>\.step\.now\{flex:1 1 22%\}/);
});
