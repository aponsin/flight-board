// Memory tiles in tokens (#C350, the owner's go via Director: context thresholds are in tokens, not percent): a reading
// with tokens shows them ("439k"), coloured against 200k: green under 100k, amber up to 200k, red over; the bar is full
// at 200k. A reading without tokens (older collector) keeps today's percentage and its 40/70 colours.
import test from "node:test";
import assert from "node:assert/strict";
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

test("a tile with tokens: the number, its colour against 200k, a bar full at 200k", () => {
  const now = Date.now(), at = now - 60e3;
  const cls = (tokens) => /^<div class="ctx-t (\w)/.exec(b.ctxTileHtml("Manager", { pct: 5, tokens, at }, null, now))[1];
  assert.deepEqual([0, 99999, 100000, 150000, 200000, 200001, 518048].map(cls), ["g", "g", "a", "a", "a", "r", "r"], "the percentage plays no part");
  const t = b.ctxTileHtml("Manager", { pct: 44, tokens: 439048, at }, null, now);
  assert.match(t, /<span class="nm">Manager<span class="pc">439k<\/span><\/span>/);
  assert.match(t, /<i style="width:100%">/, "over 200k: full");
  assert.match(b.ctxTileHtml("Manager", { pct: 5, tokens: 50000, at }, null, now), /<i style="width:25%">/);
  assert.match(t, /title="Manager: 439k tokens in its context \(red over 200k\), 44% of its window, read 1 min ago"/);
  assert.doesNotMatch(t, /44%<\/span>/, "no percentage on the face");
});

test("a reading without tokens keeps today's tile: the percentage, green under 40%, amber to 69%, red from 70%", () => {
  const now = Date.now(), at = now - 60e3;
  const t = b.ctxTileHtml("Sales", { pct: 52, at }, null, now);
  assert.match(t, /^<div class="ctx-t a"/);
  assert.match(t, /<span class="pc">52%<\/span>/);
  assert.match(t, /<i style="width:52%">/);
  assert.match(t, /title="Sales: 52% of its memory used, read 1 min ago"/);
  for (const tokens of [-1, 4.5, "439048", null]) assert.match(b.ctxTileHtml("Sales", { pct: 52, tokens, at }, null, now), /<span class="pc">52%<\/span>/, `tokens ${JSON.stringify(tokens)}: not a count`);
});

test("the freshest reading carries its tokens, and a fresher one without tokens drops an older count", () => {
  const now = Date.now();
  b.state.meta = [{ id: "context", at: now - 9e5, agents: { Manager: { pct: 40, tokens: 400000, at: now - 9e5 }, Checker: { pct: 20, tokens: 200500, at: now - 9e5 } } }];
  b.state.ctx = [{ id: "Manager", pct: 44, tokens: 439048, at: now - 6e4 }, { id: "Checker", pct: 21, at: now - 6e4 }];
  const a = b.ctxAgents();
  assert.equal(a.Manager.tokens, 439048);
  assert.equal(a.Checker.tokens, undefined, "Checker's newest reading has no count");
  assert.equal(a.Checker.pct, 21);
});

test("Crew's memory line reads the same: tokens with their colour, or the percentage", () => {
  const now = Date.now();
  Object.assign(b.state, {
    plan: [], ideas: [], threads: [], waiting: [], derived: [], initiatives: [],
    meta: [{ id: "context", at: now - 6e4, agents: { Manager: { pct: 44, tokens: 439048, at: now - 6e4 }, Sales: { pct: 52, at: now - 6e4 } } }],
    ctx: [],
  });
  const html = b.crewHtml(now);
  assert.match(html, /data-agent="Manager">[\s\S]*?<div class="crew3-mem r"><span class="pc">Memory 439k<\/span><span class="ctx-bar"><i style="width:100%"><\/i>/);
  assert.match(html, /data-agent="Sales">[\s\S]*?<div class="crew3-mem a"><span class="pc">Memory 52%<\/span><span class="ctx-bar"><i style="width:52%"><\/i>/);
});
