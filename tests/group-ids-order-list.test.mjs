// #C1299: the store mints a number for each group and the owner can rename it; ONE order list holds groups and single cards (a single card has its own place,
// "c:<card id>", and the dispatch's order reads it); a card moves to an open group of its repository or to a new group made from a name, with a warning when the group
// is in review; Pull out makes a single card just above the group it left; a group with no open card disappears.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard, moveGroup, openSlots, pullOutOfGroup, renameGroup, moveToGroup, writeEvidence, readView } from "../worker/board-store.mjs";
import { agentRank, groupOrderBlock, slotOf, slotKeyOf, moveToGroupRefusal, groupRenameRefusal, slugOfName, groupPastBuild } from "../worker/board-rules.mjs";

const T = 1_800_000_000_000;
let t = T;
const card = (db, id, batch, extra = {}) => createCard(db, ++t, "Manager", { id, title: `Card ${id}`, owner_role: "Boardsmith", repo: "flight-board", ...(batch ? { batch } : {}), ...extra });
async function world() {
  const db = makeDb();
  for (const [id, batch] of [["a1-one", "g1-a"], ["a2-two", "g1-a"], ["b1-one", "g2-b"], ["c1-one", "g3-c"]]) assert.ok((await card(db, id, batch)).ok);
  return db;
}
const view = async (db) => readView(db, T + 99_000);
const orderRows = async (db) => (await view(db)).groupOrder.map((r) => r.batch);

test("the store mints a #G number the first time a group has a card, the same group keeps its number, and a rename keeps the batch id", async () => {
  const db = await world();
  const names = (await view(db)).groupNames;
  assert.deepEqual(names.map((g) => [g.batch, g.num]), [["g1-a", 1], ["g2-b", 2], ["g3-c", 3]]);
  assert.ok((await card(db, "a3-three", "g1-a")).ok);
  assert.equal((await view(db)).groupNames.length, 3, "a second card in a group mints nothing");
  assert.ok((await updateCard(db, ++t, "Manager", { id: "a3-three", batch: "g9-new" })).ok);
  assert.equal((await view(db)).groupNames.find((g) => g.batch === "g9-new").num, 4, "a card written into a new group mints its number");
  const r = await renameGroup(db, ++t, "owner", { batch: "g1-a", name: "  Board polish  " });
  assert.deepEqual(r, { ok: true, batch: "g1-a", num: 1, name: "Board polish" });
  assert.equal((await view(db)).groupNames.find((g) => g.batch === "g1-a").name, "Board polish");
  assert.equal((await view(db)).cards.find((c) => c.id === "a1-one").batch, "g1-a", "the cards still carry the batch id");
});

test("only the owner renames, shaped {batch, name}, an open group, a name of 1 to 60 characters on one line; refusals are logged", async () => {
  const db = await world();
  for (const who of ["Manager", "Boardsmith", undefined]) assert.equal((await renameGroup(db, ++t, who, { batch: "g1-a", name: "x" })).ok, false, String(who));
  for (const bad of [null, [], {}, { batch: "g1-a" }, { batch: "g1-a", name: "" }, { batch: "g1-a", name: "   " }, { batch: "g1-a", name: "x".repeat(61) }, { batch: "g1-a", name: "a\nb" }, { batch: "g 1", name: "x" }, { batch: "g1-a", name: "x", extra: 1 }]) assert.ok(groupRenameRefusal(bad, "owner"), JSON.stringify(bad));
  assert.equal(groupRenameRefusal({ batch: "g1-a", name: "x".repeat(60) }, "owner"), null);
  assert.equal((await renameGroup(db, ++t, "owner", { batch: "g8-none", name: "x" })).ok, false, "not an open group");
  assert.ok((await view(db)).refusals.some((x) => x.rule === "group-rename-owner" && x.who === "Manager"), "logged");
});

test("Pull out makes the card a single card just above the group it left; a group whose last open card leaves disappears", async () => {
  const db = await world();
  assert.deepEqual(await openSlots(db), ["g1-a", "g2-b", "g3-c"]);
  assert.ok((await pullOutOfGroup(db, ++t, "owner", { id: "b1-one" })).ok);
  assert.deepEqual(await openSlots(db), ["g1-a", slotKeyOf("b1-one"), "g3-c"], "g2-b had one open card: it is gone, the card sits where the group was");
  assert.ok((await pullOutOfGroup(db, ++t, "owner", { id: "a2-two" })).ok);
  assert.deepEqual(await openSlots(db), [slotKeyOf("a2-two"), "g1-a", slotKeyOf("b1-one"), "g3-c"], "just above g1-a, which keeps a1-one");
  assert.deepEqual(await orderRows(db), await openSlots(db), "the stored list is the same list");
});

