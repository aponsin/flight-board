// idle-wake-missed-1215 (#C940): 11-11 about 12:00-12:15 pm MT (19:00-19:16Z) Boardsmith and Builder sat idle with startable cards and no wake reached
// anyone: both sessions had just been reset (Remote Control off, a new session start). A session with no assistant entry in its transcript yet reads
// state "unknown" with no `since` (collector/state.mjs activity), and both the 1-minute dispatch (gate/reset.mjs dispatchItems) and the 15-minute
// wake for an unstarted card (worker/board-rules.mjs stalledWaits) skipped anything not "idle". The dispatch log showed "0 item(s)" for 12 minutes
// from 19:00Z and the first item at 19:12Z, when the reset sessions had said something.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun } from "../collector/store-dispatch.mjs";
import { stalledWaits } from "../worker/board-rules.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Builder", "Checker", "Security", "Release"], LEAD = "Manager";
const idle = { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN };
const unknown = (agoMin) => ({ state: "unknown", lastActivityAt: NOW - agoMin * MIN, since: null });
const card = (id, extra = {}) => ({ id, num: Number(id.replace(/\D/g, "")) || null, owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", ...extra });
const view = (cards, agents) => ({
  cards, asks: [], stackSwitch: [{ repo: "board", stack: true, set_by: "default", set_at: 0 }],
  evidence: { agents: { readAt: NOW - 5_000, value: { ...Object.fromEntries(ROSTER.map((r) => [r, idle])), ...agents } } },
});
const items = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "iw-")), roster: ROSTER, lead: LEAD, now: NOW }).items.map((i) => `${i.card}:${i.role}`);

test("dispatch: a reset session reading 'unknown' for 16 minutes is woken for its startable card, as an idle one is", () => {
  assert.deepEqual(items(view([card("c935-fold")], { Boardsmith: unknown(16) })), ["c935-fold:Boardsmith"]);
});

test("dispatch: an 'unknown' reading waits the full 15 minutes (Checker's LOW1: a busy session with an unreadable transcript reads unknown, and lastActivityAt lags)", () => {
  assert.deepEqual(items(view([card("c935-fold")], { Boardsmith: unknown(3) })), [], "3 minutes: could be mid-turn");
  assert.deepEqual(items(view([card("c935-fold")], { Boardsmith: unknown(14) })), [], "14 minutes");
  assert.deepEqual(items(view([card("c935-fold")], { Boardsmith: idle })), ["c935-fold:Boardsmith"], "an idle reading still goes after 60 s for a phase turn, as before");
});

test("dispatch still quiet: a working agent, an unknown one with no session time, a held card, one waiting on a dependency", () => {
  assert.deepEqual(items(view([card("c1-a")], { Boardsmith: { state: "working", lastActivityAt: NOW, since: NOW - MIN } })), [], "mid-turn");
  assert.deepEqual(items(view([card("c1-a")], { Boardsmith: { state: "unknown", lastActivityAt: null, since: null } })), [], "no session time to count from");
  assert.deepEqual(items(view([card("c1-a", { waiting_on: "the owner" })], { Boardsmith: unknown(30) })), [], "held on someone else");
  assert.deepEqual(items(view([card("c1-a"), card("c2-b", { depends_on: JSON.stringify(["c1-a"]), owner_role: "Builder" })], { Builder: unknown(30), Boardsmith: { state: "working", lastActivityAt: NOW, since: NOW - MIN } })), [], "builder's only card waits on a card that is not live");
});

test("dispatch: the log says what each rostered role read as, so a quiet minute can be told from a blind one", () => {
  const lines = [];
  dispatchRun(view([card("c1-a")], { Builder: unknown(1) }), { dir: mkdtempSync(join(tmpdir(), "iw-")), roster: ROSTER, lead: LEAD, now: NOW, log: (l) => lines.push(l) });
  const l = lines.find((x) => x.startsWith("dispatch: agents "));
  assert.ok(l, lines.join("\n"));
  assert.match(l, /Builder=unknown/);
  assert.match(l, /Boardsmith=idle/);
  assert.ok(!/lastActivityAt|\d{10}/.test(l), "states only, no times or ids");
});

// the 15-minute wake for an unstarted card (stalledWaits): one line per role
const row = (extra = {}) => ({ id: "c935-fold", num: 935, owner_role: "Boardsmith", blocked_reason: null, paused: 0, dropped: 0, waiting_on: null, updated_at: NOW - 3600e3, ...extra });
const wake = (cards, agents) => stalledWaits({ now: NOW, cards, evidence: {}, agents, openAskCards: new Set(), phaseStart: new Map(), postedAt: new Map(), endsPassed: new Map() });

test("stalledWaits: a reset session 'unknown' for 20 minutes with a queued unstarted card raises the idle line; 10 minutes does not yet", () => {
  const out = wake([row()], { Boardsmith: unknown(20) });
  assert.equal(out.length, 1);
  assert.match(out[0].reason, /Boardsmith idle since \d{1,2}:\d\d [ap]m MT, 1 queued, next #C935/);
  assert.deepEqual(wake([row()], { Boardsmith: unknown(10) }), []);
});

test("stalledWaits still quiet: a working agent, no session time, a held card, the lead's own card", () => {
  assert.deepEqual(wake([row()], { Boardsmith: { state: "working", lastActivityAt: NOW, since: NOW - 30 * MIN, card: null } }), []);
  // Security's F1: the state check itself, not the timing (these have a session time 30+ min old, so only the state keeps them quiet).
  for (const state of ["working", "blocked", "waiting", "other"]) {
    assert.deepEqual(wake([row()], { Boardsmith: { state, lastActivityAt: NOW - 45 * MIN, since: NOW - 45 * MIN, card: null } }), [], `a ${state} owner with an old session time raises nothing`);
  }
  assert.deepEqual(wake([row()], { Boardsmith: { state: "unknown", lastActivityAt: null, since: null } }), []);
  assert.deepEqual(wake([row({ waiting_on: "Checker" })], { Boardsmith: unknown(30) }), []);
  assert.deepEqual(wake([row({ owner_role: "Manager" })], { Manager: unknown(30) }), []);
});

test("stalledWaits: an idle agent is exactly as before", () => {
  const out = wake([row()], { Boardsmith: { state: "idle", lastActivityAt: NOW - 20 * MIN, since: NOW - 20 * MIN } });
  assert.equal(out.length, 1);
  assert.match(out[0].reason, /Boardsmith idle since/);
  assert.deepEqual(wake([row()], { Boardsmith: { state: "idle", lastActivityAt: NOW - 5 * MIN, since: NOW - 5 * MIN } }), []);
});
