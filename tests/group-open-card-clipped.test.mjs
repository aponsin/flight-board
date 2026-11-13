// #C1052 (the owner's screenshot, 11-12: #C1051 opened inside a group): the opened card's panel had no left padding, so its first letters sat
// under its own red 4px edge (.i-row.gap-red's inset shadow) right on the group's rail. The opened card keeps a padding on every side wider than
// that edge, at phone and laptop width alike (one rule, no media query overrides it).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const css = page.match(/<style>([\s\S]*?)<\/style>/)[1];
const px = (v) => Number(String(v).replace(/px$/, ""));

test("an opened card in a group has a left padding wider than the red edge, and padding on every side", () => {
  const rules = [...css.matchAll(/(?:^|\n|\})\.g-card>details>\.i-row\{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(rules.length, 1, "one rule for the opened card, nowhere overridden");
  const pad = rules[0].match(/(?:^|;)padding:([^;]+)/);
  assert.ok(pad, "it sets its padding");
  const [top, right, bottom, left] = (([a, b = a, c = a, d = b]) => [a, b, c, d])(pad[1].trim().split(/\s+/).map(px));
  const edge = px(css.match(/\.i-row\.gap-red\{[^}]*box-shadow:inset (\d+px)/)[1]);
  assert.ok(left >= edge + 8, `left ${left}px clears the ${edge}px red edge with room`);
  for (const [k, v] of Object.entries({ top, right, bottom })) assert.ok(v >= 8, `${k} ${v}px`);
});

test("no phone rule takes the opened card's padding away", () => {
  for (const m of css.matchAll(/@media[^{]*\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)) assert.doesNotMatch(m[1], /\.g-card>details>\.i-row\{[^}]*padding/, m[0].slice(0, 60));
});