test("a single card has its own arrows: a card with no place joins the end of the list, then moves; groups and single cards swap places", async () => {
  const db = await world();
  assert.ok((await card(db, "s1-loose", null)).ok);
  const first = await moveGroup(db, ++t, "owner", { batch: slotKeyOf("s1-loose"), dir: "up" });
  assert.equal(first.moved, true);
  assert.deepEqual(await openSlots(db), ["g1-a", "g2-b", slotKeyOf("s1-loose"), "g3-c"]);
  assert.ok((await moveGroup(db, ++t, "owner", { batch: slotKeyOf("s1-loose"), dir: "up" })).moved);
  assert.deepEqual(await openSlots(db), ["g1-a", slotKeyOf("s1-loose"), "g2-b", "g3-c"]);
  assert.equal((await moveGroup(db, ++t, "owner", { batch: slotKeyOf("s1-loose"), dir: "down" })).moved, true);
  assert.equal((await moveGroup(db, ++t, "owner", { batch: "g3-c", dir: "down" })).moved, false, "the last item cannot go down");
  assert.equal((await moveGroup(db, ++t, "owner", { batch: slotKeyOf("a1-one"), dir: "up" })).ok, false, "a card in a group has no place of its own");
  assert.equal((await moveGroup(db, ++t, "Builder", { batch: slotKeyOf("s1-loose"), dir: "up" })).ok, false, "owner or Manager only, as before");
});

test("the dispatch's order reads a single card's place: a placed card ranks by it, an unplaced one stays after everything, and a placed card blocks a lower group", async () => {
  const order = [{ batch: "g1-a", pos: 1 }, { batch: "c:s1-loose", pos: 2 }, { batch: "g2-b", pos: 3 }];
  const mk = (id, group, extra = {}) => ({ id, group, num: id.length, queue_pos: null, owner: false, held: false, rework: false, groupStarted: false, ...extra });
  const g1 = mk("a1-one", "g1-a"), s = mk("s1-loose", ""), g2 = mk("b1-one", "g2-b"), u = mk("u1-unplaced", "");
  assert.deepEqual([g2, u, s, g1].sort((x, y) => agentRank(x, y, order)).map((c) => c.id), ["a1-one", "s1-loose", "b1-one", "u1-unplaced"]);
  assert.equal(slotOf(s, order), "c:s1-loose");
  assert.equal(slotOf(u, order), "", "no place of its own, no group: no slot");
  assert.equal(slotOf(g1, order), "g1-a");
  const cards = [{ ...s, owner_role: "Boardsmith", turn: true }, { ...g2, owner_role: "Boardsmith", turn: true }];
  assert.deepEqual(groupOrderBlock(cards[1], cards, order), { id: "s1-loose", num: cards[0].num, group: "c:s1-loose" }, "a placed single card above a group blocks it");
  assert.equal(groupOrderBlock(cards[0], cards, order), null, "and the group does not block the card above it");
  const unplaced = { ...u, owner_role: "Boardsmith", turn: true };
  assert.equal(groupOrderBlock(unplaced, cards, order)?.id, "s1-loose", "an unplaced card ranks after everything, so a higher item blocks it, as a group always did");
  assert.equal(groupOrderBlock(cards[0], [...cards, unplaced], order), null, "and it blocks no one");
});

test("Move to: an open group of the same repository; another repository, a closed group, the same group and an unknown card are refused", async () => {
  const db = await world();
  assert.ok((await card(db, "p1-prod", "g5-prod", { repo: "platform" })).ok);
  const ok = await moveToGroup(db, ++t, "owner", { id: "c1-one", batch: "g1-a" });
  assert.deepEqual([ok.ok, ok.batch, ok.from, ok.created], [true, "g1-a", "g3-c", false]);
  assert.deepEqual(await openSlots(db), ["g1-a", "g2-b", "g5-prod"], "g3-c had only that card: it is gone");
  for (const bad of [{ id: "c1-one", batch: "g1-a" }, { id: "b1-one", batch: "g5-prod" }, { id: "b1-one", batch: "g7-none" }, { id: "x9-none", batch: "g1-a" }]) assert.equal((await moveToGroup(db, ++t, "owner", bad)).ok, false, JSON.stringify(bad));
  assert.equal((await view(db)).cards.find((c) => c.id === "b1-one").batch, "g2-b", "nothing moved");
  for (const who of ["Manager", "Boardsmith", undefined]) assert.equal((await moveToGroup(db, ++t, who, { id: "b1-one", batch: "g1-a" })).ok, false, String(who));
  assert.ok((await view(db)).refusals.some((x) => x.rule === "move-to-repo"), "logged");
});

