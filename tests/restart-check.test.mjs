// Is it safe to restart the agents now? (#C505: both of 2026-10-30's install restarts stopped Release mid-ship.)
// scripts/restart-check.mjs asks the machine; the page's "Don't restart: shipping" line asks the board.
import test from "node:test";
import assert from "node:assert/strict";
import { elapsedMs, shipRuns, runVersion, liveShip, verdict, LIVE_FRESH } from "../scripts/restart-check.mjs";
import { loadNames } from "./harness.mjs";

const NOW = 1_800_000_000_000;
const PS = `  101 01:02:03 /usr/bin/zsh
  202 12:34 node scripts/ship.mjs build/x@130ce07 --bump patch
  303 00:05 node scripts/ship.mjs build/y@abc1234 --dry-run
  404 1-00:00:10 vim scripts/ship.mjs
  505 00:07 node /Users/me/team/scripts/ship.mjs --resume
  606 00:09 node scripts/ship.mjs.bak`;

test("ps's elapsed times read as ms", () => {
  assert.equal(elapsedMs("12:34"), (12 * 60 + 34) * 1e3);
  assert.equal(elapsedMs("01:02:03"), ((1 * 60 + 2) * 60 + 3) * 1e3);
  assert.equal(elapsedMs("2-03:04:05"), (((2 * 24 + 3) * 60 + 4) * 60 + 5) * 1e3);
  assert.equal(elapsedMs("soon"), null);
});

test("a ship run is a node process running ship.mjs, a resume included; never a dry run, an editor or another file", () => {
  const runs = shipRuns(PS, NOW);
  assert.deepEqual(runs.map((r) => r.pid), [202, 505]);
  assert.equal(runs[0].startedAt, NOW - (12 * 60 + 34) * 1e3);
});

test("the run's version is the newest candidate made since it started; an older one left on GitHub never names it", () => {
  const re = /^build\/ship-v/, start = NOW - 10 * 60e3;
  const old = { branch: "build/ship-v1.168.10", at: NOW - 40 * 60e3 };
  assert.equal(runVersion([old], start, re), null);
  assert.equal(runVersion([old, { branch: "build/ship-v1.169.0", at: NOW - 2 * 60e3 }, { branch: "build/ship-v1.169.0-2", at: NOW - 60e3 }], start, re), "1.169.0");
  assert.equal(runVersion([{ branch: "build/other", at: NOW }], start, re), null);
});

const state = (agent, phase = "ship", at = NOW - 30e3) => ({ board: { at }, agents: { Release: agent }, cards: { "c-1": { num: 499, phase } } });
test("the live state: the ship role working on a ship-phase card, only while fresh", () => {
  const working = { state: "working", card: "c-1", since: NOW - 5 * 60e3 };
  assert.deepEqual(liveShip(state(working), { now: NOW, shipPhase: "ship" }), { card: "c-1", num: 499, since: NOW - 5 * 60e3 });
  assert.equal(liveShip(state({ ...working, state: "idle" }), { now: NOW, shipPhase: "ship" }), null, "idle");
  assert.equal(liveShip(state(working, "checker"), { now: NOW, shipPhase: "ship" }), null, "a card still in review");
  assert.equal(liveShip(state(working, "ship", NOW - LIVE_FRESH - 1), { now: NOW, shipPhase: "ship" }), null, "a stale reading");
  assert.equal(liveShip(null, { now: NOW, shipPhase: "ship" }), null);
});

test("the verdict: wait while a run lives (with its version and card), wait while the live state shows one, else ok", () => {
  const run = verdict({ runs: [{ pid: 1, startedAt: NOW - 60e3 }], live: { card: "c-1", num: 499, since: null }, version: "1.169.0", now: NOW });
  assert.equal(run.ok, false);
  assert.match(run.line, /^wait: Release is shipping v1\.169\.0 \(since \d\d:\d\d, #C499\): restart once it ends\.$/);
  const bare = verdict({ runs: [{ pid: 1, startedAt: null }], live: null, version: null, now: NOW });
  assert.equal(bare.line, "wait: Release is shipping: restart once it ends.");
  const live = verdict({ runs: [], live: { card: "c-1", num: 499, since: null }, version: null, now: NOW });
  assert.equal(live.ok, false);
  assert.equal(live.line, "wait: Release is working on #C499, which is ready to ship: restart once Release is idle.");
  assert.deepEqual(verdict({ runs: [], live: null, version: null, now: NOW }), { ok: true, line: "ok: no ship running; restart now." });
});

// The page's line.
function board({ live = null, derived = {}, open = ["c-1", "c-2"] } = {}) {
  const b = loadNames(["shipNow", "renderShipLine", "probeEvent"]);
  b.state.initRaw = open.map((id, k) => ({ id, num: 499 + k, status: "active" }));
  b.state.derived = [{ id: "all", cards: derived }];
  if (live) b.probeEvent({ type: "data", result: { payload: live } });
  return b;
}
const liveOf = (agent, phase = "ship") => ({ v: 1, board: { at: Date.now() - 20e3 }, cards: { "c-1": { phase, headSha12: "a1b2c3d4e5f6" } }, agents: { Release: agent } });

test("the board says Don't restart while Release works on a ship-phase card, by the live state", () => {
  const b = board({ live: liveOf({ state: "working", card: "c-1", since: Date.now() - 60e3 }) });
  assert.equal(JSON.stringify(b.shipNow()), JSON.stringify({ id: "c-1", version: null }));
  b.renderShipLine();
  assert.equal(b.els.shipline.hidden, false);
  assert.match(b.els.shipline.innerHTML, /Don't restart: shipping\.<\/b> Release is shipping \(#C499\)/);
});

test("or while the Collector reads an open card as shipping now, with its version", () => {
  const b = board({ derived: { "c-2": { phase: "ship", shipping: true, expected: { version: "1.169.0", shipping: true } } } });
  assert.equal(JSON.stringify(b.shipNow()), JSON.stringify({ id: "c-2", version: "1.169.0" }));
  b.renderShipLine();
  assert.match(b.els.shipline.innerHTML, /shipping <b>v1\.169\.0<\/b> \(#C500\)/);
});

test("a whole redraw draws the line", () => {
  const b = loadNames(["renderAll", "probeEvent"]);
  b.state.initRaw = [{ id: "c-1", num: 499, status: "active" }];
  b.probeEvent({ type: "data", result: { payload: liveOf({ state: "working", card: "c-1", since: Date.now() - 60e3 }) } });
  b.renderAll();
  assert.equal(b.els.shipline.hidden, false);
  assert.match(b.els.shipline.innerHTML, /Don't restart: shipping/);
});

test("no line when Release is idle, works on a card in review, or a shipping card is closed", () => {
  for (const b of [
    board({ live: liveOf({ state: "idle", card: "c-1" }) }),
    board({ live: liveOf({ state: "working", card: "c-1" }, "checker") }),
    board({ derived: { "c-9": { phase: "ship", shipping: true } } }),
  ]) {
    assert.equal(b.shipNow(), null);
    b.renderShipLine();
    assert.equal(b.els.shipline.hidden, true);
  }
});
