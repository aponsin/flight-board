// store-page-scrollbars (#C836): the owner could hardly see the page's scroll bars on a laptop in light mode: a bare page gets the browser's thin overlay bar.
// The page names the bar's colors (the browser then draws a classic bar that stays) and each theme's thumb against its track, and against the panel it
// sits on, is at least 3:1 (the WCAG bar for a part of a control).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];

// A block's tokens: "--name:#rrggbb" pairs inside one rule.
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
const light = tokens(css.match(/:root\{([\s\S]*?)\n\}/)[1]);
const darkAuto = tokens(css.match(/@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\)\{([\s\S]*?)\}\}/)[1]);
const darkSet = tokens(css.match(/:root\[data-theme="dark"\]\{([\s\S]*?)\}/)[1]);

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("the page names its scroll bar colors for every theme, and the dark ones are the same in both ways a theme is chosen", () => {
  assert.match(css, /\*\{scrollbar-color:var\(--sb-thumb\) var\(--sb-track\)\}/);
  for (const [name, t] of [["light", light], ["dark (system)", darkAuto], ["dark (chosen)", darkSet]]) {
    assert.match(t["sb-thumb"] ?? "", /^#/, `${name}: a thumb color`);
    assert.match(t["sb-track"] ?? "", /^#/, `${name}: a track color`);
  }
  assert.equal(darkAuto["sb-thumb"], darkSet["sb-thumb"]); assert.equal(darkAuto["sb-track"], darkSet["sb-track"]);
});

test("the thumb stands out from its track, and from the panel and the page behind, at 3:1 in light and in dark", () => {
  for (const [name, t] of [["light", light], ["dark", darkSet]]) {
    assert.ok(ratio(t["sb-thumb"], t["sb-track"]) >= 3, `${name}: thumb on track ${ratio(t["sb-thumb"], t["sb-track"]).toFixed(2)}`);
    assert.ok(ratio(t["sb-thumb"], t.panel ?? light.panel) >= 3, `${name}: thumb on the panel`);
    assert.ok(ratio(t["sb-thumb"], t.bg ?? light.bg) >= 3, `${name}: thumb on the page`);
  }
});

test("Safari before 18.2 gets the same colors from the webkit rules, and the tab strip still hides its own bar", () => {
  assert.match(css, /::-webkit-scrollbar\{width:12px;height:12px\}/);
  assert.match(css, /::-webkit-scrollbar-track\{background:var\(--sb-track\)\}/);
  assert.match(css, /::-webkit-scrollbar-thumb\{background:var\(--sb-thumb\)/);
  assert.match(css, /\.ttabs::-webkit-scrollbar\{display:none\}/);
  assert.match(css, /\.ttabs\{[^}]*scrollbar-width:none/);
});