test("Move to a group past Build warns and writes nothing until the owner answers Move anyway", async () => {
  const db = await world();
  assert.ok((await writeEvidence(db, ++t, "probe", "cards.a1-one", { lit: ["checker"], phase: "checker", headSha12: "aaaaaaaaaaaa" })).ok);
  const warn = await moveToGroup(db, ++t, "owner", { id: "b1-one", batch: "g1-a" });
  assert.deepEqual([warn.ok, warn.warn, warn.message], [false, "in-review", "This group is in review: adding a card restarts its review"]);
  assert.equal((await view(db)).cards.find((c) => c.id === "b1-one").batch, "g2-b", "nothing was written");
  const go = await moveToGroup(db, ++t, "owner", { id: "b1-one", batch: "g1-a", confirm: true });
  assert.equal(go.ok, true);
  assert.equal((await view(db)).cards.find((c) => c.id === "b1-one").batch, "g1-a");
  assert.equal(groupPastBuild(["build", null, "plan"]), false);
  assert.equal(groupPastBuild(["build", "security"]), true);
  const quiet = await moveToGroup(db, ++t, "owner", { id: "c1-one", batch: "g2-b" });
  assert.equal(quiet.warn, undefined, "a group still at Build gives no warning");
});

test("Move to New group asks for a name and makes the group with the card in it: its slug is taken from the name, it takes the card's place, and it gets a number", async () => {
  const db = await world();
  const r = await moveToGroup(db, ++t, "owner", { id: "a2-two", new_name: "Urgent fixes" });
  assert.deepEqual([r.ok, r.batch, r.name, r.created, r.num], [true, "urgent-fixes", "Urgent fixes", true, 4]);
  assert.deepEqual(await openSlots(db), ["urgent-fixes", "g1-a", "g2-b", "g3-c"], "just above the group the card left");
  const again = await moveToGroup(db, ++t, "owner", { id: "b1-one", new_name: "Urgent fixes" });
  assert.equal(again.batch, "urgent-fixes-2", "a taken slug gets -2");
  assert.deepEqual(await openSlots(db), ["urgent-fixes", "g1-a", "urgent-fixes-2", "g3-c"], "g2-b is empty and gone; the new group took its place");
  await pullOutOfGroup(db, ++t, "owner", { id: "c1-one" });
  const single = await moveToGroup(db, ++t, "owner", { id: "c1-one", new_name: "Solo" });
  assert.equal(single.batch, "solo");
  assert.deepEqual(await openSlots(db), ["urgent-fixes", "g1-a", "urgent-fixes-2", "solo"], "a single card's own place became the new group's");
  assert.equal((await view(db)).groupNames.find((g) => g.batch === "solo").name, "Solo");
});

test("shapes: exactly one of batch and new_name, confirm only true, a name of 1 to 60 characters; slugs", () => {
  for (const bad of [null, [], {}, { id: "a1-one" }, { id: "a1-one", batch: "g1-a", new_name: "x" }, { id: "a1-one", batch: "g 1" }, { id: "a1-one", new_name: "" }, { id: "a1-one", batch: "g1-a", confirm: false }, { id: "A1", batch: "g1-a" }, { id: "a1-one", batch: "g1-a", extra: 1 }]) assert.ok(moveToGroupRefusal(bad, "owner"), JSON.stringify(bad));
  assert.equal(moveToGroupRefusal({ id: "a1-one", batch: "g1-a", confirm: true }, "owner"), null);
  assert.equal(moveToGroupRefusal({ id: "a1-one", new_name: "New" }, "owner"), null);
  assert.equal(slugOfName("  Urgent: fixes & more!  "), "urgent-fixes-more");
  assert.equal(slugOfName("!!!"), "group");
  assert.equal(slugOfName("x".repeat(80)).length, 40);
});
