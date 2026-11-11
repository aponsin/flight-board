// no-session-role-alarm (#C947, the gap #C940 left; the new dispatch log line shows it as Role=none): an unstarted card whose owner role has no open
// session at all (the agents reading lists others) has nobody to start it, and stalledWaits raised nothing. Now one line per such role to Manager.
import test from "node:test";
import assert from "node:assert/strict";
import { stalledWaits } from "../worker/board-rules.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3, HOUR = 3600e3;
const idle = (agoMin) => ({ state: "idle", lastActivityAt: NOW - agoMin * MIN, since: NOW - agoMin * MIN });
const row = (id, extra = {}) => ({ id, num: Number(id.replace(/\D/g, "")), owner_role: "Demos", blocked_reason: null, paused: 0, dropped: 0, waiting_on: null, updated_at: NOW - HOUR, ...extra });
const wake = (cards, agents, more = {}) => stalledWaits({ now: NOW, cards, evidence: {}, agents, openAskCards: new Set(), phaseStart: new Map(), postedAt: new Map(), endsPassed: new Map(), ...more });
const OTHERS = { Boardsmith: idle(2), Builder: { state: "working", lastActivityAt: NOW, since: NOW - MIN, card: null } };

test("a role with no open session and an unstarted card raises one line naming the count and the next card", () => {
  const out = wake([row("c951-b"), row("c950-a")], OTHERS);
  assert.equal(out.length, 1, "one line per role, not per card");
  assert.deepEqual({ role: out[0].role, num: out[0].num, phase: out[0].phase }, { role: "Demos", num: 950, phase: null });
  assert.equal(out[0].reason, "Demos has no open session, 2 queued, next #C950");
});

test("the line is the same every minute (so the store sends it once per spell) and carries no time", () => {
  const a = wake([row("c950-a")], OTHERS)[0].reason, b = stalledWaits({ now: NOW + 7 * MIN, cards: [row("c950-a")], evidence: {}, agents: OTHERS, openAskCards: new Set(), phaseStart: new Map(), postedAt: new Map(), endsPassed: new Map() })[0].reason;
  assert.equal(a, b);
  assert.ok(!/\d\d:\d\d/.test(a));
});

test("nothing new for a role that is idle, working, unknown or whose session is there but quiet", () => {
  for (const o of [idle(2), idle(30), { state: "working", lastActivityAt: NOW, since: NOW - MIN, card: null }, { state: "unknown", lastActivityAt: NOW - 3 * MIN, since: null }]) {
    const out = wake([row("c950-a")], { ...OTHERS, Demos: o });
    assert.ok(!out.some((x) => /no open session/.test(x.reason)), JSON.stringify(o));
  }
});

test("nothing for a held card, a card behind a dependency, a closed or dropped one, a paused one, the lead's, a stale or brand-new one", () => {
  const none = (c, more) => assert.deepEqual(wake([c], OTHERS, more), [], JSON.stringify(c));
  none(row("c950-a", { waiting_on: "Checker" }));
  none(row("c950-a", { blocked_reason: "keys" }));
  none(row("c950-a", { paused: 1 }));
  none(row("c950-a", { dropped: 1 }));
  none(row("c950-a", { done_at: NOW - HOUR }));
  none(row("c950-a", { owner_role: "Manager" }));
  none(row("c950-a", { updated_at: NOW - 4 * 24 * HOUR }));
  none(row("c950-a", { updated_at: NOW - 5 * MIN }));
  none(row("c950-a", { owner_role: undefined }));
  assert.deepEqual(wake([row("c950-a", { depends_on: JSON.stringify(["c949-z"]) }), row("c949-z", { owner_role: "Boardsmith" })], OTHERS).filter((x) => /no open session/.test(x.reason)), [], "its dependency is not live");
  assert.deepEqual(wake([row("c950-a")], OTHERS, { openAskCards: new Set(["c950-a"]) }), [], "an open ask on it");
});

test("a blind reading (no agents listed) says nothing: only a reading that lists someone says who is absent", () => {
  assert.deepEqual(wake([row("c950-a")], {}), []);
  assert.deepEqual(wake([row("c950-a")], null), []);
});

test("one line per role: two absent roles are two lines, and a card of a role with a session is untouched", () => {
  const out = wake([row("c950-a"), row("c951-b", { owner_role: "Mainsite" }), row("c952-c", { owner_role: "Boardsmith" })], OTHERS);
  assert.deepEqual(out.filter((x) => /no open session/.test(x.reason)).map((x) => x.role).sort(), ["Demos", "Mainsite"]);
});
