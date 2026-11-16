// #C1080 (the dispatch woke Boardsmith three times in the middle of G9, for #C997, #C990 and #C1078; Manager held each by hand): while a role has a
// STARTED group that is not yet READY, it is woken to build only that group's cards. Reviews, rework and landing are not touched; with no group open
// the queue is dispatched as before.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun } from "../collector/store-dispatch.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Builder", "Checker"], LEAD = "Manager";
const idle = { state: "idle", lastActivityAt: T - 2 * MIN, since: T - 2 * MIN };
// specs: [id, group, queue_pos, role, extra card fields]
const viewOf = (specs, asks = []) => ({
  cards: specs.map(([id, batch, pos, role = "Boardsmith", extra = {}]) => ({ id, num: Number(id.replace(/\D/g, "")), owner_role: role, review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", queue_pos: pos, ...(batch ? { batch } : {}), ...extra })),
  asks, stackSwitch: [{ repo: "board", stack: false, set_by: "default", set_at: 0 }],
  evidence: { agents: { readAt: T - 5_000, value: { Boardsmith: idle, Builder: idle, Checker: idle, Manager: idle } } },
});
const withEvidence = (v, ev) => ({ ...v, evidence: { ...v.evidence, ...Object.fromEntries(Object.entries(ev).map(([id, value]) => [`cards.${id}`, { value, readAt: T - 5_000 }])) } });
const run = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "og-")), roster: ROSTER, lead: LEAD, now: T }).items;
const PUSHED = { lit: ["build", "checker"], phase: "checker", headSha12: "abcdef012345", signed: [], onMain: false };
const forBoardsmith = (items) => items.filter((i) => i.role === "Boardsmith").map((i) => i.card);

// g1: c1 is pushed (the group has started); c2 is in it too and cannot start yet (it depends on c1, which has not landed). c3 is a loose card.
const group = (c2 = {}) => [["c1-one", "g1-open", 1], ["c2-two", "g1-open", 2, "Boardsmith", { depends_on: '["c1-one"]', ...c2 }], ["c3-three", null, 1]];

test("a started group with a card still to build: a card outside it is not dispatched; the group's own queue is", () => {
  const v = withEvidence(viewOf(group()), { "c1-one": PUSHED });
  assert.deepEqual(forBoardsmith(run(v)), [], "c2 waits on c1, c3 is outside the open group: nobody is woken for c3");
});

test("with no group open the same queue is dispatched as before: the loose card is woken", () => {
  const solo = withEvidence(viewOf([["c1-one", "g1-open", 1], ["c3-three", null, 1]]), { "c1-one": PUSHED });
  assert.deepEqual(forBoardsmith(run(solo)), ["c3-three"], "the group's every card is pushed: no group is open");
  const unstarted = viewOf(group());
  assert.deepEqual(forBoardsmith(run(unstarted)), ["c1-one"], "a group nobody has pushed has not started: the queue's first card, as before");
});

test("a card of the group with an open ask, or waiting on someone else, or paused, holds the group open for no one", () => {
  const ev = { "c1-one": PUSHED };
  const asked = withEvidence(viewOf(group(), [{ id: "A1", num: 1, card_id: "c2-two", type: "Decision", closed_at: null, answered_at: null }]), ev);
  assert.deepEqual(forBoardsmith(run(asked)), ["c3-three"], "an open ask on c2: it is not waiting to be built");
  assert.deepEqual(forBoardsmith(run(withEvidence(viewOf(group({ waiting_on: "Manager" })), ev))), ["c3-three"], "waiting on someone else");
  assert.deepEqual(forBoardsmith(run(withEvidence(viewOf(group({ paused: 1 })), ev))), ["c3-three"], "paused");
  assert.deepEqual(forBoardsmith(run(withEvidence(viewOf(group({ dropped: 1 })), ev))), ["c3-three"], "dropped");
});

test("another role's open group gates only that role: Boardsmith's loose card is still woken", () => {
  const specs = [["c1-one", "g1-open", 1, "Builder"], ["c2-two", "g1-open", 2, "Builder", { depends_on: '["c1-one"]' }], ["c3-three", null, 1]];
  const v = withEvidence(viewOf(specs), { "c1-one": PUSHED });
  assert.deepEqual(forBoardsmith(run(v)), ["c3-three"]);
});

test("reviews are not held: the pushed card of the open group still wakes its reviewer", () => {
  const v = withEvidence(viewOf(group()), { "c1-one": PUSHED });
  assert.ok(run(v).some((i) => i.card === "c1-one" && i.role === "Checker"), JSON.stringify(run(v)));
});

test("a pushed card with no stack-ready signal keeps its group open (stackHold), a covered one does not", () => {
  const specs = [["c1-one", "g1-open", 1, "Boardsmith", { repo: "board" }], ["c3-three", null, 1]];
  const v = (hold) => {
    const base = withEvidence(viewOf(specs), { "c1-one": { ...PUSHED, stack: { outside: false }, stackHold: hold } });
    return { ...base, stackSwitch: [{ repo: "board", stack: true, set_by: "owner", set_at: 0 }] };
  };
  assert.deepEqual(forBoardsmith(run(v(true))), [], "pushed, no signal covers it: the group is not READY, nothing new is built");
  assert.deepEqual(forBoardsmith(run(v(false))), ["c3-three"], "covered: the group is READY");
});
