// Memory tiles (#C384, the owner's ask: back to percent): each tile shows the percent of that agent's own window,
// green under 40%, amber to 69%, red from 70%, the bar at that percent. The Collector's count (#C350) moves into the
// tooltip ("439k tokens"); it no longer colours the tile.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const b = loadNames(["ctxTileHtml", "ctxAgents", "crewHtml", "ctxLevel", "fmtTokens"]);

test("tokens read as k (or M), cut down, never rounded up past a line", () => {
  assert.equal(b.fmtTokens(439048), "439k");
  assert.equal(b.fmtTokens(99999), "99k", "never '100k' while still green");
  assert.equal(b.fmtTokens(200000), "200k");
  assert.equal(b.fmtTokens(1234567), "1.2M");
  assert.equal(b.fmtTokens(640), "640");
  assert.equal(b.fmtTokens(0), "0");
});

test("a tile shows the percent of its window, coloured 40/70; the count plays no part in the colour", () => {
  const now = Date.now(), at = now - 60e3;
  const cls = (pct) => /^<div class="ctx-t (\w)/.exec(b.ctxTileHtml("Manager", { pct, tokens: 900000, at }, null, now))[1];
  assert.deepEqual([0, 39, 40, 69, 70, 100].map(cls), ["g", "g", "a", "a", "r", "r"]);
  const t = b.ctxTileHtml("Manager", { pct: 44, tokens: 439048, at }, null, now);
  assert.match(t, /<span class="nm">Manager<span class="pc">44%<\/span><\/span>/);
  assert.match(t, /<i style="width:44%">/);
  assert.match(t, /title="Manager: 44% of its window \(439k tokens\), read 1 min ago"/);
  assert.doesNotMatch(t, /439k<\/span>/, "no count on the face");
});

test("a reading without a count: the percentage alone; a bad count is left out", () => {
  const now = Date.now(), at = now - 60e3;
  const t = b.ctxTileHtml("Sales", { pct: 52, at }, null, now);
  assert.match(t, /^<div class="ctx-t a"/);
  assert.match(t, /<span class="pc">52%<\/span>/);
  assert.match(t, /<i style="width:52%">/);
  assert.match(t, /title="Sales: 52% of its window, read 1 min ago"/);
  for (const tokens of [-1, 4.5, "439048", null]) assert.match(b.ctxTileHtml("Sales", { pct: 52, tokens, at }, null, now), /title="Sales: 52% of its window, read/, `tokens ${JSON.stringify(tokens)}: not a count`);
  assert.equal(b.ctxLevel({ tokens: 400000 }), null, "no percentage: no reading to show");
});

test("the freshest reading carries its tokens; a newer one without tokens counts only once the count is over 2 h old", () => {
  const now = Date.now(), H = 3600e3;
  b.state.meta = [{ id: "context", at: now - 9e5, agents: { Manager: { pct: 40, tokens: 400000, at: now - 9e5 }, Checker: { pct: 20, tokens: 200500, at: now - 3 * H } } }];
  b.state.ctx = [{ id: "Manager", pct: 44, tokens: 439048, at: now - 6e4 }, { id: "Checker", pct: 21, at: now - 6e4 }];
  const a = b.ctxAgents(now);
  assert.equal(a.Manager.tokens, 439048);
  assert.equal(a.Checker.tokens, undefined, "Checker's count is 3 h old: its newer percentage shows");
  assert.equal(a.Checker.pct, 21);
});

// Checker's MEDIUM on bcadb2a: agents still write their own ctx/<Role> as {pct, at} (the steps rule, the Refresh wake).
// An agent at 350k of a 1M window says "35%", green, while the Collector's count says 350k, red: the count wins while
// it is under 2 h old, so a self-report never hides it.
test("an agent's own percent-only write after the Collector's count doesn't hide the count", () => {
  const now = Date.now(), MIN = 60e3;
  b.state.meta = [{ id: "context", at: now - 30 * MIN, agents: { Checker: { pct: 35, tokens: 350000, at: now - 30 * MIN, saved: true, savedTokens: 350000 } } }];
  b.state.ctx = [{ id: "Checker", pct: 35, at: now - MIN }];
  const a = b.ctxAgents(now);
  assert.equal(a.Checker.tokens, 350000);
  assert.equal(a.Checker.at, now - 30 * MIN, "the count's own time, so its age shows true");
  assert.equal(a.Checker.saved, true, "the keeper's flag kept");
  assert.match(b.ctxTileHtml("Checker", a.Checker, null, now), /^<div class="ctx-t g saved"[\s\S]*<span class="pc">35%<\/span>/);
  // A newer count from the agent itself (with tokens) still wins.
  b.state.ctx = [{ id: "Checker", pct: 36, tokens: 360000, at: now - MIN }];
  assert.equal(b.ctxAgents(now).Checker.tokens, 360000);
});

test("Crew's memory line reads the same: the percentage and its colour", () => {
  const now = Date.now();
  Object.assign(b.state, {
    plan: [], ideas: [], threads: [], waiting: [], derived: [], initiatives: [],
    meta: [{ id: "context", at: now - 6e4, agents: { Manager: { pct: 44, tokens: 439048, at: now - 6e4 }, Sales: { pct: 52, at: now - 6e4 } } }],
    ctx: [],
  });
  const html = b.crewHtml(now);
  assert.match(html, /data-agent="Manager">[\s\S]*?<div class="crew3-mem a"><span class="pc">Memory 44%<\/span><span class="ctx-bar"><i style="width:44%"><\/i>/);
  assert.match(html, /data-agent="Sales">[\s\S]*?<div class="crew3-mem a"><span class="pc">Memory 52%<\/span><span class="ctx-bar"><i style="width:52%"><\/i>/);
  const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(page, /\.crew3-mem\.g \.pc\{color:var\(--ok\)\}/, "Designer on bcadb2a: green reads green, as amber and red do");
});
