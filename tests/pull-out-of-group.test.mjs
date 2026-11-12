// #C1008: the owner pulls an urgent card out of its group. The card leaves its batch, keeps where it came from, who and when; the page's feed
// carries that record; a later write that puts it in a group again clears it. Only the owner pulls out, shaped {id}; a card in no group is refused.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard, pullOutOfGroup, readView } from "../worker/board-store.mjs";
import { pullOutRefusal } from "../worker/board-rules.mjs";
import { initiativeDoc } from "../worker/compat-view.mjs";

const T = 1_800_000_000_000;
async function group(...ids) {
  const db = makeDb();
  let n = 0;
  for (const id of ids) assert.ok((await createCard(db, T + ++n, "Manager", { id, title: `Card ${id}`, owner_role: "Boardsmith", batch: "g-probe" })).ok);
  return db;
}
const cardOf = async (db, id) => (await readView(db, T + 9000)).cards.find((c) => c.id === id);

test("the owner pulls a card out of its group: it leaves the batch and records where from, who and when; the others stay", async () => {
  const db = await group("c1-one", "c2-two");
  assert.deepEqual(await pullOutOfGroup(db, T + 500, "owner", { id: "c2-two" }), { ok: true, id: "c2-two", from: "g-probe" });
  const two = await cardOf(db, "c2-two");
  assert.equal(two.batch, null);
  assert.deepEqual([two.pulled_from, two.pulled_by, two.pulled_at], ["g-probe", "owner", T + 500]);
  assert.equal((await cardOf(db, "c1-one")).batch, "g-probe", "the rest of the group is untouched");
  const doc = initiativeDoc(two, null);
  assert.deepEqual([doc.pulledFrom, doc.pulledBy, doc.pulledAt], ["g-probe", "owner", T + 500], "the page's feed carries the record");
  assert.equal(initiativeDoc(await cardOf(db, "c1-one"), null).pulledFrom, undefined, "a card never pulled out carries none");
});

test("putting the card in a group again clears the pulled-out record; a write that leaves batch alone keeps it", async () => {
  const db = await group("c1-one");
  await pullOutOfGroup(db, T + 500, "owner", { id: "c1-one" });
  assert.ok((await updateCard(db, T + 600, "Manager", { id: "c1-one", next_note: "urgent first" })).ok);
  assert.equal((await cardOf(db, "c1-one")).pulled_from, "g-probe", "an unrelated write keeps it");
  assert.ok((await updateCard(db, T + 700, "Manager", { id: "c1-one", batch: "g-release" })).ok);
  const one = await cardOf(db, "c1-one");
  assert.deepEqual([one.batch, one.pulled_from, one.pulled_by, one.pulled_at], ["g-release", null, null, null]);
});

test("only the owner pulls out, shaped {id}; a card in no group, done, dropped or unknown is refused and logged", async () => {
  const db = await group("c1-one");
  for (const who of ["Manager", "Builder", "probe", undefined]) assert.equal((await pullOutOfGroup(db, T + 500, who, { id: "c1-one" })).ok, false, String(who));
  assert.equal((await cardOf(db, "c1-one")).batch, "g-probe", "nothing moved");
  for (const bad of [null, [], {}, { id: "C1 one" }, { id: "c1-one", extra: 1 }, { id: 7 }]) assert.ok(pullOutRefusal(bad, "owner"), JSON.stringify(bad));
  assert.equal(pullOutRefusal({ id: "c1-one" }, "owner"), null);
  await pullOutOfGroup(db, T + 500, "owner", { id: "c1-one" });
  const again = await pullOutOfGroup(db, T + 600, "owner", { id: "c1-one" });
  assert.equal(again.ok, false);
  assert.equal(again.refused?.rule ?? again.rule, "pull-out-no-group");
  assert.equal((await cardOf(db, "c1-one")).pulled_at, T + 500, "a second pull keeps the first record");
  assert.equal((await pullOutOfGroup(db, T + 600, "owner", { id: "c9-none" })).ok, false);
  const gone = await group("c3-three");
  await updateCard(gone, T + 600, "Manager", { id: "c3-three", dropped: true });
  assert.equal((await pullOutOfGroup(gone, T + 700, "owner", { id: "c3-three" })).ok, false, "a dropped card");
  assert.ok((await readView(db, T + 9000)).refusals.some((x) => x.rule === "pull-out-owner" && x.who === "Manager"), "logged");
});
