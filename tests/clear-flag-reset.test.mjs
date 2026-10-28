// A "/clear me" flag goes away once the agent has reset (#C374, the owner in #T991). The keeper sets meta/context
// agents.<Role>.saved = true and nothing clears it, so after the agent cleared itself its tile kept "/clear me" over a
// fresh, low reading (Manager deleted 8 such flags by hand on 2026-10-28). A save is only ever asked for high up (the
// keeper at 60%, the reset cue over 200k tokens), so a flag beside a green reading (under 100k tokens, or under 40%
// with no count) is from before the reset: the page no longer shows it, nor counts it in "N to clear".
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const b = loadNames(["ctxTileHtml", "ctxAgents", "crewHtml", "renderCtx", "clearMe"]);
const now = Date.now(), MIN = 60e3;
// Tonight's shape: the Collector's fresh reading merged beside the keeper's old flag.
const stale = { pct: 9, tokens: 88337, at: now - 5 * MIN, saved: true };
const live = { pct: 31, tokens: 312000, at: now - 5 * MIN, saved: true };

test("a saved flag beside a green reading is stale: no /clear me, no dashed tile", () => {
  assert.equal(b.clearMe(stale), false);
  const t = b.ctxTileHtml("Reviewer", stale, null, now);
  assert.doesNotMatch(t, /\/clear me|saved|ready to clear/);
  assert.match(t, /^<div class="ctx-t g"/);
});

test("a saved flag on a session still over 100k (or 40% with no count) still asks for its clear", () => {
  assert.equal(b.clearMe(live), true);
  assert.match(b.ctxTileHtml("Checker", live, null, now), /^<div class="ctx-t r saved"[\s\S]*\/clear me/);
  assert.equal(b.clearMe({ pct: 62, at: now, saved: true }), true, "an older reading in percent, high");
  assert.equal(b.clearMe({ pct: 12, at: now, saved: true }), false, "and low");
  assert.equal(b.clearMe({ pct: 31, tokens: 99999, at: now, saved: true }), false, "99,999 is green");
  assert.equal(b.clearMe({ pct: 31, tokens: 100000, at: now, saved: true }), true);
  assert.equal(b.clearMe({ pct: 80, tokens: 400000, at: now }), false, "no flag, nothing to clear");
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
