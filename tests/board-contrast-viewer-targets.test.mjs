// #C1024 (Builder's #C971 check): muted text reaches 4.5:1 on every surface of the page in light mode and in both dark rules, and the picture viewer's
// buttons are 44 px tall on a phone (they were 31 px on a 375 px screen).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const SURFACES = ["bg", "panel", "track", "line", "accent-soft", "ok-soft", "warn-soft", "bad-soft"];
// The three rule bodies that define the tokens: the light :root, the dark media rule and the dark data-theme rule.
const rules = [
  ["light :root", page.match(/:root\{\s*(--bg:[^}]*)\}/)],
  ["dark (system)", page.match(/prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\)\{([^}]*)\}\}/)],
  ["dark (chosen)", page.match(/:root\[data-theme="dark"\]\{([^}]*)\}/)],
];
const tokens = (body) => Object.fromEntries([...body.matchAll(/--([a-z-]+):(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));

for (const [name, m] of rules) {
  test(`${name}: muted text is at least 4.5:1 on every surface`, () => {
    assert.ok(m, `the ${name} token rule is in the page`);
    const t = tokens(m[1]);
    for (const s of SURFACES) {
      assert.ok(t[s], `${name} has --${s}`);
      const r = ratio(t.muted, t[s]);
      assert.ok(r >= 4.5, `--muted ${t.muted} on --${s} ${t[s]} is ${r.toFixed(2)}:1 in ${name}, under 4.5:1`);
    }
  });
}

test("the viewer's buttons are 44 px tall on a phone, and the bar wraps so Prev, Next, −, + and Close fit 375 px", () => {
  const phone = [...page.matchAll(/@media \(max-width:760px\)\{([^\n]*)\}\n/g)].map((m) => m[1]).find((b) => b.includes(".lb-bar button"));
  assert.ok(phone, "a phone rule for .lb-bar button");
  assert.match(phone, /\.lb-bar button\{[^}]*min-height:44px/);
  assert.match(phone, /\.lb-bar\{flex-wrap:wrap\}/);
  assert.match(phone, /\.lb-btns\{[^}]*flex-wrap:wrap/);
  for (const id of ["lb-prev", "lb-next", "lb-out", "lb-in", "lb-close"]) assert.match(page, new RegExp(`<button type="button" id="${id}"`), `${id} is a button of the viewer's bar`);
  // The five buttons sit in one .lb-bar, so the rule above reaches every one of them.
  assert.equal([...page.matchAll(/<div class="lb-bar">/g)].length, 1);
});

// Designer's F1 and F2 on 8542956f: the small lines under a step and a wait were dimmed by opacity (3.37 to 4.38:1 in light mode), and the solid text of a
// done step, a queued step and a wait was 4.33:1 in light mode. The dimming is gone and the ink tokens are used; each text/ground pair is checked in all three rules.
const rule = (sel) => { const m = page.match(new RegExp(`^${sel.replace(/[.]/g, "\\.")}\\{([^}\\n]*)\\}`, "m")); assert.ok(m, `rule ${sel}`); return m[1]; };
const tok = (body, name) => { const m = body.match(new RegExp(`(?:^|;)${name}:var\\(--([a-z-]+)\\)`)); assert.ok(m, `${name} in ${body}`); return m[1]; };
test("no opacity dims the small lines under a step or a wait", () => {
  for (const sel of [".wait small", ".step small.since"]) assert.doesNotMatch(rule(sel), /opacity/, sel);
  assert.doesNotMatch(page.match(/^\.step small\{[^}]*\}/m)[0], /opacity/, ".step small");
});
const PAIRS = [[".step.done", "color", "background"], [".step.now.queued", "color", "background"], [".wait", "color", "background"]];
for (const [name, m] of rules) {
  test(`${name}: a done step, a queued step and a wait have text at 4.5:1 or more on their ground`, () => {
    const t = tokens(m[1]);
    for (const [sel, fg, bg] of PAIRS) {
      const body = rule(sel), a = tok(body, fg), b = tok(body, bg);
      const r = ratio(t[a], t[b]);
      assert.ok(r >= 4.5, `${sel}: --${a} ${t[a]} on --${b} ${t[b]} is ${r.toFixed(2)}:1 in ${name}`);
    }
  });
}
