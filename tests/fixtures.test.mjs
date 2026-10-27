// Rendered scenarios (#C268): every fixture in tests/fixtures/board, drawn by the page's own script, shows each item
// where and how it expects; today's three faults fail on the page before their fix; a page that fails is never built.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkAll, check, fixtures, times, observe } from "../scripts/fixtures.mjs";
import { buildChecked } from "../scripts/build-page.mjs";
import { fullConfig } from "../scripts/config.mjs";

const template = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");

for (const f of fixtures()) {
  test(`fixture ${f.file}: ${f.name}`, () => {
    assert.deepEqual(check(template, f), []);
  });
}

// The page as it was before the fix: settled was "done", nothing more; a thread was open on any last word of the
// owner's; a closed ask was never drawn with its thread. The three faults are what it drew.
const before = template
  .replace(/function settled\(w\)\{[^\n]*\n[^\n]*\n/, "function settled(w){return !!(w&&w.done)}\n")
  .replace(/function threadOpen\(id\)\{[^\n]*\n[^\n]*\n/, "function threadOpen(id){const t=threadOf(id),last=t[t.length-1];return !!last&&last.from===OWNER&&!last.resolved}\n")
  .replace('it.coll==="waiting"?!settled(it.doc)||threadOpen(id):', 'it.coll==="waiting"?!it.doc.done:');

test("today's three faults fail on the page before their fix, and pass after", () => {
  assert.equal((before.match(/return !!\(w&&w\.done\)\}|return !!last&&last\.from===OWNER&&!last\.resolved\}|"waiting"\?!it\.doc\.done:/g) ?? []).length, 3, "the three old rules stand in for the new ones");
  const faults = fixtures().filter((f) => /^0[123]-fault/.test(f.file));
  assert.equal(faults.length, 3);
  for (const f of faults) {
    assert.notDeepEqual(check(before, f), [], `${f.file} fails before the fix`);
    assert.deepEqual(check(template, f), [], `${f.file} passes after it`);
  }
  assert.match(check(before, faults[1]).join("\n"), /rows: want 1, got 2/, "the second row, \"Reply to: #T855\"");
});

test("a page whose fixtures fail is never built; the team's page is checked with its own config", () => {
  const config = { owner: "Sam", artifactUrl: "https://claude.ai/" + "artifact/TestBoard01" };
  assert.match(buildChecked(template, config), /BOARD_CONFIG/);
  assert.throws(() => buildChecked(before, config), /Not built: \d+ page fixture\(s\) fail[\s\S]*01-fault-ack-with-ok/);
  assert.equal(fullConfig(config).owner, "Sam", "the fixtures' @owner is the page's owner, whoever that is");
});

test("the reader: times relative to now, a button's data-id is no row, a card's phase row", () => {
  assert.deepEqual(times({ a: "now-5m", b: ["now+1h", "now"], c: "nowhere" }, 1_000_000_000), { a: 1_000_000_000 - 300e3, b: [1_000_000_000 + 36e5, 1_000_000_000], c: "nowhere" });
  const drawn = { "needs-you": '<details class="w-item" data-id="x"><summary class="w-row">Ask<span class="t-badge you">waiting on you</span></summary><button data-id="x">Done</button></details>', "waiting-on-manager": "", later: "", resolved: "", board: "", done: "" };
  assert.deepEqual(observe(drawn, "x"), { rows: 1, section: "needs-you", badge: "waiting on you", threadUnder: false, replyRow: false, position: 1, age: null });
  assert.deepEqual(observe(drawn, "y"), { rows: 0, section: "none", badge: null });
});

test("every fixture names what it checks, and every expected key is one the reader knows", () => {
  const keys = new Set(["section", "rows", "badge", "replyRow", "threadUnder", "phase", "status", "version", "gated", "position", "age", "closedAsks"]);
  for (const f of fixtures()) {
    assert.ok(f.name && f.about, f.file);
    for (const want of Object.values(f.expect)) for (const k of Object.keys(want)) assert.ok(keys.has(k), `${f.file}: ${k}`);
  }
  assert.ok(checkAll(template).length >= 6);
});
