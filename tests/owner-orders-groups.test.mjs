// #C1053 (the owner chose A on 11-12): the owner orders the card groups on the page with up and down buttons, the store keeps the order, and the
// dispatch gives each agent its next card from the highest group that has one for its role, then by queue_pos inside the group; a card in no group
// comes after all groups; a new group goes to the bottom. Written only by the owner (Manager's tool is the fallback); every other writer is refused.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard, moveGroup, openGroups, readView } from "../worker/board-store.mjs";
import { groupMoveRefusal, groupRank, groupCompare, stalledWaits } from "../worker/board-rules.mjs";
import { compatView } from "../worker/compat-view.mjs";
import { dispatchRun } from "../collector/store-dispatch.mjs";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
async function cards(...spec) {
  const db = makeDb();
  let n = 0;
  for (const [id, batch] of spec) assert.ok((await createCard(db, T + ++n, "Manager", { id, title: `Card ${id}`, owner_role: "Boardsmith", ...(batch ? { batch } : {}) })).ok, id);
  return db;
}
const GROUPS = [["c1-one", "g1-a"], ["c2-two", "g2-b"], ["c3-three", "g3-c"], ["c4-four", "g10-d"], ["c5-loose", null]];

test("a board nobody has ordered lists its groups by id, digits as numbers (g2 before g10); a card in no group is no group", async () => {
  const db = await cards(...GROUPS);
  assert.deepEqual(await openGroups(db), ["g1-a", "g2-b", "g3-c", "g10-d"]);
  assert.deepEqual((await readView(db, T + 9000)).groupOrder, []);
});

test("the owner moves a group up or down: the order persists, every open group is placed, the top cannot go up and the bottom cannot go down", async () => {
  const db = await cards(...GROUPS);
  assert.deepEqual(await moveGroup(db, T + 500, "owner", { batch: "g3-c", dir: "up" }), { ok: true, batch: "g3-c", moved: true, order: ["g1-a", "g3-c", "g2-b", "g10-d"] });
  assert.deepEqual(await moveGroup(db, T + 501, "owner", { batch: "g3-c", dir: "up" }), { ok: true, batch: "g3-c", moved: true, order: ["g3-c", "g1-a", "g2-b", "g10-d"] });
  assert.deepEqual(await openGroups(db), ["g3-c", "g1-a", "g2-b", "g10-d"], "read back from the store");
  const rows = (await readView(db, T + 9000)).groupOrder;
  assert.deepEqual(rows.map((r) => [r.batch, r.pos, r.set_by, r.set_at]), [["g3-c", 1, "owner", T + 501], ["g1-a", 2, "owner", T + 501], ["g2-b", 3, "owner", T + 501], ["g10-d", 4, "owner", T + 501]]);
  assert.equal((await moveGroup(db, T + 502, "owner", { batch: "g3-c", dir: "up" })).moved, false, "already first");
  assert.equal((await moveGroup(db, T + 503, "owner", { batch: "g10-d", dir: "down" })).moved, false, "already last");
  assert.deepEqual(await openGroups(db), ["g3-c", "g1-a", "g2-b", "g10-d"], "nothing moved");
});

test("a new group goes to the bottom, and a group with no open card leaves the order at the next move", async () => {
  const db = await cards(...GROUPS);
  await moveGroup(db, T + 500, "owner", { batch: "g10-d", dir: "up" });
  assert.ok((await createCard(db, T + 600, "Manager", { id: "c6-new", title: "New", owner_role: "Boardsmith", batch: "g11-e" })).ok);
  assert.deepEqual(await openGroups(db), ["g1-a", "g2-b", "g10-d", "g3-c", "g11-e"], "the new group is last; g3-c, placed by the owner's move, is ahead of it");
  assert.ok((await updateCard(db, T + 700, "Manager", { id: "c2-two", dropped: true })).ok);
  assert.deepEqual(await openGroups(db), ["g1-a", "g10-d", "g3-c", "g11-e"], "a group whose cards are all dropped is no group");
  await moveGroup(db, T + 800, "owner", { batch: "g11-e", dir: "up" });
  assert.deepEqual((await readView(db, T + 9000)).groupOrder.map((r) => r.batch), ["g1-a", "g10-d", "g11-e", "g3-c"], "its row went");
  assert.equal((await moveGroup(db, T + 900, "owner", { batch: "g2-b", dir: "up" })).ok, false, "a group with no open card is refused");
});

