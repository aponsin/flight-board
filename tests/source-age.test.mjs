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

test("the grey is a fill, never a dimming (the page's own rule: dimmed text fails contrast)", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  const css = html.match(/\.evidence\.old\{[^}]*\}/)[0];
  assert.match(css, /background:var\(--line\)/);
  assert.doesNotMatch(css, /opacity/);
});
