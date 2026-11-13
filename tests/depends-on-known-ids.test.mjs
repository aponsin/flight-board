// #C1003: depends_on refuses card ids that don't exist, on card_create and card_update, and names the closest card. A known id (a done or
// dropped card too), an empty list and null still go in.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard } from "../worker/board-store.mjs";

const T = 1_800_000_000_000;
const card = async (db, id, extra = {}) => { const r = await createCard(db, T, "Manager", { id, title: id.toUpperCase(), ...extra }); assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const deps = async (db, id) => (await db.prepare("SELECT depends_on FROM cards WHERE id = ?").bind(id).first()).depends_on;

test("card_update: an id that is no card is refused, naming the closest one, and the card is unchanged", async () => {
  const db = makeDb(); await card(db, "tests-clean-their-tmp"); await card(db, "other-card"); await card(db, "c");
  const r = await updateCard(db, T + 1, "Manager", { id: "c", depends_on: ["tests-clean-temp-folders"] });
  assert.equal(r.ok, false); assert.equal(r.refused.rule, "depends-on-unknown");
  assert.match(r.refused.detail, /tests-clean-temp-folders is no card on the board \(closest: tests-clean-their-tmp\)/);
  assert.equal(await deps(db, "c"), null);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM refusals WHERE rule = 'depends-on-unknown'").first()).n, 1);
});

test("card_create: the same refusal, and no card is made", async () => {
  const db = makeDb(); await card(db, "real-card");
  const r = await createCard(db, T + 1, "Manager", { id: "new-one", title: "New", depends_on: ["real-cart"] });
  assert.equal(r.refused.rule, "depends-on-unknown"); assert.match(r.refused.detail, /closest: real-card/);
  assert.equal(await db.prepare("SELECT 1 AS x FROM cards WHERE id = 'new-one'").first(), null);
});

test("one unknown id in a list refuses the whole write; every unknown id is named", async () => {
  const db = makeDb(); await card(db, "a"); await card(db, "b");
  const r = await updateCard(db, T + 1, "Manager", { id: "a", depends_on: ["b", "nope-one", "nope-two"] });
  assert.equal(r.refused.rule, "depends-on-unknown");
  assert.match(r.refused.detail, /nope-one/); assert.match(r.refused.detail, /nope-two/); assert.doesNotMatch(r.refused.detail, /b is no card/);
});

test("still allowed: a live card, a done card, a dropped card, an empty list and null", async () => {
  const db = makeDb(); await card(db, "a"); await card(db, "live"); await card(db, "finished"); await card(db, "gone", { dropped: true });
  await updateCard(db, T + 1, "Manager", { id: "finished", done: true, done_evidence: "https://example.com/x" });
  assert.equal((await updateCard(db, T + 2, "Manager", { id: "a", depends_on: ["live", "finished", "gone"] })).ok, true);
  assert.deepEqual(JSON.parse(await deps(db, "a")), ["live", "finished", "gone"]);
  assert.equal((await updateCard(db, T + 3, "Manager", { id: "a", depends_on: [] })).ok, true);
  assert.deepEqual(JSON.parse(await deps(db, "a")), []);
  assert.equal((await updateCard(db, T + 4, "Manager", { id: "a", depends_on: ["live"] })).ok, true);
  assert.equal((await updateCard(db, T + 5, "Manager", { id: "a", depends_on: null })).ok, true);
  assert.equal(await deps(db, "a"), null);
});

test("a write that leaves depends_on alone is never refused for an old unknown id already stored", async () => {
  const db = makeDb(); await card(db, "a");
  await db.prepare("UPDATE cards SET depends_on = ? WHERE id = 'a'").bind(JSON.stringify(["old-ghost"])).run();
  assert.equal((await updateCard(db, T + 1, "Manager", { id: "a", next_note: "hello" })).ok, true);
});

test("the closest card is the one sharing the most words, even when another is nearer by letters (Checker 2's F2a)", async () => {
  const db = makeDb(); await card(db, "alpha-beta-zzzzzzzzzzzzzzzz"); await card(db, "alphabetagamma"); await card(db, "c");
  // "alphabetagamma" is 2 edits from the missing id and shares no word; the other shares two words but is 16 edits away: the words win.
  const r = await updateCard(db, T + 1, "Manager", { id: "c", depends_on: ["alpha-beta-gamma"] });
  assert.equal(r.refused.rule, "depends-on-unknown");
  assert.match(r.refused.detail, /\(closest: alpha-beta-zzzzzzzzzzzzzzzz\)/);
});

test("the card being written is never its own closest hint (Checker 2's F2b)", async () => {
  const db = makeDb(); await card(db, "release-notes-fetch"); await card(db, "unrelated");
  const r = await updateCard(db, T + 1, "Manager", { id: "release-notes-fetch", depends_on: ["release-notes-fetchh"] });
  assert.equal(r.refused.rule, "depends-on-unknown");
  assert.match(r.refused.detail, /\(closest: unrelated\)/, "another card, not itself");
  const solo = makeDb(); await card(solo, "only-card");
  const s = await updateCard(solo, T + 1, "Manager", { id: "only-card", depends_on: ["only-cardd"] });
  assert.equal(s.refused.detail, "only-cardd is no card on the board", "with no other card there is no hint at all");
});

test("the owner and an agent are held to it the same way", async () => {
  const db = makeDb(); await card(db, "a");
  assert.equal((await updateCard(db, T + 1, "owner", { id: "a", depends_on: ["ghost"] })).refused.rule, "depends-on-unknown");
  assert.equal((await updateCard(db, T + 2, "Boardsmith", { id: "a", depends_on: ["ghost"] })).refused.rule, "depends-on-unknown");
});
