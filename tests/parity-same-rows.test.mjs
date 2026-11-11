// #C883 (Director's prevention, 2026-11-10): "same" in docs/PARITY.md was a sentence. Row 78 ("who · time on each tile") was marked same while the
// feed always sent times: {}. Now every row marked "same" names the test(s) that find it from store data (tests/fixtures/parity-tests.json), each
// named test must exist in its file, and a row that names a derived/all.<key> as its source needs that key filled in the feed a store fixture gives.
// A row with no such test is "untested" (docs/PARITY.md), not "same". Keep to the text of the Item cell, as written.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { derivedDoc } from "../worker/compat-view.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const parity = readFileSync(join(ROOT, "docs", "PARITY.md"), "utf8");
const { rows: registry } = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "parity-tests.json"), "utf8"));

// Table rows: | Item | Status | Where it comes from |
const table = parity.split("\n").map((l, i) => ({ l, line: i + 1 })).filter(({ l }) => l.startsWith("|") && !/^\|[-\s|]+\|?$/.test(l))
  .map(({ l, line }) => { const c = l.split("|").map((s) => s.trim()); return { line, item: c[1], status: c[2] ?? "", source: c[3] ?? "" }; })
  .filter((r) => r.item && r.item !== "Item" && r.status);
const same = table.filter((r) => /^same\b/.test(r.status));

const esc = (s) => s.replace(/"/g, '\\"');
// The named test's body: from its test( line to the next test( at the start of a line. null when it is not in the file.
const bodyOf = (file, title) => {
  let src;
  try { src = readFileSync(join(ROOT, "tests", file), "utf8"); } catch { return null; }
  const lines = src.split("\n");
  const i = lines.findIndex((l) => /\btest\(/.test(l) && (l.includes(title) || l.includes(esc(title))));
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && !/^test\(/.test(lines[j])) j++;
  return lines.slice(i, j).join("\n");
};
// A test that draws the page runs the page's own script (render / draw / drawPage / renderAll / loadNames / loadBoard) or builds the served page (storePage).
const DRAWS = /\b(render|draw|drawPage|renderAll|loadNames|loadBoard|renderWaitingHtml|storePage)\(/;
const inSource = (body, find) => body.includes(find) || body.includes(esc(find));

test("PARITY.md has rows marked same, and the table is read (the check is not vacuous)", () => {
  assert.ok(same.length >= 10, `only ${same.length} same rows read`);
  assert.ok(table.some((r) => /^untested\b/.test(r.status)), "the untested status is in use");
});

test("every row marked same names a test that exists, draws the page, and asserts the row's text", () => {
  const bad = [];
  for (const r of same) {
    const e = registry[r.item];
    if (!e || typeof e.test !== "string" || typeof e.find !== "string" || !e.find.trim()) { bad.push(`line ${r.line} "${r.item}": marked same, no {test, find} in tests/fixtures/parity-tests.json (mark it untested, or add the test)`); continue; }
    const [file, title] = e.test.split("::");
    const body = file && title ? bodyOf(file, title) : null;
    if (body === null) bad.push(`line ${r.line} "${r.item}": no test "${title}" in tests/${file}`);
    else if (!DRAWS.test(body)) bad.push(`line ${r.line} "${r.item}": the test "${title}" does not draw the page (a title is a sentence: it must draw it from store data)`);
    else if (!inSource(body, e.find)) bad.push(`line ${r.line} "${r.item}": the test "${title}" does not assert "${e.find}"`);
  }
  assert.deepEqual(bad, []);
});

test("the guard itself: a test that does not draw the page, or lacks its find text, is caught", () => {
  // Checker F1 on bcd8723: these were named as proof and drew nothing of the row.
  const light = bodyOf("store-page.test.mjs", "the store page loads nothing from another site and runs no inline handler: one script tag, by nonce");
  assert.ok(light && !DRAWS.test(light) && !inSource(light, "lightbox"), "the lightbox row's old test draws no page and has no lightbox text");
  const ideas = bodyOf("compat-view.test.mjs", "to-do and idea rows land in their own collections, with the done flag");
  assert.ok(ideas && !DRAWS.test(ideas), "the ideas row's old test is a collections test");
  assert.equal(bodyOf("compat-view.test.mjs", "a title that no test has"), null);
});

test("an entry in the registry belongs to a row marked same (a row marked untested or gone, or renamed, drops its entry)", () => {
  const sameItems = new Set(same.map((r) => r.item));
  assert.deepEqual(Object.keys(registry).filter((k) => !sameItems.has(k)), []);
});

// The named source is not always empty in the feed: a store fixture with a card, a probe reading and a live version fills derived/all.
const view = {
  now: 1_800_000_000_000, live: { state: "live", version: "1.2.3", age: 1000 },
  cards: [{ id: "c1-one", num: 1, title: "One", owner_role: "Builder", repo: "", dropped: 0 }], asks: [],
  evidence: { "cards.c1-one": { value: { phase: "build", lit: ["build", "test"], headSha12: "abc123def456" }, readAt: 1_800_000_000_000 - 1000 } },
};
test("a row that names derived/all.<key> as its source has that key filled in the feed a store fixture gives", () => {
  const doc = derivedDoc(view);
  const empty = [];
  for (const r of same) {
    for (const m of r.source.matchAll(/derived\/all\.([a-zA-Z]+)/g)) {
      const v = doc[m[1]];
      const filled = v && (typeof v !== "object" || Object.keys(v).length > 0);
      if (!filled) empty.push(`line ${r.line} "${r.item}": derived/all.${m[1]} is empty in the feed`);
    }
  }
  assert.deepEqual(empty, []);
});
