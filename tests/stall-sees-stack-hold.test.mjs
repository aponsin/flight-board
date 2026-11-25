// #C1429 (11-24: #C1423 and #C1425, stack-ready, read "waits at Checker 15 min, Checker 2 idle" and then "slow with no reason" while the dispatch held their review on purpose; the whole READY stack was then held by a card
// queued and never started). The dispatch's hold and the reading's wait are ONE rule: the same boards go through both, and the held card reads a `group` wait that names the holder, which neither stall rule fires on.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun } from "../collector/store-dispatch.mjs";
import { groupWaitsFor, stackHoldersFor } from "../worker/group-rule.mjs";
import { reading } from "../worker/reading.mjs";
import { slowWakes } from "../worker/board-rules.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Checker", "Security", "Release"], LEAD = "Manager", TIP = "abcdef012345";
const idle = { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN };
const card = (id, extra = {}) => ({ id, num: Number(id.replace(/\D/g, "")) || null, owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "flight-board", batch: "", ...extra });
const ready = (extra = {}) => ({ lit: ["checker"], phase: "checker", headSha12: "111111111111", signed: [], onMain: false, stack: { tip: TIP, size: 2, branch: "build/stack" }, ...extra });
const building = (extra = {}) => ({ lit: ["build"], phase: "build", headSha12: "444444444444", signed: [], onMain: false, stack: { tip: TIP, size: 2, branch: "build/stack" }, ...extra });
const world = (cards, ev) => ({
  cards, asks: [], stackSwitch: [{ repo: "board", stack: true, set_by: "default", set_at: 0 }],
  evidence: { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle])) }, ...Object.fromEntries(Object.entries(ev).map(([id, v]) => [`cards.${id}`, { readAt: NOW - 5_000, value: v }])) },
});
const reviewed = (cards, ev) => dispatchRun(world(cards, ev), { dir: mkdtempSync(join(tmpdir(), "sd-")), roster: ROSTER, lead: LEAD, now: NOW }).items.some((i) => i.card === "c1-one" && i.step === "review");
const holders = (cards, ev) => groupWaitsFor(cards[0], ev["c1-one"], cards, ev).map((h) => h.id);

// Each row: the other card's reading, and whether the dispatch holds c1-one's review for it. The rule is one: the dispatch holds exactly when the reading names the card.
const ROWS = [
  ["a card with nothing pushed (queued)", undefined, false],
  ["a card pushed and at build", building(), true],
  ["a WIP start push", building({ wipHead: true }), true],
  ["a tip no READY covers", building({ stackHold: true }), true],
  ["a card cut away from the stack", ready({ stack: { tip: TIP, size: 2, outside: true } }), true],
  ["a card that is built too (its review is waiting as well)", ready(), false],
];
for (const [name, other, held] of ROWS) {
  test(`#C1429 the dispatch and the reading agree: ${name} ${held ? "holds" : "does not hold"} a built stack card's review`, () => {
    const cards = [card("c1-one"), card("c2-two")], ev = { "c1-one": ready(), ...(other ? { "c2-two": other } : {}) };
    assert.equal(reviewed(cards, ev), !held, "the dispatch");
    assert.deepEqual(holders(cards, ev), held ? ["c2-two"] : [], "the reading's wait");
  });
}

test("#C1429 the hold is the stack's, the repository's and an open card's: another repository, a paused, dropped or closed card, a live one and a card that is not built hold nothing", () => {
  const card1 = card("c1-one"), ev = { "c1-one": ready() };
  const other = (extra, e = building()) => groupWaitsFor(card1, ev["c1-one"], [card1, card("c2-two", extra)], { ...ev, "c2-two": e }).map((h) => h.id);
  assert.deepEqual(other({}), ["c2-two"], "control: a pushed building card of the same repository");
  assert.deepEqual(other({ repo: "site-one" }), [], "another repository");
  assert.deepEqual(other({ paused: 1 }), [], "paused");
  assert.deepEqual(other({ dropped: 1 }), [], "dropped");
  assert.deepEqual(other({ done_at: NOW }), [], "closed");
  assert.deepEqual(other({ blocked_reason: "x" }), [], "blocked");
  assert.deepEqual(other({}, building({ phase: "live", lit: ["live"] })), [], "live");
  assert.deepEqual(other({}, building({ onMain: true })), [], "on main already");
  assert.deepEqual(stackHoldersFor(card1, building(), [card1, card("c2-two")], { "c2-two": building() }), [], "a card that is not itself built has the group's own wait, not this one");
  assert.deepEqual(stackHoldersFor(card1, ready({ stack: undefined }), [card1, card("c2-two")], { "c2-two": building() }), [], "a card with no stack evidence is in no stack");
  assert.deepEqual(stackHoldersFor(card1, ready({ stack: { tip: TIP, size: 2, outside: true } }), [card1, card("c2-two")], { "c2-two": building() }), [], "a card outside the stack is not held by it");
  assert.deepEqual(groupWaitsFor(card1, ev["c1-one"], [card1, card("c2-two", { num: 7 })], { ...ev, "c2-two": building() }), [{ id: "c2-two", num: 7 }], "named with its number");
  const g1 = card("c1-one", { batch: "g1" }), mate = card("c3-mate", { batch: "g1" }), both = groupWaitsFor(g1, ev["c1-one"], [g1, mate], { ...ev, "c3-mate": building() });
  assert.deepEqual(both.map((h) => h.id), ["c3-mate"], "a groupmate that is also the stack's holder is named once");
});

test("#C1429 the reading: a held stack card waits, 'group', for the holder, and is not 'turn' or stuck; with nothing holding it is as before", () => {
  const c1 = card("c1-one"), c2 = card("c2-two", { num: 2 }), read = (evidence) => reading(c1, evidence["c1-one"], [], {}, {}, NOW, { cards: [c1, c2], evidence });
  const held = read({ "c1-one": ready(), "c2-two": building() });
  assert.equal(held.wait, "group");
  assert.deepEqual(held.waitsFor, [{ id: "c2-two", num: 2 }]);
  assert.equal(held.state, "waiting");
  const free = read({ "c1-one": ready() });
  assert.notEqual(free.wait, "group", "nothing holds it");
});

test("#C1429 the slow wake does not fire for a held stack card, and fires as before once the hold is gone", () => {
  const c1 = card("c1-one", { num: 1, batch: "" }), c2 = card("c2-two", { num: 2, batch: "" }), slow = (evidence) => slowWakes({ now: NOW, cards: [c1, c2], evidence, openAskCards: new Set(), phaseStart: new Map([["c1-one|checker", NOW - 40 * MIN]]), medians: { checker: 10 * MIN }, endsPassed: new Set() }).map((s) => s.reason);
  assert.deepEqual(slow({ "c1-one": ready(), "c2-two": building() }), [], "held by c2-two: waiting, not slow");
  assert.equal(slow({ "c1-one": ready() }).length, 1, "control: with no holder the same card is slow");
});
