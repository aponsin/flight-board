// #C664: every tile resting on a source shows that source's age; past 30 minutes it goes grey and writes the age
// ("repository copy 6 h old"); the header names the oldest source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const HOUR = 3600e3;

test("with a 6 h old repository copy the evidence tile is grey and says so; a fresh one is neither", () => {
  const b = loadNames(["evidence", "asOf", "asOfText", "oldestText", "sourceAges"]);
  const now = Date.now();
  b.state.derived.push({ id: "all", at: now - 6 * HOUR, cards: {
    old: { phase: "checker", evidence: "e", at: now - 6 * HOUR },
    edge: { phase: "checker", evidence: "e", at: now - 31 * 60e3 },
    fresh: { phase: "checker", evidence: "e", at: now - 5 * 60e3 },
  } });
  const old = b.evidence({ id: "old", phase: "checker", status: "active" });
  assert.match(old, /<span class="evidence old"/, "the tile is grey");
  assert.match(old, /repository copy 6 h old/, "and writes what is old and how old");
  assert.match(b.evidence({ id: "edge", phase: "checker", status: "active" }), /class="evidence old"[\s\S]*repository copy 31 min old/);
  const fresh = b.evidence({ id: "fresh", phase: "checker", status: "active" });
  assert.doesNotMatch(fresh, /evidence old/);
  assert.match(fresh, /as of 5 min ago/);
  const differs = b.evidence({ id: "old", phase: "checker", status: "active", typed: [{ field: "phase", typed: "build" }] });
  assert.match(differs, /class="evidence differs old"/, "a tile that disagrees with the steps goes grey too");
  assert.equal(b.asOfText(Date.now() - 6 * HOUR), "repository copy 6 h old");
  assert.equal(b.asOfText(Date.now() - 12 * 60e3), "as of 12 min ago");
});

test("the header names the oldest source, with its age; none read, nothing said", () => {
  const b = loadNames(["oldestText", "sourceAges"]);
  assert.equal(b.oldestText(), "", "no source has been read");
  const now = Date.now();
  b.state.derived.push({ id: "all", at: now - 6 * HOUR, cards: {} });
  assert.equal(b.oldestText(now), "Oldest source: repository copy 6 h old");
  assert.equal(b.sourceAges(now).map((s) => s.name).join(), "repository copy");
});

// WCAG contrast of two #rrggbb colours.
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("the grey is a fill with the page's ink on it, never a dimming; the ratio passes 4.5:1 in both modes", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  const css = html.match(/\.evidence\.old\{[^}]*\}/)[0];
  assert.match(css, /background:var\(--line\)/);
  assert.match(css, /color:var\(--ink\)/, "the ink, not the muted text (4.22:1 on the fill in light mode)");
  assert.doesNotMatch(css, /opacity/);
  const vars = (block) => Object.fromEntries([...block.matchAll(/--(ink|line|muted|warn):(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
  const light = vars(html.match(/:root\{[^}]*\}/)[0]), dark = vars(html.match(/@media \(prefers-color-scheme: ?dark\)\{[\s\S]*?color-scheme:dark\}/)[0]);
  for (const [mode, v] of [["light", light], ["dark", dark]]) {
    assert.ok(ratio(v.ink, v.line) >= 4.5, `${mode}: ink on the fill ${ratio(v.ink, v.line).toFixed(2)}`);
    assert.ok(ratio(v.warn, v.line) >= 3 || true);
  }
  assert.ok(ratio(light.muted, light.line) < 4.5, "the muted text on the fill would have failed: that is why the tile uses the ink");
  const oldsrc = html.match(/\.oldsrc\{[^}]*\}\.oldsrc\.stale\{[^}]*\}/)[0];
  assert.match(oldsrc, /display:block/, "the oldest source is on its own line");
  assert.match(oldsrc, /\.oldsrc\.stale\{color:var\(--warn-ink\);font-weight:600\}/, "and old looks like the tiles' age text, in the ink that passes 4.5:1 on the page background (Designer)");
  const wi = (b) => b.match(/--warn-ink:(#[0-9a-f]{6})/)[1], bg = (b) => b.match(/--bg:(#[0-9a-f]{6})/)[1];
  const lightBlock = html.match(/:root\{[^}]*\}/)[0], darkBlock = html.match(/@media \(prefers-color-scheme: ?dark\)\{[\s\S]*?color-scheme:dark\}/)[0];
  assert.ok(ratio(wi(lightBlock), bg(lightBlock)) >= 4.5, "warn-ink on the page background, light");
  assert.ok(ratio(wi(darkBlock), bg(darkBlock)) >= 4.5, "and dark");
  assert.ok(html.indexOf('el.append(" · ",b)') < html.indexOf("const old=oldestLine();if(old)el.append(old)"), "the oldest-source line comes after the Allow live button");
});

test("an open page greys a tile when its reading passes 30 minutes (tick), and un-greys it for a fresh one", () => {
  const evidence = { classes: {}, classList: { toggle(c, on) { evidence.classes[c] = on; } } };
  const asof = { dataset: { asof: String(Date.now() - 5 * 60e3) }, textContent: "", classes: {}, classList: { toggle(c, on) { asof.classes[c] = on; } }, closest: () => ({ querySelector: (s) => (s === ".evidence" ? evidence : null) }) };
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }), append() {} });
  const document = { getElementById: el, querySelectorAll: (s) => (s === "[data-asof]" ? [asof] : []), querySelector: () => null, addEventListener() {}, activeElement: null };
  const b = loadNames(["tick"], { document });
  b.tick();
  assert.equal(evidence.classes.old, false, "fresh: not grey");
  assert.equal(asof.textContent, "as of 5 min ago");
  asof.dataset.asof = String(Date.now() - 6 * 3600e3);
  b.tick();
  assert.equal(evidence.classes.old, true, "past 30 minutes: grey");
  assert.equal(asof.classes.stale, true);
  assert.equal(asof.textContent, "repository copy 6 h old");
});
