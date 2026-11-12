// #C832: the store closes a card as done the moment the probe reads it live (done_at = that reading, done_evidence = its commit's link), so
// finished cards stop being read, dispatched and drawn for ever. Not typed by anyone; never a dropped, already-done or check-dated card.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard, writeEvidence } from "../worker/board-store.mjs";
import { cardWriteRefusal } from "../worker/board-rules.mjs";
import { initiativeDoc } from "../worker/compat-view.mjs";

const T = 1_800_000_000_000;
const SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const REPO = "acme/widgets";
const LIVE = { lit: ["live"], phase: "live", headSha: SHA, repoFull: REPO, onMain: true };
const card = async (db, id, extra = {}) => { const r = await createCard(db, T, "Manager", { id, title: id, owner_role: "Builder", ...extra }); assert.equal(r.ok, true, JSON.stringify(r)); };
const row = (db, id) => db.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first();
const read = async (db, id, v, at) => { const r = await writeEvidence(db, at, "probe", `cards.${id}`, v); assert.equal(r.ok, true, JSON.stringify(r)); };

test("a card read live is closed: done_at is that reading, the evidence is its commit's link, and the view says done", async () => {
  const db = makeDb(); await card(db, "shipped");
  await read(db, "shipped", { lit: ["ship"], phase: "ship", headSha: SHA, repoFull: REPO, onMain: true }, T + 1);
  assert.equal((await row(db, "shipped")).done_at, null, "a reading before live closes nothing");
  await read(db, "shipped", LIVE, T + 5);
  const c = await row(db, "shipped");
  assert.equal(c.done_at, T + 5);
  assert.equal(c.done_evidence, `https://github.com/${REPO}/commit/${SHA}`);
  const doc = initiativeDoc(c, null);
  assert.equal(doc.status, "done"); assert.equal(doc.doneAt, T + 5);
  // The evidence is one the done rule itself takes (an https link): closing it by hand with the same words is refused only because it is done.
  assert.equal(cardWriteRefusal({ id: "shipped", done: true, done_evidence: c.done_evidence }, { card: c }), null, "the link has the shape card_update takes");
});

test("a later reading does not rewrite the close: the first time and link stay", async () => {
  const db = makeDb(); await card(db, "once");
  await read(db, "once", LIVE, T + 5);
  await read(db, "once", { ...LIVE, headSha: "f".repeat(40) }, T + 9000);
  const c = await row(db, "once");
  assert.equal(c.done_at, T + 5); assert.equal(c.done_evidence, `https://github.com/${REPO}/commit/${SHA}`);
});

test("a live reading with no full head sha or repository, a dropped card and a card with a check date stay open", async () => {
  const db = makeDb(); await card(db, "bare"); await card(db, "gone"); await card(db, "dated");
  await read(db, "bare", { lit: ["live"], phase: "live" }, T + 1);
  assert.equal((await row(db, "bare")).done_at, null, "no link to show: nothing closes");
  await read(db, "bare", LIVE, T + 2);
  assert.equal((await row(db, "bare")).done_at, T + 2, "the next reading with one does");
  assert.equal((await updateCard(db, T + 3, "Manager", { id: "gone", dropped: true })).ok, true);
  await read(db, "gone", LIVE, T + 4);
  assert.equal((await row(db, "gone")).done_at, null, "dropped says not done");
  assert.equal((await updateCard(db, T + 5, "Manager", { id: "dated", check_at: T + 86_400_000 })).ok, true);
  await read(db, "dated", LIVE, T + 6);
  assert.equal((await row(db, "dated")).done_at, null, "a check date is a wish to look again");
});

test("a card already closed by hand keeps its own evidence", async () => {
  const db = makeDb(); await card(db, "hand");
  assert.equal((await updateCard(db, T + 1, "Builder", { id: "hand", done: true, done_evidence: "/tmp/by-hand.md" })).ok, true);
  await read(db, "hand", LIVE, T + 2);
  assert.equal((await row(db, "hand")).done_evidence, "/tmp/by-hand.md");
});