test("only the owner orders the groups (Manager's tool is the fallback); every other writer, shape and unknown group is refused and logged", async () => {
  const db = await cards(...GROUPS);
  for (const who of ["Builder", "Boardsmith", "Checker", "probe", undefined]) {
    const r = await moveGroup(db, T + 500, who, { batch: "g2-b", dir: "up" });
    assert.equal(r.ok, false, String(who));
    assert.equal(r.refused?.rule ?? r.rule, "group-move-owner", String(who));
  }
  assert.deepEqual((await readView(db, T + 9000)).groupOrder, [], "nothing was written");
  assert.deepEqual(await moveGroup(db, T + 600, "Manager", { batch: "g2-b", dir: "up" }).then((r) => [r.ok, r.moved]), [true, true], "Manager's fallback");
  for (const bad of [null, [], {}, { batch: "g2-b" }, { batch: "g2-b", dir: "left" }, { batch: "g 2", dir: "up" }, { batch: "", dir: "up" }, { batch: "g2-b", dir: "up", extra: 1 }, { batch: 7, dir: "up" }]) assert.ok(groupMoveRefusal(bad, "owner"), JSON.stringify(bad));
  assert.equal(groupMoveRefusal({ batch: "g2-b", dir: "down" }, "owner"), null);
  assert.equal(groupMoveRefusal({ batch: "g2-b", dir: "down" }, "Manager"), null);
  assert.equal((await moveGroup(db, T + 700, "owner", { batch: "g99-none", dir: "up" })).ok, false, "unknown group");
  assert.ok((await readView(db, T + 9000)).refusals.some((x) => x.rule === "group-move-owner" && x.who === "Builder"), "logged");
});

// Checker 2's F1 on e1af62f8: without the dir check, moveGroup read any dir that is not "up" as down.
test("a move with a bad or missing dir is refused and moves nothing, whoever sends it", async () => {
  const db = await cards(...GROUPS);
  for (const who of ["owner", "Manager"]) {
    for (const b of [{ batch: "g2-b", dir: "sideways" }, { batch: "g2-b" }, { batch: "g2-b", dir: "" }, { batch: "g2-b", dir: "UP" }, { batch: "g2-b", dir: null }, { batch: "g2-b", dir: 1 }]) {
      const r = await moveGroup(db, T + 500, who, b);
      assert.equal(r.ok, false, `${who} ${JSON.stringify(b)}`);
      assert.equal(r.refused?.rule ?? r.rule, "group-move-shape", `${who} ${JSON.stringify(b)}`);
    }
  }
  assert.deepEqual(await openGroups(db), ["g1-a", "g2-b", "g3-c", "g10-d"], "nothing moved");
  assert.deepEqual((await readView(db, T + 9000)).groupOrder, [], "and nothing was written");
});

test("the rule: a placed group by its place, a new one after the placed ones, a card in no group after all groups, ties by id with digits as numbers", () => {
  const order = [{ batch: "g5-x", pos: 1 }, { batch: "g1-y", pos: 2 }];
  assert.equal(groupRank("g5-x", order), 1);
  assert.ok(groupRank("g9-new", order) > 2 && groupRank("g9-new", order) < groupRank("", order));
  assert.equal(groupRank(null, order), groupRank("", order));
  assert.deepEqual(["g10-b", "", "g2-c", "g1-y", "g5-x"].sort((a, b) => groupCompare(a, b, order)), ["g5-x", "g1-y", "g2-c", "g10-b", ""]);
  assert.deepEqual(["g1-y", "g5-x"].sort((a, b) => groupCompare(a, b, new Map([["g1-y", 1], ["g5-x", 2]]))), ["g1-y", "g5-x"], "a Map works as well as a list");
});

