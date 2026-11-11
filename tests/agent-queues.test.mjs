// #C871: each agent's queue is in an order the owner sets, and the dispatch follows it. The card's proof: the owner moves an agent's third card to
// first; that agent's next wake names it; the lead's card_update on its queue_pos is refused; the same after every session is cleared (the order
// is in the store, not in anyone's memory).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard, moveInQueue, readView } from "../worker/board-store.mjs";
import { queueMoveRefusal } from "../worker/board-rules.mjs";
import { dispatchRun } from "../collector/store-dispatch.mjs";
import { dispatchLine } from "../gate/reset.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Checker"], LEAD = "Manager";

async function queue(...ids) {
  const db = makeDb();
  let n = 0;
  for (const id of ids) { const r = await createCard(db, T + ++n, "Manager", { id, title: `Card ${id}`, owner_role: "Boardsmith" }); assert.ok(r.ok, JSON.stringify(r)); }
  for (const [i, id] of ids.entries()) assert.ok((await updateCard(db, T + 100 + i, "Manager", { id, queue_pos: i + 1 })).ok);
  return db;
}
const order = async (db) => (await readView(db, T + 9000)).cards.filter((c) => c.queue_pos != null).sort((a, b) => a.queue_pos - b.queue_pos).map((c) => c.id);
const cardOf = async (db, id) => (await readView(db, T + 9000)).cards.find((c) => c.id === id);

test("the owner moves a card up or down; the queue is renumbered 1..n and the two moved cards carry the owner's mark", async () => {
  const db = await queue("c1-one", "c2-two", "c3-three");
  assert.deepEqual(await moveInQueue(db, T + 500, "owner", { id: "c3-three", dir: "up" }), { ok: true, id: "c3-three", moved: true, order: ["c1-one", "c3-three", "c2-two"] });
  assert.deepEqual(await moveInQueue(db, T + 501, "owner", { id: "c3-three", dir: "up" }), { ok: true, id: "c3-three", moved: true, order: ["c3-three", "c1-one", "c2-two"] });
  assert.deepEqual(await order(db), ["c3-three", "c1-one", "c2-two"]);
  const three = await cardOf(db, "c3-three");
  assert.equal(three.queue_set_by, "owner");
  assert.equal(three.queue_set_at, T + 501);
  assert.equal((await cardOf(db, "c2-two")).queue_set_by, "owner", "the card it was swapped with was placed too");
  assert.equal(await moveInQueue(db, T + 502, "owner", { id: "c3-three", dir: "up" }).then((r) => r.moved), false, "already first: nothing moves");
});

test("the lead's card_update on a placed card's queue_pos is refused by program, and logged; on a card the owner never placed it is allowed", async () => {
  const db = await queue("c1-one", "c2-two", "c3-three");
  await moveInQueue(db, T + 500, "owner", { id: "c3-three", dir: "up" });
  const r = await updateCard(db, T + 600, "Manager", { id: "c3-three", queue_pos: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.refused?.rule ?? r.rule, "queue-owner-set");
  assert.deepEqual(await order(db), ["c1-one", "c3-three", "c2-two"], "nothing changed");
  assert.ok((await readView(db, T + 9000)).refusals.some((x) => x.rule === "queue-owner-set" && x.who === "Manager"), "logged");
  const lone = await queue("c9-solo");
  assert.ok((await updateCard(lone, T + 600, "Manager", { id: "c9-solo", queue_pos: 4 })).ok, "the lead orders a queue the owner has not touched");
  assert.equal((await cardOf(lone, "c9-solo")).queue_set_by, "Manager", "and the card carries who placed it");
});

test("only the owner reorders by hand, a started card is not in the queue, and the move is shaped {id, dir}", async () => {
  const db = await queue("c1-one", "c2-two");
  for (const who of ["Manager", "Boardsmith", "probe", undefined]) assert.equal((await moveInQueue(db, T + 500, who, { id: "c2-two", dir: "up" })).ok, false, String(who));
  assert.deepEqual(await order(db), ["c1-one", "c2-two"]);
  for (const bad of [null, [], { id: "c2-two" }, { id: "c2-two", dir: "left" }, { id: "C2 two", dir: "up" }, { id: "c2-two", dir: "up", extra: 1 }]) assert.ok(queueMoveRefusal(bad, "owner"), JSON.stringify(bad));
  await db.prepare("INSERT INTO evidence (key, value, read_at) VALUES (?, ?, ?)").bind("cards.c1-one", JSON.stringify({ lit: ["checker"], phase: "checker", headSha12: "abcdef012345", signed: [], onMain: false }), T + 400).run();
  const r = await moveInQueue(db, T + 600, "owner", { id: "c1-one", dir: "down" });
  assert.equal(r.ok, false);
});

// The dispatch: Boardsmith has three queued cards with nothing pushed; it is idle.
const idle = { state: "idle", lastActivityAt: T - 2 * MIN, since: T - 2 * MIN };
const viewOf = (cards) => ({
  cards: cards.map(([id, pos]) => ({ id, num: Number(id.replace(/\D/g, "")), owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", queue_pos: pos })),
  asks: [], stackSwitch: [{ repo: "board", stack: false, set_by: "default", set_at: 0 }],
  evidence: { agents: { readAt: T - 5_000, value: { Boardsmith: idle, Checker: idle, Manager: idle } } },
});
const run = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "aq-")), roster: ROSTER, lead: LEAD, now: T }).items;

