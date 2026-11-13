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
import { groupMoveRefusal, groupRank, groupCompare } from "../worker/board-rules.mjs";
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

test("the page's feed carries the order (meta/groupOrder, in place order) once the owner has set one, and nothing before", async () => {
  const db = await cards(...GROUPS);
  assert.equal(compatView(await readView(db, T + 9000)).collections.meta?.some((m) => m.id === "groupOrder") ?? false, false);
  await moveGroup(db, T + 500, "owner", { batch: "g3-c", dir: "up" });
  const row = compatView(await readView(db, T + 9000)).collections.meta.find((m) => m.id === "groupOrder");
  assert.deepEqual(row.rows.map((r) => [r.batch, r.pos, r.setBy]), [["g1-a", 1, "owner"], ["g3-c", 2, "owner"], ["g2-b", 3, "owner"], ["g10-d", 4, "owner"]]);
});

// The page: the groups in the owner's order, with real up and down buttons on the store page only; a tap posts {batch, dir}.
const NAMES = ["groupLabel", "groupShort", "groupOrderRows", "groupRankOf", "groupCmp", "groupMoveButtons", "groupList", "groupFacts", "groupRow", "pulledTag", "railState", "renderBoard", "initRow", "gates", "enrich", "PHASES"];
function board(initRaw, order, host = "store") {
  const els = {}, listeners = {}, calls = [];
  const el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", value: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }) });
  const document = { documentElement: { getAttribute: () => host }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener(t, f) { (listeners[t] ||= []).push(f); }, activeElement: null, createRange: () => ({}) };
  const fetch = async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return { ok: true }; };
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

test("a tap on a group button posts {batch, dir} to the store's route", async () => {
  const b = board([card("a", 1, { batch: "g1-a" }), card("b", 2, { batch: "g2-b" })], ["g1-a", "g2-b"]);
  b.renderBoard();
  const btn = { dataset: { gmove: "g2-b", dir: "up" }, disabled: false, textContent: "↑", closest: (s) => (s === "[data-gmove]" ? btn : null) };
  for (const f of b.listeners.click) await f({ target: btn });
  assert.deepEqual(b.calls, [["/api/group-move", { batch: "g2-b", dir: "up" }]]);
});
