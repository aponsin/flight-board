// #C977 (Director check 2): a count chip ("3 blocking", "0 risks") never wraps onto two lines. The chip's own rule carries
// white-space:nowrap; the chips the page draws use that class, so a narrow card breaks between chips, never inside one.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const css = page.match(/<style>([\s\S]*?)<\/style>/)[1];

test("the .chip rule keeps its text on one line", () => {
  const rule = css.match(/(?:^|\n)\.chip\{([^}]*)\}/);
  assert.ok(rule, "a .chip rule");
  assert.match(rule[1], /(?:^|;)white-space:nowrap(?:;|$)/);
});

test("the count chips the page draws use the .chip class, and the chips stay separate items", () => {
  const fn = page.match(/function issueChips\(i\)\{[\s\S]*?\n/)[0];
  assert.match(fn, /<span class="chip \$\{v\?"":"zero"\}">\$\{v\} \$\{issueLabel\(l,v\)\}<\/span>/, "one chip per count (#C1008: its label singular at 1)");
  assert.match(fn, /\.join\(" "\)/, "a space between chips, so a line can break between them");
});
