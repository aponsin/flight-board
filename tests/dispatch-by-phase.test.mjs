// #C850 (dispatch by phase, R1 of "the board moves the work"): the dispatch wakes whoever's turn it is on a card, by its phase, names the
// step and the exact commit, and fires after one idle minute. A test per hop: no phase, build, checker, security missing on Full,
// security, ship, landed and not deployed, live, held, paused, an open ask.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchInput, dispatchRun, turnsOf, PHASE_LANES } from "../collector/store-dispatch.mjs";
import { dispatchLine, DISPATCH_STEPS } from "../gate/reset.mjs";
import { PHASE_LANES as WORKER_LANES } from "../worker/board-rules.mjs";
import { roleTick } from "../scripts/wake-watch.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Checker", "Security", "Release", "Designer", "Linguist"], LEAD = "Manager";
const SHA = "8b3855f0f672";
const idle = (since = NOW - 2 * MIN) => ({ state: "idle", lastActivityAt: since, since });
// One card owned by Boardsmith with the given evidence; every agent idle for 2 minutes unless `agents` says otherwise.
const world = ({ card = {}, ev = null, agents = null, asks = [], now = NOW } = {}) => ({
  cards: [{ id: "c900-thing", num: 900, owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", ...card }],
  asks,
  evidence: {
    agents: { readAt: now - 5_000, value: agents ?? Object.fromEntries(ROSTER.map((r) => [r, idle(NOW - 2 * MIN)])) },
    ...(ev ? { "cards.c900-thing": { readAt: now - 5_000, value: ev } } : {}),
  },
});
const run = (v, now = NOW) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "dp-")), roster: ROSTER, lead: LEAD, now }).items;
const who = (v) => run(v).map((i) => `${i.role}:${i.step}`).sort();

test("the lanes are whoForPhase's (worker PHASE_LANES), so the dispatch and the stall rule name the same agent", () => {
  for (const [phase, role] of Object.entries(PHASE_LANES)) assert.equal(WORKER_LANES[phase], role, phase);
});

test("hop 1, no phase (nothing pushed): the owner builds and pushes", () => {
  assert.deepEqual(who(world()), ["Boardsmith:build"]);
  assert.deepEqual(who(world({ ev: { lit: [], phase: "build" } })), ["Boardsmith:build"], "a build phase is the owner's too");
});

test("hop 2, pushed at checker: Checker reviews the exact commit; on Full, Security too while its note is missing", () => {
  const ev = { lit: ["checker"], phase: "checker", headSha12: SHA, signed: [], onMain: false };
  assert.deepEqual(who(world({ ev })), ["Checker:review"], "Quick: Checker only");
  assert.deepEqual(who(world({ ev, card: { review_level: "Full" } })), ["Checker:review", "Security:review"], "Full: both");
  const items = run(world({ ev, card: { review_level: "Full" } }));
  assert.ok(items.every((i) => i.sha === SHA && i.phase === "checker" && i.num === 900));
});

