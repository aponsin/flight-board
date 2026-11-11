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

test("the order is the store's: the same answer from a fresh read after every session is cleared", async () => {
  const db = await queue("c1-one", "c2-two", "c3-three");
  await moveInQueue(db, T + 500, "owner", { id: "c3-three", dir: "up" });
  await moveInQueue(db, T + 501, "owner", { id: "c3-three", dir: "up" });
  const cards = (await readView(db, T + 9000)).cards.map((c) => [c.id, c.queue_pos]);
  assert.deepEqual(run(viewOf(cards)).map((i) => i.card), ["c3-three"]);
});
