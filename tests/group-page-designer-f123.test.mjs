// #C1299 (Designer's F1 to F3 on the group tip): the page's styles are read from the template's own text.
// F1: a long "Waiting on" line widened the whole phone page (870 px at 390); the flex item and the line must be allowed to shrink so the ellipsis applies.
// F3: the dialog's .go button had white text on the dark accent (2.39:1); it takes the panel colour as button.ok does.
// (F2, the install tile word, is tested in ship-cell-waits-for-install.test.mjs.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const TEMPLATE = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const phone = TEMPLATE.slice(TEMPLATE.indexOf("@media (max-width:760px){select.mv"));

test("F1: on a phone the meta row and the Waiting on line may shrink below their text", () => {
  assert.match(phone.slice(0, 1200), /\.i-meta\{min-width:0\}\.i-meta \.wo\{min-width:0;max-width:100%\}/);
});

test("F3: the dialog's go button reads in the panel colour on the accent, not white", () => {
  assert.match(TEMPLATE, /\.askd button\.go\{background:var\(--accent\);border-color:var\(--accent\);color:var\(--panel\)\}/);
  assert.equal(/\.askd button\.go\{[^}]*color:#fff/.test(TEMPLATE), false);
});