test("an idle agent is woken for the first card of its queue, in the owner's order, not for every queued card", () => {
  const items = run(viewOf([["c1-one", 1], ["c2-two", 2], ["c3-three", 3]]));
  assert.deepEqual(items.map((i) => i.card), ["c1-one"]);
  assert.match(dispatchLine(items[0]), /^DISPATCH #C1 at build:/);
  assert.deepEqual(run(viewOf([["c1-one", 2], ["c2-two", 3], ["c3-three", 1]])).map((i) => i.card), ["c3-three"], "the third card moved to first is the one the next wake names");
  assert.deepEqual(run(viewOf([["c4-four", null], ["c2-two", null], ["c3-three", 5]])).map((i) => i.card), ["c3-three"], "a card with a place comes before one without, then by number");
});

test("the page's feed carries who placed a card, its stack reading (field by field) and the switch rows", async () => {
  const { initiativeDoc, compatView } = await import("../worker/compat-view.mjs");
  const doc = initiativeDoc({ id: "c1-one", title: "One", queue_pos: 2, queue_set_by: "owner", queue_set_at: T }, { value: { lit: ["build"], stack: { tip: "abcdef012345", size: 3, branch: "build/stack", extra: "x" } } });
  assert.equal(doc.queueSetBy, "owner");
  assert.equal(doc.queueSetAt, T);
  assert.deepEqual(doc.stack, { tip: "abcdef012345", size: 3, branch: "build/stack" }, "nothing but the four fields rides along");
  assert.equal(initiativeDoc({ id: "c2-two", title: "Two" }, { value: { lit: ["build"], stack: { tip: "nope", size: 1, branch: "--all x" } } }).stack, undefined, "a bad reading is dropped");
  const db = await queue("c1-one");
  const feed = compatView(await readView(db, T + 9000));
  assert.deepEqual(feed.collections.meta.find((m) => m.id === "stackSwitch").rows.map((r) => [r.repo, r.stack]), [["board", true], ["product", false]]);
});

// Checker F1 on ac3d31b: an agent's write could put a card ahead of the owner's first card, and the number tie-break then woke the agent's pick.
test("F1: after the owner puts a card first, the lead cannot put an older card at or ahead of his places; behind them it can", async () => {
  const db = makeDb();
  // c0-old is the oldest card (the lowest number) and nobody has placed it; the others are placed 1 to 3 by the lead.
  for (const [n, id] of ["c0-old", "c1-one", "c2-two", "c3-three"].entries()) assert.ok((await createCard(db, T + n + 1, "Manager", { id, title: id, owner_role: "Boardsmith" })).ok);
  for (const [i, id] of ["c1-one", "c2-two", "c3-three"].entries()) assert.ok((await updateCard(db, T + 100 + i, "Manager", { id, queue_pos: i + 1 })).ok);
  await moveInQueue(db, T + 500, "owner", { id: "c3-three", dir: "up" });
  await moveInQueue(db, T + 501, "owner", { id: "c3-three", dir: "up" });
  assert.deepEqual(await order(db), ["c3-three", "c1-one", "c2-two", "c0-old"], "the move renumbers the queue 1..n; the unplaced older card is last");
  for (const pos of [1, 2, 3]) {
    const r = await updateCard(db, T + 600, "Manager", { id: "c0-old", queue_pos: pos });
    assert.equal(r.ok, false, `place ${pos}`);
    assert.equal(r.refused?.rule ?? r.rule, "queue-owner-set");
  }
  assert.ok((await updateCard(db, T + 601, "Manager", { id: "c0-old", queue_pos: 4 })).ok, "behind the owner's places is open");
  assert.equal(items(await readView(db, T + 9000)).map((i) => i.card).join(), "c3-three", "and the wake names the owner's first card");
  assert.ok((await updateCard(db, T + 602, "owner", { id: "c0-old", queue_pos: 1 })).ok, "the owner may put it anywhere");
  const fresh = await createCard(db, T + 603, "Manager", { id: "c7-new", title: "New", owner_role: "Boardsmith", queue_pos: 1 });
  assert.equal(fresh.ok, false, "a new card cannot take a place at or ahead of one the owner holds either");
  assert.ok((await createCard(db, T + 604, "Manager", { id: "c8-new", title: "New", owner_role: "Boardsmith", queue_pos: 9 })).ok);
});

// Security R1 on 15fc8fe: a card_update of owner_role alone (no queue_pos) carried the card's old place into the new queue, past the owner's floor.
test("R1: an owner_role-only write by an agent-placed card enters the new queue unplaced, so it cannot sit ahead of the owner's places", async () => {
  const db = makeDb();
  for (const [n, id] of ["c1-one", "c2-two"].entries()) assert.ok((await createCard(db, T + n + 1, "Manager", { id, title: id, owner_role: "Boardsmith" })).ok);
  for (const [i, id] of ["c1-one", "c2-two"].entries()) assert.ok((await updateCard(db, T + 100 + i, "Manager", { id, queue_pos: i + 1 })).ok);
  await moveInQueue(db, T + 500, "owner", { id: "c2-two", dir: "up" });
  assert.ok((await createCard(db, T + 10, "Manager", { id: "c5-ahead", title: "Ahead", owner_role: "Builder", queue_pos: 1 })).ok);
  assert.ok((await createCard(db, T + 11, "Manager", { id: "c6-behind", title: "Behind", owner_role: "Builder", queue_pos: 7 })).ok);
  assert.ok((await updateCard(db, T + 600, "Manager", { id: "c5-ahead", owner_role: "Boardsmith" })).ok);
  const ahead = await cardOf(db, "c5-ahead");
  assert.equal(ahead.owner_role, "Boardsmith");
  assert.equal(ahead.queue_pos, null, "place 1 is not carried into the owner's queue: the card enters it unplaced");
  assert.equal(ahead.queue_set_by, null);
  assert.equal((await order(db))[0], "c2-two", "so the owner's first card stays first");
  assert.ok((await updateCard(db, T + 601, "Manager", { id: "c6-behind", owner_role: "Boardsmith" })).ok);
  assert.equal((await cardOf(db, "c6-behind")).queue_pos, null, "a place behind the owner's is not carried either");
  const named = await updateCard(db, T + 603, "Manager", { id: "c6-behind", owner_role: "Builder", queue_pos: 1 });
  assert.ok(named.ok, "a write that names its own place in a queue with no owner floor is as before");
  assert.ok((await updateCard(db, T + 602, "owner", { id: "c5-ahead", owner_role: "Boardsmith" })).ok, "the owner may move it");
});

// Checker on da011f1: moving an owner-placed card to another agent must not carry the owner's place and mark into that queue.
test("R1b: an agent's owner_role change on an owner-placed card clears its place and mark; the owner's own move keeps them", async () => {
  const db = makeDb();
  for (const [n, [id, role]] of [["b1-one", "Boardsmith"], ["b2-two", "Boardsmith"], ["u1-one", "Builder"], ["u2-two", "Builder"]].entries()) assert.ok((await createCard(db, T + n + 1, "Manager", { id, title: id, owner_role: role })).ok);
  for (const [i, id] of ["b1-one", "b2-two"].entries()) assert.ok((await updateCard(db, T + 100 + i, "Manager", { id, queue_pos: i + 1 })).ok);
  for (const [i, id] of ["u1-one", "u2-two"].entries()) assert.ok((await updateCard(db, T + 110 + i, "Manager", { id, queue_pos: i + 1 })).ok);
  await moveInQueue(db, T + 500, "owner", { id: "b2-two", dir: "up" });
  await moveInQueue(db, T + 501, "owner", { id: "u2-two", dir: "up" });
  assert.ok((await updateCard(db, T + 600, "Manager", { id: "b2-two", owner_role: "Builder" })).ok);
  const moved = await cardOf(db, "b2-two");
  assert.equal(moved.owner_role, "Builder");
  assert.equal(moved.queue_pos, null, "its place is cleared");
  assert.equal(moved.queue_set_by, null, "and so is the owner's mark");
  const builder = (await readView(db, T + 9000)).cards.filter((c) => c.owner_role === "Builder" && c.queue_pos != null).sort((a, b) => a.queue_pos - b.queue_pos);
  assert.equal(builder[0].id, "u2-two", "the owner's first Builder card stays first");
  assert.ok((await updateCard(db, T + 601, "owner", { id: "u1-one", owner_role: "Boardsmith" })).ok);
  assert.equal((await cardOf(db, "u1-one")).queue_set_by, "owner", "the owner's own move keeps the mark");
});

function items(view) {
  const cards = view.cards.map((c) => ({ ...c, repo: "" }));
  return dispatchRun({ cards, asks: [], stackSwitch: [], evidence: { agents: { readAt: T - 5_000, value: { Boardsmith: idle, Manager: idle } } } }, { dir: mkdtempSync(join(tmpdir(), "aq-")), roster: ROSTER, lead: LEAD, now: T }).items;
}

test("F1: at one place a card the owner placed wins the tie, in the move and in the dispatch (not the lower number)", async () => {
  const v = viewOf([["c1-one", 1], ["c2-two", 1]]);
  assert.deepEqual(run(v).map((i) => i.card), ["c1-one"], "no owner: the number breaks the tie");
  v.cards.find((c) => c.id === "c2-two").queue_set_by = "owner";
  assert.deepEqual(run(v).map((i) => i.card), ["c2-two"], "the owner's card wins it");
});

test("F2: a card held by a depends_on sits after those that can start, in the move, the wake and the order shown", async () => {
  const db = await queue("c1-one", "c2-two");
  assert.ok((await createCard(db, T + 20, "Manager", { id: "c9-dep", title: "Dep", owner_role: "Checker" })).ok);
  assert.ok((await updateCard(db, T + 700, "Manager", { id: "c1-one", depends_on: ["c9-dep"] })).ok);
  const down = await moveInQueue(db, T + 701, "owner", { id: "c2-two", dir: "down" });
  assert.deepEqual(down.order, ["c2-two", "c1-one"], "c1 holds place 1 but waits on c9, so c2 comes first");
  assert.equal(down.moved, false, "and nothing crosses the line between held and startable");
  assert.equal((await moveInQueue(db, T + 702, "owner", { id: "c1-one", dir: "up" })).moved, false);
  assert.equal(items(await readView(db, T + 9000)).filter((i) => i.role === "Boardsmith").map((i) => i.card).join(), "c2-two", "the wake names the card that can start");
});

test("the order is the store's: the same answer from a fresh read after every session is cleared", async () => {
  const db = await queue("c1-one", "c2-two", "c3-three");
  await moveInQueue(db, T + 500, "owner", { id: "c3-three", dir: "up" });
  await moveInQueue(db, T + 501, "owner", { id: "c3-three", dir: "up" });
  const cards = (await readView(db, T + 9000)).cards.map((c) => [c.id, c.queue_pos]);
  assert.deepEqual(run(viewOf(cards)).map((i) => i.card), ["c3-three"]);
});
