// Is it safe to restart the agents now? (#C505: both of 2026-10-30's install restarts stopped Release mid-ship.)
// scripts/restart-check.mjs asks the machine; the page's "Don't restart: shipping" line asks the board.
import test from "node:test";
import assert from "node:assert/strict";
import { elapsedMs, shipRuns, runVersion, liveShip, verdict, LIVE_FRESH } from "../scripts/restart-check.mjs";
import { readFileSync } from "node:fs";
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
  const odd = verdict({ runs: [], live: { card: "c-1\u001b[2K\rok: no ship running", num: null, since: null }, version: null, now: NOW });
  assert.equal(odd.line, "wait: Release is working on a ship card, which is ready to ship: restart once Release is idle.", "board data with an escape never reaches the terminal");
  assert.match(verdict({ runs: [], live: { card: "work-publish-countdown", num: null, since: null }, version: null, now: NOW }).line, /working on work-publish-countdown,/);
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

// #C613: the pill under the title (placement C). Green Safe to restart, red Not now: <what>, nothing without a fresh reading.
function restartBoard({ agents = {}, cards = { "c-1": { phase: "ship", headSha12: "a1b2c3d4e5f6" } }, derived = {}, fresh = true } = {}) {
  const b = loadNames(["shipNow", "restartState", "renderRestart", "probeEvent"]);
  b.state.initRaw = [{ id: "c-1", num: 499, status: "active" }, { id: "c-2", num: 500, status: "active" }];
  b.state.derived = [{ id: "all", cards: derived }];
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - (fresh ? 20e3 : 20 * 60e3) }, cards, agents } } });
  return b;
}
const bash = (ago, extra = {}) => ({ state: "working", tool: "Bash", lastActivityAt: Date.now() - ago, since: Date.now() - 5 * 60e3, ...extra });
const pill = (b) => { b.renderRestart(); return { hidden: b.els.restartbadge.hidden, cls: b.els.restartbadge.className, text: b.els.restartbadge.textContent }; };

test("Safe to restart when nothing runs: agents idle, between commands (a command over 15 s old off the ship phase), or on another tool", () => {
  assert.deepEqual(pill(restartBoard({ agents: { Release: { state: "idle", card: null, lastActivityAt: Date.now() - 5 * 60e3 } } })), { hidden: false, cls: "rb ok", text: "Safe to restart" });
  const build = { "c-2": { phase: "build", headSha12: "a1b2c3d4e5f6" } };
  assert.equal(pill(restartBoard({ agents: { Builder: bash(20e3, { card: "c-2" }) }, cards: build })).text, "Safe to restart", "a builder's command 20 s ago: between commands");
  assert.equal(pill(restartBoard({ agents: { Builder: bash(5e3, { card: "c-2", tool: "Edit" }) }, cards: build })).text, "Safe to restart", "an edit is not a push");
});

// Checker's finding on 787b376: Builder, Boardsmith and Checker push from the build, test and checker phases.
test("Not now while any agent but the lead runs a command in the last 15 s, in any phase (choice c)", () => {
  const build = { "c-2": { phase: "build", headSha12: "a1b2c3d4e5f6" } };
  assert.deepEqual(pill(restartBoard({ agents: { Builder: bash(10e3, { card: "c-2" }) }, cards: build })), { hidden: false, cls: "rb bad", text: "Not now: Builder is running a command" });
  assert.equal(pill(restartBoard({ agents: { Checker: bash(10e3, { card: null }) } })).text, "Not now: Checker is running a command", "no card needed");
  assert.equal(pill(restartBoard({ agents: { Builder: bash(10e3, { card: "c-2" }), Checker: bash(2e3, { card: "c-2" }) }, cards: build })).text, "Not now: Builder is running a command", "the first by name");
});

test("the pill's tooltip says it is an estimate from each agent's last tool, not the command", () => {
  const b = restartBoard({ agents: { Builder: bash(10e3, { card: "c-1" }) } });
  b.renderRestart();
  assert.match(b.els.restartbadge.title, /estimate from each agent's last tool call.*not from the command/);
});

test("Not now while a ship runs, Release is on a command, or another agent runs one on a ship-phase card", () => {
  assert.equal(pill(restartBoard({ agents: { Release: { state: "working", card: "c-1", since: Date.now() - 60e3 } } })).text, "Not now: Release is shipping");
  assert.equal(pill(restartBoard({ derived: { "c-2": { phase: "ship", shipping: true, expected: { version: "1.169.0", shipping: true } } } })).text, "Not now: Release is shipping v1.169.0");
  const rel = pill(restartBoard({ agents: { Release: bash(10e3, { card: "c-2" }) }, cards: { "c-2": { phase: "live", headSha12: "a1b2c3d4e5f6" } } }));
  assert.deepEqual(rel, { hidden: false, cls: "rb bad", text: "Not now: Release is publishing" });
  assert.equal(pill(restartBoard({ agents: { Builder: bash(10e3, { card: "c-1" }) } })).text, "Not now: Builder is pushing or installing");
});

test("a command more than 45 s old, a non-command tool, or the lead's own command is not a reason", () => {
  assert.equal(pill(restartBoard({ agents: { Builder: bash(60e3, { card: "c-1" }) } })).text, "Safe to restart");
  assert.equal(pill(restartBoard({ agents: { Builder: bash(5e3, { card: "c-1", tool: "Edit" }) } })).text, "Safe to restart");
  assert.equal(pill(restartBoard({ agents: { Manager: bash(5e3, { card: "c-1" }) } })).text, "Safe to restart");
});

test("the pill's text takes the panel colour (readable on the green and the red in both themes) and wraps rather than overflows", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  const rule = html.match(/\n\.rb\{([^}]*)\}/)[1];
  assert.match(rule, /color:var\(--panel\)/);
  assert.match(rule, /max-width:100%/);
  assert.doesNotMatch(rule, /color:#fff/);
});

test("no fresh live reading: no pill (the page never says safe when it can't know)", () => {
  assert.equal(pill(restartBoard({ fresh: false, agents: { Builder: bash(5e3, { card: "c-1" }) } })).hidden, true);
  const b = loadNames(["restartState", "renderRestart"]);
  assert.equal(b.restartState(), null);
});
