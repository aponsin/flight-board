// #C876 (audit 2026-11-10 group C, rows 26/29/34/35; the owner: 15 blue tiles while every agent was idle): a tile is blue (the pulsing
// "now") only when the probe sees an agent on that card; a paused card is never blue; a landed card waits on the owner's install;
// "stuck" is twice the phase's usual time; the tile's hover names its evidence; Started is the first push, not created_at.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, step, readingDoc, setReadings } from "./harness.mjs";

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

// #C1382: the row draws the card's reading and nothing of the probe's evidence: working is blue, a wait is the yellow tile, unknown the plain ring.
const withReading = (card, over, opts = {}) => setReadings(board(card, opts), readingDoc(ID, over));
test("an idle agent's card is not blue; a working agent's is", () => {
  const idle = html(withReading(base, { state: "waiting", wait: "turn", with: "Builder", working: false, why: "at build, with Builder" })), t = tile(idle, "Build");
  assert.ok(t, "the Build tile is drawn");
  assert.doesNotMatch(t.cls, /\bnow\b/, "nobody working: no pulsing tile");
  assert.equal(t.cls, "step waits proc", "the card's place is marked, as the yellow wait tile");
  assert.match(t.title, /at build, with Builder/, "the hover names the reading's why");
  const work = tile(html(withReading(base, { state: "working", wait: null, with: "Builder", working: true, why: "Builder is on it" })), "Build");
  assert.equal(work.cls, "step now");
  assert.match(work.title, /Builder is on it/);
  const none = tile(html(setReadings(board(base))), "Build");
  assert.equal(none.cls, "step here", "no reading served: the plain ring at the card's own phase, never a guess from the evidence");
  const unk = tile(html(withReading(base, { state: "unknown", wait: null, with: null, why: "git could not be read" })), "Build");
  assert.equal(unk.cls, "step here", "unknown is the plain ring");
});

test("a landed card that is not deployed reads its wait, not blue", () => {
  const h = html(withReading({ ...base, phase: "ship" }, { phase: "ship", state: "waiting", wait: "deploy", with: "Release", working: false, why: "landed on main, not deployed yet" })), t = tile(h, "Ship");
  assert.doesNotMatch(t.cls, /\bnow\b/);
  assert.equal(t.cls, "step waits proc", "a deploy wait is the yellow tile");
  assert.match(h, /Ship<small class="rs">Release<span class="sl"> ships<\/span><\/small>/);
  assert.match(t.title, /landed on main, not deployed yet/);
  assert.match(h, /Queued for Release&#39;s ship|Queued for Release's ship/, "the status word too");
  const inst = html(withReading({ ...base, phase: "ship", repo: "Flight-Board" }, { phase: "ship", state: "waiting", wait: "install", with: "Owner", pack: "pc111" }));
  assert.equal(tile(inst, "Land").cls, "step waits rel", "the owner's install is the green tile (a board card's Ship tile is called Land)");
  assert.match(inst, /pc111/, "it names the pack");
  assert.match(inst, /Waiting for install/);
});

// #C1300: green is only the owner's install, and only a board card has one; a reading that said install for a product card would still draw the yellow tile.
test("a product card is never the green tile, even if its reading said install", () => {
  const h = html(withReading({ ...base, phase: "ship", repo: "Platform" }, { phase: "ship", state: "waiting", wait: "install", with: "Owner" })), t = tile(h, "Ship");
  assert.equal(t.cls, "step waits proc");
});

test("a paused card is never blue, whatever the reading or the steps say", () => {
  const paused = { ...base, status: "paused", phase: "checker" };
  const h = html(withReading(paused, { phase: "checker", state: "working", with: "Checker", working: true, wait: null }, { steps: [] }));
  assert.match(h, /<span class="state paused">Paused<\/span>/, "the status word too, not Queued");
  assert.doesNotMatch(h, /class="step[^"]*\bnow\b/, "no tile of a paused card pulses");
  assert.equal(tile(h, "Checker").cls, "step here", "its place is the plain ring");
  const off = html(board(paused, { steps: [] }));
  assert.doesNotMatch(off, /class="step[^"]*\bnow\b/, "nor with no reading");
  assert.match(off, /<span class="state paused">Paused<\/span>/);
});

test("a paused card that nobody started reads Paused, not Queued (Checker LOW: the order of the two words)", () => {
  const h = html(board({ ...base, status: "paused", phase: "build" }, { steps: [], derived: { phase: "build" } }));
  assert.match(h, /<span class="state paused">Paused<\/span>/);
  assert.doesNotMatch(h, /<span class="state queued">/, "never the Queued word");
  assert.doesNotMatch(h, /class="step[^"]*\bnow\b/);
});

// #C1382: whether a card is stuck (over twice the phase's usual time, nobody on it: STUCK_TIMES in worker/reading.mjs) is the reading's; the page draws the dark tile for state stuck and no other.
test("stuck is the reading's: the dark tile for state stuck, the plain wait for a card still within its time", () => {
  const stuck = tile(html(withReading(base, { state: "stuck", wait: null, with: "Builder", working: false, why: "at build for 2.5 times the usual" })), "Build");
  assert.equal(stuck.cls, "step now stuck");
  assert.match(stuck.title, /2\.5 times the usual/);
  const within = tile(html(withReading(base, { state: "waiting", wait: "turn", with: "Builder" })), "Build");
  assert.doesNotMatch(within.cls, /stuck/, "within its time: not stuck");
  const slowWorking = tile(html(withReading(base, { state: "working", working: true, wait: null, with: "Builder" }, { steps: [step(ID, "build", "Builder", "start", NOW - 9 * H)] })), "Build");
  assert.doesNotMatch(slowWorking.cls, /stuck/, "an agent working slowly stays blue");
});

test("Started is the first push, not created_at", () => {
  const pushed = NOW - 90 * MIN;
  const h = html(board(base, { steps: [step(ID, "build", "Builder", "start", pushed)] }));
  assert.match(h, /Started [^<]* · 1 h 30 min so far/, "counted from the first phase-log entry, not the 5 h old card");
});
