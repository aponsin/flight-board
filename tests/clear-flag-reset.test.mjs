// A "/clear me" flag goes away once the agent has reset (#C374, the owner in #T991). The keeper sets meta/context
// agents.<Role>.saved = true and nothing clears it, so after the agent cleared itself its tile kept "/clear me" over a
// fresh, low reading (Manager deleted 8 such flags by hand on 2026-10-28). Hiding it only beside a green reading wasn't
// enough (Checker's MEDIUM on 93b4c08): once the agent worked past 100k again the old flag came back, with no new save.
// Now the keeper writes the count it saw at the save (savedTokens, or savedPct for a reading in percent), and the flag
// stands only while the reading is still at or above it: a session's context only shrinks when it resets. A flag
// without that count is from before this rule, and isn't shown.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const b = loadNames(["ctxTileHtml", "ctxAgents", "crewHtml", "renderCtx", "clearMe"]);
const now = Date.now(), MIN = 60e3;
const saved = { saved: true, savedTokens: 312000, savedPct: 31 };
// Waiting for its clear: the reading is still the one the keeper saw, or a little more (the agent's last notes).
const live = { pct: 31, tokens: 312000, at: now - 5 * MIN, ...saved };
// Reset since: the Collector's fresh reading beside the keeper's flag.
const stale = { pct: 9, tokens: 88337, at: now - 5 * MIN, ...saved };

test("a saved flag beside a lower reading is from before a reset: no /clear me, no dashed tile", () => {
  assert.equal(b.clearMe(stale), false);
  const t = b.ctxTileHtml("Reviewer", stale, null, now);
  assert.doesNotMatch(t, /\/clear me|saved|ready to clear/);
  assert.match(t, /^<div class="ctx-t g"/);
});

test("Checker's case: the old flag, a green reading, then 130k: still no /clear me", () => {
  assert.equal(b.clearMe({ ...stale, tokens: 130000, pct: 13 }), false, "amber again, no new save");
  assert.equal(b.clearMe({ ...stale, tokens: 250000, pct: 25 }), false, "red again, still under the save's count");
  assert.doesNotMatch(b.ctxTileHtml("Reviewer", { ...stale, tokens: 130000, pct: 13 }, null, now), /\/clear me|saved/);
});

test("a saved flag while the reading is still at or above the save's count asks for its clear", () => {
  assert.equal(b.clearMe(live), true);
  assert.match(b.ctxTileHtml("Checker", live, null, now), /^<div class="ctx-t g saved"[\s\S]*\/clear me/, "31% of its window: green since #C384, the flag all the same");
  assert.equal(b.clearMe({ ...live, tokens: 318500 }), true, "a little more: its last notes");
  assert.equal(b.clearMe({ ...live, tokens: 311999 }), false, "less: it reset");
  assert.equal(b.clearMe({ pct: 62, at: now, saved: true, savedPct: 60 }), true, "a reading in percent, at or over the save's");
  assert.equal(b.clearMe({ pct: 12, at: now, saved: true, savedPct: 60 }), false, "and under it");
  assert.equal(b.clearMe({ pct: 80, tokens: 400000, at: now }), false, "no flag, nothing to clear");
});

test("a flag without the save's count is from before this rule: not shown, however high the reading", () => {
  assert.equal(b.clearMe({ pct: 40, tokens: 400000, at: now, saved: true }), false);
  assert.equal(b.clearMe({ pct: 82, at: now, saved: true }), false);
  assert.equal(b.clearMe({ pct: 82, at: now, saved: true, savedTokens: 300000 }), false, "a count to compare with a reading in percent: no");
});

test("'N to clear' and Crew count only the live flags", () => {
  Object.assign(b.state, { plan: [], ideas: [], threads: [], waiting: [], derived: [], initiatives: [], ctx: [],
    meta: [{ id: "context", at: now - 5 * MIN, agents: { Reviewer: stale, Checker: live } }] });
  b.renderCtx();
  assert.equal(b.els.ctxnote.textContent, "1 to clear: Checker");
  const crew = b.crewHtml(now);
  assert.match(crew, /data-agent="Checker">[\s\S]*?\/clear me/);
  assert.doesNotMatch(crew, /data-agent="Reviewer">(?:(?!data-agent=)[\s\S])*\/clear me/, "Reviewer's tile has none");
});

test("a fresher ctx reading keeps the keeper's save count beside it", () => {
  Object.assign(b.state, { ctx: [{ id: "Checker", pct: 9, tokens: 90000, at: now - MIN }],
    meta: [{ id: "context", at: now - 5 * MIN, agents: { Checker: live } }] });
  const a = b.ctxAgents(now);
  assert.equal(a.Checker.savedTokens, 312000);
  assert.equal(b.clearMe(a.Checker), false, "Checker reset since the save");
});