test("hop 3, Checker signed, Full: only Security is woken; at the security phase Security reviews", () => {
  assert.deepEqual(who(world({ ev: { lit: ["checker"], phase: "checker", headSha12: SHA, signed: ["checker"] }, card: { review_level: "Full" } })), ["Security:review"]);
  assert.deepEqual(who(world({ ev: { lit: ["security"], phase: "security", headSha12: SHA, signed: ["checker"] } })), ["Security:review"]);
  const line = dispatchLine(run(world({ ev: { lit: ["security"], phase: "security", headSha12: SHA, signed: ["checker"] } }))[0]);
  assert.match(line, /^DISPATCH #C900 at security: 8b3855f0f672 signed by Checker; it is pushed; review it/);
});

test("hop 4, language and design reviews go to their lanes", () => {
  assert.deepEqual(who(world({ ev: { lit: ["language"], phase: "language", headSha12: SHA, signed: [] } })), ["Linguist:review"]);
  assert.deepEqual(who(world({ ev: { lit: ["design"], phase: "design", headSha12: SHA, signed: [] } })), ["Designer:review"]);
});

test("hop 5, signed and not on main (ship): Release lands it, and the line names the commit and who signed", () => {
  const items = run(world({ ev: { lit: ["ship"], phase: "ship", headSha12: SHA, signed: ["checker", "security"], onMain: false } }));
  assert.deepEqual(items.map((i) => `${i.role}:${i.step}`), ["Release:land"]);
  assert.equal(dispatchLine(items[0]), `DISPATCH #C900 at ship: ${SHA} signed by Checker and Security; it ${DISPATCH_STEPS.land} (Release's turn; pushing your own build branch, sending READY and taking your next queued card need no go from anyone, act on this)`);
});

test("hop 6, landed and not deployed, a board-repository card (a repo word): the owner builds the deploy pair; with no repo word nobody", () => {
  const ev = { lit: ["ship"], phase: "ship", headSha12: SHA, signed: ["checker", "security"], onMain: true };
  assert.deepEqual(who(world({ ev, card: { repo: "flight-board" } })), ["Boardsmith:pair"]);
  assert.deepEqual(who(world({ ev })), [], "on main, no repo word: the lead closes it");
});

test("hop 7, live: nobody is dispatched", () => {
  assert.deepEqual(who(world({ ev: { lit: ["live"], phase: "live", headSha12: SHA, signed: ["checker", "security"], onMain: true }, card: { repo: "flight-board" } })), []);
});

test("not dispatched: held (a hold with an end), paused, dropped, blocked, an open ask, behind a depends_on that is not live", () => {
  const ev = { lit: ["checker"], phase: "checker", headSha12: SHA, signed: [] };
  for (const [name, card] of [["held", { hold_end: "ask-1" }], ["paused", { paused: 1 }], ["dropped", { dropped: 1 }], ["blocked", { blocked_reason: "DNS" }]]) assert.deepEqual(who(world({ ev, card })), [], name);
  assert.deepEqual(who(world({ ev, asks: [{ id: "a", card_id: "c900-thing", closed_at: null, answered_at: null }] })), [], "an open ask");
  const v = world({ ev, card: { depends_on: '["c901-dep"]' } });
  v.cards.push({ id: "c901-dep", num: 901, owner_role: "Builder", waiting_on: null, paused: 0, dropped: 0 });
  assert.deepEqual(who(v), [], "behind a dependency");
});

test("a role that is working, or idle under one minute, is not woken; one idle a minute is, at once, not after 15", () => {
  const ev = { lit: ["checker"], phase: "checker", headSha12: SHA, signed: [] };
  assert.deepEqual(who(world({ ev, agents: { Checker: { state: "working", card: "x", since: NOW - 9 * MIN } } })), []);
  assert.deepEqual(who(world({ ev, agents: { Checker: idle(NOW - 50_000) } })), []);
  assert.deepEqual(who(world({ ev, agents: { Checker: idle(NOW - 61_000) } })), ["Checker:review"]);
});

test("a phase change is a new first wake: the pair is role, card and phase, each with its own time, and the old phase's pair is forgotten", () => {
  const dir = mkdtempSync(join(tmpdir(), "dp-"));
  const at = (ev, now) => dispatchRun(world({ ev, now }), { dir, roster: ROSTER, lead: LEAD, now }).items;
  const a = at({ lit: ["checker"], phase: "checker", headSha12: SHA, signed: [] }, NOW);
  assert.equal(a[0].since, NOW);
  const b = at({ lit: ["checker"], phase: "checker", headSha12: SHA, signed: [] }, NOW + 10 * MIN);
  assert.equal(b[0].since, NOW, "the same phase keeps its first time");
  const c = at({ lit: ["security"], phase: "security", headSha12: SHA, signed: ["checker"] }, NOW + 11 * MIN);
  assert.equal(c[0].role, "Security");
  assert.equal(c[0].since, NOW + 11 * MIN, "the next phase starts a new wake");
  assert.equal(c[0].level, 1);
  const state = JSON.parse(readFileSync(join(dir, "dispatch-state.json"), "utf8"));
  assert.deepEqual(Object.keys(state.items), ["Security c900-thing security"], "the checker pair is gone");
});

test("the role's own watch prints the line with the step and the commit, once per phase", () => {
  const dir = mkdtempSync(join(tmpdir(), "dp-"));
  dispatchRun(world({ ev: { lit: ["ship"], phase: "ship", headSha12: SHA, signed: ["checker", "security"], onMain: false } }), { dir, roster: ROSTER, lead: LEAD, now: NOW });
  const line = roleTick(dir, "Release", NOW + 1000, 4242);
  assert.match(line, new RegExp(`^DISPATCH #C900 at ship: ${SHA} signed by Checker and Security; it is signed; land it`));
  assert.equal(roleTick(dir, "Release", NOW + 2000, 4242), null, "printed once");
  assert.equal(roleTick(dir, "Checker", NOW + 2000, 4243), null, "another role's watch prints nothing");
});

test("hostile evidence never reaches the line: a bad sha, an odd phase or signer is dropped, the step is a fixed text", () => {
  const t = turnsOf({ id: "c", owner_role: "Boardsmith" }, { phase: "checker", headSha12: "x; rm -rf", signed: ["language", "<img>", 5] });
  assert.equal(t[0].sha, undefined);
  assert.deepEqual(t[0].signed, ["Linguist"]);
  assert.match(dispatchLine({ card: "c", role: "Checker", phase: "checker", step: "../../etc", sha: SHA, level: 1, since: 1 }), /^DISPATCH c: it waits on you/, "an unknown step falls back to the plain line");
  assert.doesNotMatch(dispatchLine({ card: "c", role: "Checker", phase: "checker", step: "review", sha: "$(id)", signed: ["Checker"], level: 1, since: 1 }), /\$\(/);
});
