// The Agents' memory list keeps its last good reading when a read comes back without context rows (#C939, the owner:
// the tile said "No check yet" beside a usage reading 0 min old). The store's streams restart empty after an
// install or a resubscribe, so ctx and meta/context are briefly [] and the probe has no ctx: the list was wiped.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const b = loadNames(["ctxTileHtml", "ctxAgents", "renderCtx", "clearMe"]);
const now = Date.now(), MIN = 60e3;
const empty = () => Object.assign(b.state, { ctx: [], meta: [] });
const rows = (agents) => Object.assign(b.state, { ctx: [], meta: [{ id: "context", at: now - 5 * MIN, agents }] });
const shown = () => b.els.ctx.innerHTML;

test("a board that never had a reading says No check yet", () => {
  empty();
  b.renderCtx();
  assert.match(shown(), /No check yet/);
});

test("a read without context rows keeps the last good list, with each tile's own age", () => {
  rows({ Builder: { pct: 31, tokens: 310000, at: now - 5 * MIN }, Checker: { pct: 12, at: now - 3 * 3600e3 } });
  b.renderCtx();
  const good = shown();
  assert.match(good, /Builder/);
  assert.match(good, /Checker/);
  empty();
  b.renderCtx();
  assert.equal(shown(), good, "the same tiles, none wiped");
  assert.doesNotMatch(shown(), /No check yet/);
  empty();
  assert.deepEqual(Object.keys(b.ctxAgents(now)).sort(), ["Builder", "Checker"], "the crew view's memory reads the same list");
});

test("an agent removed from the roster drops off once a read has rows without it", () => {
  rows({ Builder: { pct: 31, at: now - MIN } });
  b.renderCtx();
  assert.match(shown(), /Builder/);
  assert.doesNotMatch(shown(), /Checker/);
  empty();
  b.renderCtx();
  assert.match(shown(), /Builder/, "an empty read after it keeps the new list");
  assert.doesNotMatch(shown(), /Checker/);
});
