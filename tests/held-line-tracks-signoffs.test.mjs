// #C992 (11-11: #C913 read "Held: Checker: Full review" for hours after Checker's PASS at 3:41 pm, and the dispatch, which drops a turn whose
// card's waiting_on names someone else, hid Security's turn with it). When a reviewer's sign-off newly appears in a card's evidence, a waiting_on
// that names that reviewer is over: the store clears it (and the hold it made). Must still allow: a waiting_on naming another reviewer still due;
// a waiting_on written after the sign-off.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { signoffClears } from "../worker/board-rules.mjs";
import { createCard, updateCard, writeEvidence, readView } from "../worker/board-store.mjs";
import { initiativeDoc } from "../worker/compat-view.mjs";
import { dispatchItems } from "../gate/reset.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3, A = "aaaaaaaaaaaa";
const rd = (phase, signed = []) => ({ lit: [phase], phase, headSha12: A, signed, onMain: false });
const cardOf = async (db, id) => (await readView(db, NOW + 9 * MIN)).cards.find((c) => c.id === id);
async function held(waiting_on, extra = {}) {
  const db = makeDb();
  assert.ok((await createCard(db, NOW, "Manager", { id: "c913", title: "Card", owner_role: "Boardsmith", review_level: "Full" })).ok);
  assert.ok((await createCard(db, NOW, "Manager", { id: "c999", title: "The install", owner_role: "Boardsmith" })).ok);
  assert.ok((await writeEvidence(db, NOW + MIN, "probe", "cards.c913", rd("checker"))).ok);
  assert.ok((await updateCard(db, NOW + 2 * MIN, "Manager", { id: "c913", waiting_on, ...extra })).ok);
  return db;
}

test("the rule: a sign-off new in this reading matches a waiting_on that starts with its reviewer; nothing else does", () => {
  assert.equal(signoffClears(rd("checker"), rd("security", ["checker"]), "Checker: Full review"), "Checker");
  assert.equal(signoffClears(rd("checker"), rd("security", ["checker"]), "checker 2: full review"), "Checker", "any case; a numbered second session too");
  assert.equal(signoffClears(rd("checker"), rd("security", ["checker"]), "checker 2 has it"), null, "#C1048: words after the role are not the review-hold form");
  assert.equal(signoffClears(null, rd("security", ["checker"]), "Checker: review"), "Checker", "a first reading counts its sign-offs as new");
  assert.equal(signoffClears(null, rd("security", ["checker"]), "Checker"), null, "#C1048: a bare role is an ordinary hold");
  assert.equal(signoffClears(rd("security", ["checker"]), rd("security", ["checker"]), "Checker: Full review"), null, "the same sign-off again is no transition");
  assert.equal(signoffClears(rd("checker"), rd("security", ["checker"]), "Security: Full review"), null, "another reviewer still due");
  assert.equal(signoffClears(rd("checker"), rd("security", ["checker"]), "Checkers' lunch"), null, "a longer word is not the role");
  assert.equal(signoffClears(rd("checker"), rd("security", ["checker"]), "Owner: pick the colour"), null);
  assert.equal(signoffClears(rd("checker"), rd("security", ["checker", "bogus"]), ""), null);
  assert.equal(signoffClears(rd("checker"), rd("checker", ["language"]), "Linguist: review"), "Linguist");
  assert.equal(signoffClears(rd("checker"), rd("checker", ["language"]), "Linguist: LANGUAGE-OK"), null, "#C1048: not the review-hold form");
});

test("#C913: Checker's PASS clears 'Checker: Full review' and its hold; the card shows no Held line and Security's turn is dispatched", async () => {
  const db = await held("Checker: Full review");
  const before = await cardOf(db, "c913");
  assert.ok(before.held_at, "held while it waits on Checker");
  const r = await writeEvidence(db, NOW + 5 * MIN, "probe", "cards.c913", rd("checker", ["checker"]));
  assert.deepEqual(r, { ok: true, cleared: { waiting_on: "Checker: Full review", signedBy: "Checker" } });
  const c = await cardOf(db, "c913");
  assert.deepEqual([c.waiting_on, c.held_at, c.hold_until, c.hold_end, c.moved_at], [null, null, null, null, NOW + 5 * MIN]);
  assert.equal(initiativeDoc(c, null).waitingOn, null === c.waiting_on ? undefined : c.waiting_on, "the page gets no waitingOn, so no Held line");
  const agents = { Security: { state: "idle", since: NOW } };
  const { items } = dispatchItems({ cards: [{ id: "c913", who: "Boardsmith", status: "active", waitingOn: c.waiting_on, turns: [{ role: "Security", phase: "checker", step: "review" }] }], agents, roster: ["Security"], now: NOW + 9 * MIN });
  assert.deepEqual(items.map((i) => i.role), ["Security"], "Security's turn is no longer hidden");
});

test("a waiting_on naming another reviewer, or written after the sign-off, stays; a blocked card keeps its hold", async () => {
  const other = await held("Security: Full review");
  await writeEvidence(other, NOW + 5 * MIN, "probe", "cards.c913", rd("checker", ["checker"]));
  assert.equal((await cardOf(other, "c913")).waiting_on, "Security: Full review");
  const later = await held("Manager: decide", {});
  await writeEvidence(later, NOW + 5 * MIN, "probe", "cards.c913", rd("checker", ["checker"]));
  assert.ok((await updateCard(later, NOW + 6 * MIN, "Manager", { id: "c913", waiting_on: "Checker: look again" })).ok);
  await writeEvidence(later, NOW + 7 * MIN, "probe", "cards.c913", rd("security", ["checker"]));
  assert.equal((await cardOf(later, "c913")).waiting_on, "Checker: look again", "written after the sign-off: the next reading with the same sign-off leaves it");
  const blocked = await held("Checker: Full review", { blocked_reason: "waits for the install", hold_end: "c999", next_note: "land after the install" });
  await writeEvidence(blocked, NOW + 5 * MIN, "probe", "cards.c913", rd("checker", ["checker"]));
  const b = await cardOf(blocked, "c913");
  assert.equal(b.waiting_on, null);
  assert.ok(b.held_at, "the blocked_reason still holds it");
  assert.equal(b.hold_end, "c999", "and keeps its end");
});
