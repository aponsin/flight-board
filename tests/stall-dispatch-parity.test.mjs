// #C1082 (Manager: "one rule, so nothing can drift"; Checker 2's F1 and F2): the idle-agent stall line's "next #C.." and the dispatch's build turn come from ONE
// function (worker/board-rules.mjs openGroupWithheld). This test runs the real dispatch (dispatchRun) and the real stall line (stalledWaits) over the same
// board states and asserts that they name the same card, with the card each is expected to name written out, so two wrong answers cannot agree.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun } from "../collector/store-dispatch.mjs";
import { stalledWaits } from "../worker/board-rules.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Builder", "Checker"], LEAD = "Manager";
const idleNow = { state: "idle", lastActivityAt: T - 2 * MIN, since: T - 2 * MIN };
const PUSHED = { lit: ["build", "checker"], phase: "checker", headSha12: "abcdef012345", signed: [], onMain: false };
const row = ([id, batch, pos, role = "Boardsmith", extra = {}]) => ({ id, num: Number(id.replace(/\D/g, "")), owner_role: role, review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", queue_pos: pos, updated_at: T - MIN, ...(batch ? { batch } : {}), ...extra });

// One board: the dispatch's view and the stall line's inputs, from the same rows. Returns [the dispatch's card for Boardsmith or null, the stall line's card or null].
function both({ specs, ev = { "c1-one": PUSHED }, asks = [], stack = false }) {
  const cards = specs.map(row);
  const view = {
    cards, asks, stackSwitch: [{ repo: "board", stack, set_by: "default", set_at: 0 }],
    evidence: { agents: { readAt: T - 5_000, value: { Boardsmith: idleNow, Builder: idleNow, Checker: idleNow, Manager: idleNow } }, ...Object.fromEntries(Object.entries(ev).map(([id, value]) => [`cards.${id}`, { value, readAt: T - 5_000 }])) },
  };
  const items = dispatchRun(view, { dir: mkdtempSync(join(tmpdir(), "parity-")), roster: ROSTER, lead: LEAD, now: T }).items;
  const dispatched = items.filter((i) => i.role === "Boardsmith").map((i) => i.card)[0] ?? null;
  const lines = stalledWaits({
    now: T, cards, evidence: ev, agents: { Boardsmith: { state: "idle", tool: null, card: null, since: T - 40 * MIN }, Manager: idleNow, Builder: idleNow, Checker: idleNow },
    openAskCards: new Set(asks.filter((a) => a.closed_at == null).map((a) => a.card_id)), unansweredAskCards: new Set(asks.filter((a) => a.closed_at == null && a.answered_at == null).map((a) => a.card_id)),
    phaseStart: new Map(), endsPassed: new Set(), groupOrder: [], stackOn: stack,
  }).filter((s) => s.role === "Boardsmith" && /queued, next #C\d+$/.test(s.reason));
  const num = lines.length ? Number(/next #C(\d+)$/.exec(lines[0].reason)[1]) : null;
  return [dispatched, num === null ? null : cards.find((c) => c.num === num).id];
}
const same = (name, board, expected) => test(`parity: ${name}`, () => assert.deepEqual(both(board), [expected, expected]));

// g1: c1 pushed (the group has started); c2 is in it, unbuilt, depends on c1 (not landed); c3 is a loose card.
const group = (c2 = {}) => [["c1-one", "g1-open", 1], ["c2-two", "g1-open", 2, "Boardsmith", { depends_on: '["c1-one"]', ...c2 }], ["c3-three", null, 1]];

same("a started group with a card still to build: the loose card is held in both", { specs: group() }, null);
same("no group open (every group card pushed): the loose card in both", { specs: [["c1-one", "g1-open", 1], ["c3-three", null, 1]] }, "c3-three");
same("a group nobody has pushed has not started: the queue's first card in both", { specs: group(), ev: {} }, "c1-one");
same("an UNANSWERED open ask on the group's card: it holds nothing, the loose card in both", { specs: group(), asks: [{ id: "A1", num: 1, card_id: "c2-two", closed_at: null, answered_at: null }] }, "c3-three");
// Checker 2's F1: an ANSWERED ask left open (common after the owner answers) is no hold for the dispatch, so the group stays open there and in the stall line.
same("an ANSWERED but still open ask on the group's card: the group stays open, no card in both", { specs: group(), asks: [{ id: "A1", num: 1, card_id: "c2-two", closed_at: null, answered_at: T - MIN }] }, null);
same("a closed ask is no ask: the group stays open in both", { specs: group(), asks: [{ id: "A1", num: 1, card_id: "c2-two", closed_at: T - MIN, answered_at: T - MIN }] }, null);
same("the group's card waits on someone else: the loose card in both", { specs: group({ waiting_on: "Manager" }) }, "c3-three");
same("the group's card is paused: the loose card in both", { specs: group({ paused: 1 }) }, "c3-three");
same("the group's card is dropped: the loose card in both", { specs: group({ dropped: 1 }) }, "c3-three");
same("the group's card has an open hold (hold_end on an ask nobody closed): the loose card in both", { specs: group({ hold_end: "T-held" }) }, "c3-three");
same("the group's card has a check_at to come: the loose card in both", { specs: group({ check_at: T + 60 * MIN }) }, "c3-three");
same("a blocker of the group's card (same role, outside it) keeps its turn in both", { specs: [["c1-one", "g1-open", 1], ["c2-two", "g1-open", 2, "Boardsmith", { depends_on: '["c4-four"]' }], ["c4-four", null, 1], ["c3-three", null, 2]] }, "c4-four");
same("the blocker's blocker too (the closure), one at a time", { specs: [["c1-one", "g1-open", 1], ["c2-two", "g1-open", 2, "Boardsmith", { depends_on: '["c4-four"]' }], ["c4-four", null, 1, "Boardsmith", { depends_on: '["c5-five"]' }], ["c5-five", null, 2], ["c3-three", null, 3]] }, "c5-five");
same("a group card blocked by ANOTHER role's card keeps no group open: the loose card in both", { specs: [["c1-one", "g1-open", 1], ["c2-two", "g1-open", 2, "Boardsmith", { depends_on: '["c9-nine"]' }], ["c9-nine", null, 1, "Builder"], ["c3-three", null, 1]] }, "c3-three");
same("the role is blocked in its group: a card of another group is held in both, a loose card is not", { specs: [["c1-one", "g1-open", 1], ["c2-two", "g1-open", 2, "Boardsmith", { depends_on: '["c9-nine"]' }], ["c9-nine", null, 1, "Builder"], ["c6-six", "g2-other", 1]] }, null);

// The stack switch: with it on, a dependency the same builder has PUSHED is satisfied (the dispatch's waitsOn, #C914 R4), so c2 (group) can start; off, c2
// waits on c4 and c4's own unbuilt dependency c5 is let through. The stall line used to skip c2 here (its own dependsNotLive did not know the exception).
const stackSpecs = [["c1-one", "g1-open", 1], ["c2-two", "g1-open", 2, "Boardsmith", { depends_on: '["c4-four"]' }], ["c4-four", null, 9, "Boardsmith", { depends_on: '["c5-five"]' }], ["c5-five", null, 8]];
const stackEv = { "c1-one": PUSHED, "c4-four": { ...PUSHED, headSha12: "123456abcdef" } };
same("stack switch off: the pushed dependency still blocks, so its own unbuilt dependency is let through in both", { specs: stackSpecs, ev: stackEv, stack: false }, "c5-five");
same("stack switch ON: the pushed same-role dependency is satisfied, so the group's own card can start and is the one named in both", { specs: stackSpecs, ev: stackEv, stack: true }, "c2-two");