// The dispatch: an agent's next card comes from the highest group that has one for its role.
const ROSTER = ["Manager", "Boardsmith", "Builder", "Checker"], LEAD = "Manager";
const idle = { state: "idle", lastActivityAt: T - 2 * MIN, since: T - 2 * MIN };
const viewOf = (specs, groupOrder) => ({
  cards: specs.map(([id, batch, pos, role = "Boardsmith"]) => ({ id, num: Number(id.replace(/\D/g, "")), owner_role: role, review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", queue_pos: pos, ...(batch ? { batch } : {}) })),
  asks: [], stackSwitch: [{ repo: "board", stack: false, set_by: "default", set_at: 0 }],
  evidence: { agents: { readAt: T - 5_000, value: { Boardsmith: idle, Builder: idle, Checker: idle, Manager: idle } } },
  ...(groupOrder ? { groupOrder } : {}),
});
const run = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "og-")), roster: ROSTER, lead: LEAD, now: T }).items;

test("the dispatch follows the order of the groups before queue_pos; a card in no group comes after every group", () => {
  const specs = [["c1-one", "g1-a", 3], ["c2-two", "g2-b", 1], ["c4-four", null, 1]];
  assert.deepEqual(run(viewOf(specs)).map((i) => i.card), ["c1-one"], "no order set: groups by id; the group's card beats the loose card's queue_pos 1");
  assert.deepEqual(run(viewOf(specs, [{ batch: "g2-b", pos: 1 }, { batch: "g1-a", pos: 2 }])).map((i) => i.card), ["c2-two"], "the owner put g2 first");
  assert.deepEqual(run(viewOf(specs, [{ batch: "g1-a", pos: 1 }, { batch: "g2-b", pos: 2 }])).map((i) => i.card), ["c1-one"]);
  assert.deepEqual(run(viewOf([["c4-four", null, 1], ["c5-five", "g3-c", 9]])).map((i) => i.card), ["c5-five"], "a loose card never goes before a group's card");
  assert.deepEqual(run(viewOf([["c4-four", null, 1], ["c6-six", null, 2]])).map((i) => i.card), ["c4-four"], "no groups: the queue as before");
});

test("inside one group the order is queue_pos, as before; a new group (no place) comes after the placed ones", () => {
  const specs = [["c1-one", "g1-a", 2], ["c2-two", "g1-a", 1], ["c3-three", "g7-new", 1]];
  assert.deepEqual(run(viewOf(specs, [{ batch: "g1-a", pos: 1 }])).map((i) => i.card), ["c2-two"]);
  assert.deepEqual(run(viewOf([["c3-three", "g7-new", 1], ["c1-one", "g9-old", 5]], [{ batch: "g9-old", pos: 1 }])).map((i) => i.card), ["c1-one"], "the placed group goes first although its card has the worse queue_pos");
});

test("an agent with nothing in the top group gets the next group's card, and the agent with a card in it gets that one", () => {
  const specs = [["c1-one", "g1-top", 1, "Builder"], ["c2-two", "g2-next", 1, "Boardsmith"], ["c3-three", "g3-last", 1, "Boardsmith"]];
  const items = run(viewOf(specs, [{ batch: "g1-top", pos: 1 }, { batch: "g2-next", pos: 2 }, { batch: "g3-last", pos: 3 }]));
  assert.deepEqual(items.map((i) => i.card).sort(), ["c1-one", "c2-two"], "Builder takes the top group's card; Boardsmith, with none there, its next group's (not the last group's)");
  const flipped = run(viewOf(specs, [{ batch: "g1-top", pos: 3 }, { batch: "g2-next", pos: 2 }, { batch: "g3-last", pos: 1 }]));
  assert.deepEqual(flipped.map((i) => i.card).sort(), ["c1-one", "c3-three"], "the owner moved g3 above g2");
});

// #C1053, the owner's addition (11-12 8:18 pm: "we work on groups and don't segment them"): an agent finishes every card it owns in a started group before it
// takes a card from another group; the owner's order decides which group starts next.
const withEvidence = (v, ev) => ({ ...v, evidence: { ...v.evidence, ...Object.fromEntries(Object.entries(ev).map(([id, value]) => [`cards.${id}`, { value, readAt: T - 5_000 }])) } });
const PUSHED = { lit: ["build", "checker"], phase: "checker", headSha12: "abcdef012345", signed: [], onMain: false };
const mine = (items) => items.filter((i) => ["c1-one", "c2-two", "c9-nine"].includes(i.card)).map((i) => i.card);

