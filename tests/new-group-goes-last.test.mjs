// #C1372 (the owner, 11-20, a screenshot): board-polish-fourteen, made after board-polish-thirteen, sat above it, because a group nobody had placed sorted by id and
// "fourteen" is before "thirteen" by letters. Now a group nobody placed sorts by its #G number (the newest last), then by id. Nothing is written to the order until the
// owner places a group; the owner's moves stick; a group of another repository keeps its place.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard, moveGroup, openSlots, readView } from "../worker/board-store.mjs";
import { groupCompare, groupRank, orderListOf, GROUP_NEW } from "../worker/board-rules.mjs";

const T = 1_800_000_000_000;
let t = T;
const card = (db, id, batch, repo = "flight-board") => createCard(db, ++t, "Manager", { id, title: `Card ${id}`, owner_role: "Boardsmith", repo, batch });
const view = (db) => readView(db, T + 99_000);

test("a group made after another sits below it even when its id sorts first by letters", async () => {
  const db = makeDb();
  assert.ok((await card(db, "a1-one", "board-polish-thirteen")).ok);
  assert.ok((await card(db, "b1-one", "board-polish-fourteen")).ok);
  assert.deepEqual(await openSlots(db), ["board-polish-thirteen", "board-polish-fourteen"], "fourteen was made after thirteen");
  assert.ok((await card(db, "c1-one", "board-polish-twelve")).ok);
  assert.deepEqual(await openSlots(db), ["board-polish-thirteen", "board-polish-fourteen", "board-polish-twelve"], "each new one goes last");
});

test("nothing is written to the order: no row exists until the owner places a group", async () => {
  const db = makeDb();
  assert.ok((await card(db, "a1-one", "board-polish-thirteen")).ok);
  assert.ok((await card(db, "b1-one", "board-polish-fourteen")).ok);
  assert.deepEqual((await view(db)).groupOrder, []);
});

test("the owner's moves stick: a group moved up stays above a group made after it, and the next new group still goes after the placed ones", async () => {
  const db = makeDb();
  for (const [id, b] of [["a1-one", "g1-a"], ["b1-one", "g2-b"], ["c1-one", "g3-c"]]) assert.ok((await card(db, id, b)).ok);
  assert.ok((await moveGroup(db, ++t, "owner", { batch: "g3-c", dir: "up" })).ok);
  assert.deepEqual(await openSlots(db), ["g1-a", "g3-c", "g2-b"]);
  assert.ok((await card(db, "d1-one", "g0-d")).ok);
  assert.deepEqual(await openSlots(db), ["g1-a", "g3-c", "g2-b", "g0-d"], "g0-d sorts first by id and still goes last: it is the newest");
  assert.ok((await moveGroup(db, ++t, "owner", { batch: "g0-d", dir: "up" })).ok);
  assert.deepEqual(await openSlots(db), ["g1-a", "g3-c", "g0-d", "g2-b"], "and the owner can still move it up");
});

test("a second card in a group, or a card moved between groups, changes no group's rank", async () => {
  const db = makeDb();
  assert.ok((await card(db, "a1-one", "g2-b")).ok);
  assert.ok((await card(db, "b1-one", "g1-a")).ok);
  const before = await openSlots(db);
  assert.ok((await card(db, "a2-two", "g2-b")).ok);
  assert.ok((await updateCard(db, ++t, "Manager", { id: "a2-two", batch: "g1-a" })).ok);
  assert.deepEqual(await openSlots(db), before);
});

test("groups of different repositories rank by when they were made", async () => {
  const db = makeDb();
  assert.ok((await card(db, "a1-one", "product-x", "product")).ok);
  assert.ok((await card(db, "b1-one", "board-b")).ok);
  assert.ok((await card(db, "c1-one", "board-a")).ok);
  assert.deepEqual(await openSlots(db), ["product-x", "board-b", "board-a"]);
});

test("the rule: a placed group first by its place; an unplaced one by its number, then by id; one with no number after the numbered", () => {
  const order = orderListOf([{ batch: "placed", pos: 1 }], [{ batch: "board-polish-thirteen", num: 112 }, { batch: "board-polish-fourteen", num: 113 }, { batch: "placed", num: 9 }]);
  assert.deepEqual(order, [{ batch: "placed", pos: 1 }, { batch: "board-polish-thirteen", num: 112 }, { batch: "board-polish-fourteen", num: 113 }]);
  const sorted = ["board-polish-fourteen", "nameless", "board-polish-thirteen", "placed"].sort((a, b) => groupCompare(a, b, order));
  assert.deepEqual(sorted, ["placed", "board-polish-thirteen", "board-polish-fourteen", "nameless"]);
  assert.equal(groupRank("placed", order), 1);
  assert.equal(groupRank("board-polish-thirteen", order), GROUP_NEW + 112);
  assert.ok(groupCompare("board-polish-fourteen", "board-polish-thirteen", order) > 0, "fourteen is after thirteen though the letters say the opposite");
  assert.ok(groupCompare("board-polish-fourteen", "board-polish-thirteen", [{ batch: "board-polish-fourteen", pos: 1 }, ...order.slice(1)]) < 0, "unless the owner placed it");
  assert.ok(groupCompare("a", "b", []) < 0 && groupCompare("g2-x", "g10-x", []) < 0, "with no number known, by id as before, digits as numbers");
});
