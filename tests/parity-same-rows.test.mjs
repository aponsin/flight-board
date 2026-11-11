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
const hasTest = (file, title) => {
  let src;
  try { src = readFileSync(join(ROOT, "tests", file), "utf8"); } catch { return false; }
  return src.split("\n").some((l) => /\btest\(/.test(l) && (l.includes(title) || l.includes(esc(title))));
};

test("PARITY.md has rows marked same, and the table is read (the check is not vacuous)", () => {
  assert.ok(same.length >= 20, `only ${same.length} same rows read`);
  assert.ok(table.some((r) => /^untested\b/.test(r.status)), "the untested status is in use");
});

test("every row marked same names a test that exists", () => {
  const bad = [];
  for (const r of same) {
    const named = registry[r.item];
    if (!Array.isArray(named) || !named.length) { bad.push(`line ${r.line} "${r.item}": marked same, no test named in tests/fixtures/parity-tests.json (mark it untested, or add the test)`); continue; }
    for (const t of named) {
      const [file, title] = t.split("::");
      if (!file || !title || !hasTest(file, title)) bad.push(`line ${r.line} "${r.item}": no test "${title}" in tests/${file}`);
    }
  }
  assert.deepEqual(bad, []);
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