test("an agent with a queued card in a started group gets that card, not one from a higher group that has not started", () => {
  // g1-top (the owner's first group) has not started; g2-next has: its card c3-three, Builder's, is pushed. Boardsmith's c1-one is queued in g2-next.
  const specs = [["c2-two", "g1-top", 1], ["c1-one", "g2-next", 5], ["c3-three", "g2-next", 1, "Builder"]];
  const order = [{ batch: "g1-top", pos: 1 }, { batch: "g2-next", pos: 2 }];
  assert.deepEqual(mine(run(withEvidence(viewOf(specs, order), { "c3-three": PUSHED }))), ["c1-one"], "the started group first, though g1-top is higher");
  assert.deepEqual(mine(run(viewOf(specs, order))), ["c2-two"], "with nothing started, the owner's order decides which group starts");
});

test("a group counts as started when one of its cards has landed or been closed as done, or has a push; a dropped card does not start it", () => {
  const specs = (extra) => [["c2-two", "g1-top", 1], ["c1-one", "g2-next", 5], ["c3-three", "g2-next", 1, "Builder"], ...(extra ?? [])];
  const order = [{ batch: "g1-top", pos: 1 }, { batch: "g2-next", pos: 2 }];
  const landed = withEvidence(viewOf(specs(), order), { "c3-three": { phase: "live", lit: ["live"] } });
  assert.deepEqual(mine(run(landed)), ["c1-one"], "a landed card started its group");
  const done = viewOf(specs(), order);
  done.cards.find((c) => c.id === "c3-three").done_at = T - 60 * MIN;
  assert.deepEqual(mine(run(done)), ["c1-one"], "a card closed as done started its group");
  const dropped = withEvidence(viewOf(specs(), order), { "c3-three": PUSHED });
  dropped.cards.find((c) => c.id === "c3-three").dropped = 1;
  assert.deepEqual(mine(run(dropped)), ["c2-two"], "a dropped card started nothing");
});

test("with a group started, the agent takes its cards there in queue order, then the owner's next group; groups are never interleaved", () => {
  const specs = [["c2-two", "g1-top", 1], ["c1-one", "g2-next", 5], ["c9-nine", "g2-next", 2], ["c3-three", "g2-next", 1, "Builder"]];
  const order = [{ batch: "g1-top", pos: 1 }, { batch: "g2-next", pos: 2 }];
  assert.deepEqual(mine(run(withEvidence(viewOf(specs, order), { "c3-three": PUSHED }))), ["c9-nine"], "its better-placed card in the started group");
  const finished = [["c2-two", "g1-top", 1], ["c3-three", "g2-next", 1, "Builder"]];
  assert.deepEqual(mine(run(withEvidence(viewOf(finished, order), { "c3-three": PUSHED }))), ["c2-two"], "no card of its own left in the started group: the owner's next group");
});

// Rework goes first (the owner's A on 11-12, 8:24 pm): an agent's dispatch order is (1) its rework, from any group in review, (2) its queued cards in its
// started group, (3) the next group in the owner's order, (4) queue_pos.
const FINDINGS = { lit: ["build", "checker"], phase: "checker", headSha12: "abcdef012345", findings: ["checker"], signed: [], onMain: false };
const REWORK_SPECS = [["c7-seven", "g5-other", 1], ["c1-one", "g2-next", 5], ["c3-three", "g2-next", 1, "Builder"]];
const REWORK_ORDER = [{ batch: "g5-other", pos: 2 }, { batch: "g2-next", pos: 1 }];
const mineAll = (items, ids) => items.filter((i) => ids.includes(i.card)).map((i) => `${i.card}:${i.step ?? ""}`).sort();

test("rework beats a started group's queued card: the agent is woken to fix, and for no new card", () => {
  const v = withEvidence(viewOf(REWORK_SPECS, REWORK_ORDER), { "c3-three": PUSHED, "c7-seven": FINDINGS });
  const got = mineAll(run(v), ["c7-seven", "c1-one"]);
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.match(got[0], /^c7-seven:/, "its rework, from a group of its own");
});

