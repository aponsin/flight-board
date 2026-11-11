// #C876 (audit 2026-11-10 group C, rows 26/29/34/35; the owner: 15 blue tiles while every agent was idle): a tile is blue (the pulsing
// "now") only when the probe sees an agent on that card; a paused card is never blue; a landed card waits on the owner's install;
// "stuck" is twice the phase's usual time; the tile's hover names its evidence; Started is the first push, not created_at.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, step } from "./harness.mjs";

const NOW = Date.now(), MIN = 60e3, H = 36e5, ID = "rev-card";
const reading = (agent) => ({
  v: 1, board: { boardId: "TestBoard42xyz", at: NOW - 12e3, probe: null, pageVersion: null },
  cards: { [ID]: { num: 448, phase: "build", headSha12: "a1b2c3d4e5f6", signed: [], onMain: false, ci: "passed", ciMin: 4, liveVersion: null, at: NOW - 12e3 } },
  agents: { Builder: { state: agent, lastActivityAt: NOW - 12e3, tool: "Read", card: ID, since: NOW - 5 * MIN } },
});
const base = { id: ID, num: 448, name: "Our work editor", status: "active", phase: "build", size: "S", level: "Full", who: "Builder", createdAt: NOW - 5 * H, nextNote: "x", nextNoteAt: NOW };
function board(card, { probe = null, derived = {}, steps = [step(ID, "build", "Builder", "start", NOW - 2 * H)], done = [] } = {}) {
  const b = loadNames(["enrich", "gates", "initRow", "probeEvent", "phaseMedians", "CONFIG"]);
  b.CONFIG.collector = { notes: { language: "refs/notes/linguist", checker: "refs/notes/checker", security: "refs/notes/security" } };
  Object.assign(b.state, {
    initRaw: [card], steps, waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [], checkRequests: [],
    derived: [{ id: "all", at: NOW - 50 * MIN, cards: { [ID]: { phase: "build", at: NOW - 50 * MIN, ...derived } } }],
  });
  if (probe) b.probeEvent({ type: "data", result: { payload: probe } }, {});
  b.state.initiatives = [...done, b.gates(b.enrich(card))];
  b.state.phaseMed = b.phaseMedians(b.state.initiatives);
  return b;
}
const html = (b) => b.initRow(b.state.initiatives[b.state.initiatives.length - 1]);
// The tile of a phase: { cls, title }.
const tile = (h, label) => { const m = h.match(new RegExp(`<div class="(step[^"]*)" title="(${label}[^"]*)"`)); return m && { cls: m[1], title: m[2] }; };

test("an idle agent's card is not blue; a working agent's is", () => {
  const idle = html(board(base, { probe: reading("idle") })), t = tile(idle, "Build");
  assert.ok(t, "the Build tile is drawn");
  assert.doesNotMatch(t.cls, /\bnow\b/, "nobody working: no pulsing tile");
  assert.match(t.title, /evidence: the probe sees no agent on it/, "the hover names the evidence");
  const work = tile(html(board(base, { probe: reading("working") })), "Build");
  assert.match(work.cls, /\bnow\b/);
  assert.match(work.title, /evidence: the probe sees Builder working on it/);
});

test("a landed card that is not deployed reads the install wait, not blue", () => {
  const p = reading("idle");
  p.cards[ID] = { ...p.cards[ID], phase: "ship", onMain: true };
  const h = html(board({ ...base, phase: "ship" }, { probe: p, derived: { wait: "install", waitAsk: 77 } })), t = tile(h, "Ship");
  assert.doesNotMatch(t.cls, /\bnow\b/);
  assert.match(h, /Ship<small>waits on the owner&#39;s install<\/small>/);
  assert.match(t.title, /landed on main, not deployed yet/);
  assert.match(h, /Waiting for install: #T77/, "the status word too");
});

test("a paused card is never blue, whatever the probe or the steps say", () => {
  const p = { ...reading("idle"), cards: {} }, paused = { ...base, status: "paused", phase: "checker" };
  const h = html(board(paused, { probe: p, steps: [], derived: { phase: "checker" } }));
  assert.match(h, /<span class="state paused">Paused<\/span>/, "the status word too, not Queued");
  assert.doesNotMatch(h, /class="step[^"]*\bnow\b/, "no tile of a paused card pulses");
  assert.match(h, /Checker<small>Paused<\/small>/);
  assert.match(tile(h, "Checker").title, /status is paused/);
  const off = html(board(paused, { steps: [], derived: { phase: "checker" } }));
  assert.doesNotMatch(off, /class="step[^"]*\bnow\b/, "nor with no probe reading");
});

test("stuck is twice the phase's usual time", () => {
  const done = (id, ms) => ({ id, status: "done", size: "S", doneAt: NOW - H, phaseLog: [{ phase: "build", start: NOW - 9 * H, end: NOW - 9 * H + ms }] });
  const hist = [done("d1", H), done("d2", H), done("d3", H)];
  const over = (hrs) => tile(html(board(base, { probe: reading("working"), done: hist, steps: [step(ID, "build", "Builder", "start", NOW - hrs * H)] })), "Build");
  assert.doesNotMatch(over(1.5).cls, /stuck/, "1.5 times the usual: not stuck");
  assert.match(over(2.5).cls, /stuck/, "2.5 times the usual: stuck");
});

test("Started is the first push, not created_at", () => {
  const pushed = NOW - 90 * MIN;
  const h = html(board(base, { probe: reading("working"), steps: [step(ID, "build", "Builder", "start", pushed)] }));
  assert.match(h, /Started [^<]* · 1 h 30 min so far/, "counted from the first phase-log entry, not the 5 h old card");
});