test("without rework the started group's queued card is the agent's pick (the control for the rework test)", () => {
  const specs = [["c1-one", "g2-next", 5], ["c3-three", "g2-next", 1, "Builder"], ["c2-two", "g1-top", 1]];
  assert.deepEqual(mine(run(withEvidence(viewOf(specs, [{ batch: "g1-top", pos: 1 }, { batch: "g2-next", pos: 2 }]), { "c3-three": PUSHED }))), ["c1-one"]);
});

test("rework from a group in review beats a started group's queued card whatever group the new card is in; another agent's rework does not stop this one", () => {
  const specs = [["c7-seven", "g5-other", 1, "Builder"], ["c1-one", "g2-next", 5], ["c3-three", "g2-next", 1, "Builder"]];
  const v = withEvidence(viewOf(specs, REWORK_ORDER), { "c3-three": PUSHED, "c7-seven": FINDINGS });
  assert.deepEqual(mine(run(v)), ["c1-one"], "Builder's rework is Builder's: Boardsmith still takes its card");
});

test("a rework the agent cannot act on (an open ask, or waiting on someone else) does not stop its new card: no agent is woken for nothing", () => {
  const base = withEvidence(viewOf(REWORK_SPECS, REWORK_ORDER), { "c3-three": PUSHED, "c7-seven": FINDINGS });
  const asked = { ...base, asks: [{ card_id: "c7-seven", closed_at: null, answered_at: null, num: 1, type: "Decision" }] };
  assert.deepEqual(mine(run(asked)), ["c1-one"], "an open ask on the rework card");
  const waits = viewOf(REWORK_SPECS, REWORK_ORDER);
  waits.cards.find((c) => c.id === "c7-seven").waiting_on = "Manager";
  assert.deepEqual(mine(run(withEvidence(waits, { "c3-three": PUSHED, "c7-seven": FINDINGS }))), ["c1-one"], "waiting on someone else");
});

test("a rework with no reason yet (the store's evidence rework) is rework too: the reason turn goes first", () => {
  const v = withEvidence(viewOf(REWORK_SPECS, REWORK_ORDER), { "c3-three": PUSHED, "c7-seven": { lit: ["checker"], phase: "checker", headSha12: "abcdef012345", rework: true, signed: [] } });
  const got = mineAll(run(v), ["c7-seven", "c1-one"]);
  assert.deepEqual(got, ["c7-seven:reason"]);
});

// One order for the dispatch, the stall line and the owner's queue move: the next card each names is the same.
const NOW = T + 40 * MIN;
const stallNext = (specs, ev, groupOrder) => {
  const cards = specs.map(([id, batch, pos, role = "Boardsmith"]) => ({ id, num: Number(id.replace(/\D/g, "")), owner_role: role, updated_at: NOW - 30 * MIN, queue_pos: pos ?? null, queue_set_by: null, dropped: 0, paused: 0, done_at: null, batch: batch ?? null, rework_reason: null }));
  const out = stalledWaits({ now: NOW, cards, evidence: Object.fromEntries(Object.entries(ev).map(([id, v]) => [id, v])), agents: { Boardsmith: { state: "idle", since: T }, Builder: { state: "working", card: "none" } }, openAskCards: new Set(), phaseStart: new Map(), postedAt: new Map(), endsPassed: new Map(), groupOrder });
  const line = out.find((r) => r.role === "Boardsmith" && r.phase === null);
  return line ? Number(/next #C(\d+)/.exec(line.reason)[1]) : null;
};
const dispatchNext = (specs, ev, groupOrder) => {
  const items = run(withEvidence(viewOf(specs, groupOrder), ev));
  const mineIds = specs.filter((s) => (s[3] ?? "Boardsmith") === "Boardsmith").map((s) => s[0]);
  const first = items.find((i) => mineIds.includes(i.card));
  return first ? Number(first.card.replace(/\D/g, "").replace(/^(\d+).*$/, "$1")) : null;
};

test("the stall line names the card the dispatch wakes the agent for, in every case of the order", () => {
  const O = [{ batch: "g5-other", pos: 2 }, { batch: "g2-next", pos: 1 }];
  const cases = [
    ["no groups, queue_pos", [["c1-one", null, 3], ["c2-two", null, 1], ["c4-four", null, 2]], {}, undefined],
    ["the owner's group order", [["c1-one", "g1-a", 1], ["c2-two", "g2-b", 9], ["c4-four", null, 1]], {}, [{ batch: "g2-b", pos: 1 }, { batch: "g1-a", pos: 2 }]],
    ["a started group", [["c1-one", "g2-next", 5], ["c2-two", "g1-top", 1], ["c3-three", "g2-next", 1, "Builder"]], { "c3-three": PUSHED }, [{ batch: "g1-top", pos: 1 }, { batch: "g2-next", pos: 2 }]],
    ["rework", [["c7-seven", "g5-other", 1], ["c1-one", "g2-next", 5], ["c3-three", "g2-next", 1, "Builder"]], { "c3-three": PUSHED, "c7-seven": FINDINGS }, O],
  ];
  for (const [name, specs, ev, order] of cases) {
    const d = dispatchNext(specs, ev, order), s = stallNext(specs, ev, order ?? []);
    assert.ok(d !== null, `${name}: the dispatch wakes it for a card`);
    assert.equal(s, d, `${name}: stall line #C${s}, dispatch #C${d}`);
  }
});

test("the owner's queue move works on the same order, and never moves a card into another group", async () => {
  const db = makeDb();
  for (const [n, [id, batch]] of [["c1-one", "g1-a"], ["c2-two", "g1-a"], ["c3-three", "g2-b"]].entries()) assert.ok((await createCard(db, T + n + 1, "Manager", { id, title: id, owner_role: "Boardsmith", batch })).ok);
  await moveGroup(db, T + 100, "owner", { batch: "g2-b", dir: "up" });
  const { queueCards, moveInQueue } = await import("../worker/board-store.mjs");
  assert.deepEqual((await queueCards(db, "Boardsmith")).map((r) => r.id), ["c3-three", "c1-one", "c2-two"], "g2-b is the owner's first group");
  const across = await moveInQueue(db, T + 200, "owner", { id: "c1-one", dir: "up" });
  assert.equal(across.moved, false, "c1-one does not cross into g2-b");
  const within = await moveInQueue(db, T + 201, "owner", { id: "c2-two", dir: "up" });
  assert.equal(within.moved, true);
  assert.deepEqual((await queueCards(db, "Boardsmith")).map((r) => r.id), ["c3-three", "c2-two", "c1-one"]);
});

test("isRework reads a card as turnsOf does: findings at a review phase, or a rework with no reason; not a plain queued, building or landed card", async () => {
  const { isRework } = await import("../worker/board-rules.mjs");
  const { turnsOf } = await import("../collector/store-dispatch.mjs");
  const card = { id: "c", owner_role: "Boardsmith", review_level: "Quick" };
  const shapes = [
    undefined, {}, { lit: ["build"] }, PUSHED, FINDINGS, { ...FINDINGS, findings: [] }, { ...FINDINGS, findings: ["nobody"] }, { ...FINDINGS, phase: "build", lit: ["build"] },
    { ...FINDINGS, phase: "ship", lit: ["ship"] }, { ...FINDINGS, phase: "language", lit: ["language"], findings: ["language"] }, { lit: ["checker"], phase: "checker", rework: true },
    { lit: ["live"], phase: "live", findings: ["checker"] },
  ];
  for (const e of shapes) {
    const viaTurns = turnsOf(card, e, {}).some((t) => t.step === "rework" || t.step === "reason");
    assert.equal(isRework(card, e), viaTurns, JSON.stringify(e));
  }
  assert.equal(isRework({ ...card, rework_reason: "review findings" }, { lit: ["checker"], phase: "checker", rework: true }), false, "a rework with its reason attached is the findings case only");
});

test("the page's feed carries the order (meta/groupOrder, in place order) once the owner has set one, and nothing before", async () => {
  const db = await cards(...GROUPS);
  assert.equal(compatView(await readView(db, T + 9000)).collections.meta?.some((m) => m.id === "groupOrder") ?? false, false);
  await moveGroup(db, T + 500, "owner", { batch: "g3-c", dir: "up" });
  const row = compatView(await readView(db, T + 9000)).collections.meta.find((m) => m.id === "groupOrder");
  assert.deepEqual(row.rows.map((r) => [r.batch, r.pos, r.setBy]), [["g1-a", 1, "owner"], ["g3-c", 2, "owner"], ["g2-b", 3, "owner"], ["g10-d", 4, "owner"]]);
});

// The page: the groups in the owner's order, with real up and down buttons on the store page only; a tap posts {batch, dir}.
const NAMES = ["groupLabel", "groupShort", "groupOrderRows", "groupRankOf", "groupCmp", "groupMoveButtons", "groupList", "groupFacts", "groupRow", "pulledTag", "railState", "renderBoard", "initRow", "gates", "enrich", "PHASES"];
function board(initRaw, order, host = "store", answer = null) {
  const els = {}, listeners = {}, calls = [];
  const el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", value: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }) });
  const document = { documentElement: { getAttribute: () => host }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener(t, f) { (listeners[t] ||= []).push(f); }, activeElement: null, createRange: () => ({}) };
  const fetch = async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return answer === false ? { ok: false } : answer ? { ok: true, json: async () => answer } : { ok: true }; };
  const b = loadNames(NAMES, { document, fetch, setTimeout: () => 0 });
  Object.assign(b.state, { initRaw, initiatives: initRaw.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [], meta: order ? [{ id: "groupOrder", rows: order.map((batch, i) => ({ batch, pos: i + 1 })) }] : [] });
  return { ...b, els, listeners, calls };
}
const card = (id, num, fields = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", who: "Boardsmith", createdAt: T + num * 60e3, ...fields });

test("the board lists the groups in the owner's order, a new group after the placed ones, and the cards in no group last", () => {
  const raw = [card("a", 1, { batch: "g1-a" }), card("l", 2), card("b", 3, { batch: "g2-b" }), card("n", 4, { batch: "g9-new" })];
  const b = board(raw, ["g2-b", "g1-a"]);
  assert.deepEqual([...b.groupList(b.state.initiatives).map((x) => x.group ?? x.card.id)], ["g2-b", "g1-a", "g9-new", "l"]);
  b.renderBoard();
  const h = b.els.board.innerHTML;
  assert.ok(h.indexOf('data-group="g2-b"') < h.indexOf('data-group="g1-a"') && h.indexOf('data-group="g1-a"') < h.indexOf('data-group="g9-new"') && h.indexOf('data-group="g9-new"') < h.indexOf("Card 2"));
});

test("groups nobody has placed go by id with digits as numbers on the page too: g2 before g10", () => {
  const b = board([card("a", 1, { batch: "g10-late" }), card("b", 2, { batch: "g2-early" })], null);
  assert.deepEqual([...b.groupList(b.state.initiatives).map((x) => x.group)], ["g2-early", "g10-late"]);
});

test("each group row has real up and down buttons with names, the top one cannot go up and the last cannot go down; none off the store page", () => {
  const raw = [card("a", 1, { batch: "g1-a" }), card("b", 2, { batch: "g2-b" })];
  const b = board(raw, ["g1-a", "g2-b"]);
  b.renderBoard();
  const h = b.els.board.innerHTML;
  assert.match(h, /<button type="button" data-gmove="g1-a" data-dir="up" aria-label="Move group G1 · A up, it goes live earlier" disabled>/);
  assert.match(h, /<button type="button" data-gmove="g1-a" data-dir="down" aria-label="Move group G1 · A down, it goes live later">/);
  assert.match(h, /<button type="button" data-gmove="g2-b" data-dir="down"[^>]*disabled>/);
  assert.doesNotMatch(h, /data-gmove="g2-b" data-dir="up"[^>]*disabled/);
  assert.match(h, /1 of 2/);
  const off = board(raw, ["g1-a", "g2-b"], "artifact");
  off.renderBoard();
  assert.doesNotMatch(off.els.board.innerHTML, /data-gmove=/, "no button where there is no store to write to");
});

// Designer F1 on 9eb8d39d: a click showed nothing until the next re-read, so the owner would click twice and move the group twice.
test("a tap moves the row at once, from the order the store answers with: the board is redrawn in the new order", async () => {
  const raw = [card("a", 1, { batch: "g1-a" }), card("b", 2, { batch: "g2-b" }), card("c", 3, { batch: "g3-c" })];
  const b = board(raw, ["g1-a", "g2-b", "g3-c"], "store", { ok: true, batch: "g3-c", moved: true, order: ["g1-a", "g3-c", "g2-b"] });
  b.renderBoard();
  const at = (h, g) => h.indexOf(`data-group="${g}"`);
  assert.ok(at(b.els.board.innerHTML, "g2-b") < at(b.els.board.innerHTML, "g3-c"), "before the tap g2-b is above g3-c");
  const btn = { dataset: { gmove: "g3-c", dir: "up" }, disabled: false, textContent: "↑", closest: (s) => (s === "[data-gmove]" ? btn : null) };
  for (const f of b.listeners.click) await f({ target: btn });
  const h = b.els.board.innerHTML;
  assert.ok(at(h, "g3-c") < at(h, "g2-b"), "after the 200 the row has moved, with no wait for the next poll");
  assert.match(h, /data-gmove="g3-c" data-dir="up"[^>]*>↑<\/button>[\s\S]*?2 of 3/, "and its place reads 2 of 3");
});

test("an answer with no order (or a store that refuses) leaves the board as it was; a refusal says Not saved on the button", async () => {
  const raw = [card("a", 1, { batch: "g1-a" }), card("b", 2, { batch: "g2-b" })];
  const b = board(raw, ["g1-a", "g2-b"]);
  b.renderBoard();
  const before = b.els.board.innerHTML;
  const btn = { dataset: { gmove: "g2-b", dir: "up" }, disabled: false, textContent: "↑", closest: (s) => (s === "[data-gmove]" ? btn : null) };
  for (const f of b.listeners.click) await f({ target: btn });
  assert.equal(b.els.board.innerHTML, before, "with no order in the answer the board is left as it was");
  const no = board(raw, ["g1-a", "g2-b"], "store", false);
  no.renderBoard();
  const kept = no.els.board.innerHTML;
  const sad = { dataset: { gmove: "g2-b", dir: "up" }, disabled: false, textContent: "↑", closest: (s) => (s === "[data-gmove]" ? sad : null) };
  for (const f of no.listeners.click) await f({ target: sad });
  assert.equal(sad.textContent, "Not saved", "a store that refuses (the answer is not ok) says so on the button");
  assert.equal(no.els.board.innerHTML, kept, "and the board is left as it was");
});

// Checker 2's F2 on e1af62f8: the group id is escaped in the button's data attribute and in its label, so an id with a quote or "<" cannot open a tag.
test("a group id with a quote or an angle bracket is escaped in the buttons' attribute and label", () => {
  const b = board([], null);
  const odd = 'g1-"x"><img src=x onerror=1>';
  const h = b.groupMoveButtons(odd, { n: 1, of: 2 });
  assert.doesNotMatch(h, /<img/, "no tag from the id");
  assert.doesNotMatch(h, /data-gmove="g1-"/, "the quote does not close the attribute");
  assert.match(h, /data-gmove="g1-&quot;x&quot;&gt;&lt;img src=x onerror=1&gt;"/, "the attribute holds the escaped id");
  assert.match(h, /aria-label="Move group g1-&quot;x&quot;&gt;&lt;img src=x onerror=1&gt; up/, "and so does the label");
  const raw = [card("a", 1, { batch: odd }), card("b", 2, { batch: "g2-b" })];
  const page = board(raw, null);
  page.renderBoard();
  assert.doesNotMatch(page.els.board.innerHTML, /<img/, "the whole row, drawn from the card, holds no tag from the id");
});

test("a tap on a group button posts {batch, dir} to the store's route", async () => {
  const b = board([card("a", 1, { batch: "g1-a" }), card("b", 2, { batch: "g2-b" })], ["g1-a", "g2-b"]);
  b.renderBoard();
  const btn = { dataset: { gmove: "g2-b", dir: "up" }, disabled: false, textContent: "↑", closest: (s) => (s === "[data-gmove]" ? btn : null) };
  for (const f of b.listeners.click) await f({ target: btn });
  assert.deepEqual(b.calls, [["/api/group-move", { batch: "g2-b", dir: "up" }]]);
});
