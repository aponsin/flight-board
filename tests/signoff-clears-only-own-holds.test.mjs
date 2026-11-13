// #C1048 (Security's LOW on G4 v3; the lead's pick A): a reviewer's new sign-off clears a card's waiting_on only when it is in the fixed
// review-hold form ("Checker: Full review"); a hold written for another reason that merely starts with the role ("Security: wait for the
// owner's ok") stays, so board-land cannot take the card past it. Must still allow: the review hold clears on its reviewer's sign-off.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { reviewHoldRole, signoffClears } from "../worker/board-rules.mjs";
import { createCard, updateCard, writeEvidence, readView } from "../worker/board-store.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3, A = "aaaaaaaaaaaa";
const rd = (phase, signed = []) => ({ lit: [phase], phase, headSha12: A, signed, onMain: false });
const cardOf = async (db, id) => (await readView(db, NOW + 9 * MIN)).cards.find((c) => c.id === id);
async function signedWith(waiting_on) {
  const db = makeDb();
  assert.ok((await createCard(db, NOW, "Manager", { id: "c1048", title: "Card", owner_role: "Boardsmith", review_level: "Full" })).ok);
  assert.ok((await writeEvidence(db, NOW + MIN, "probe", "cards.c1048", rd("security", ["checker"]))).ok);
  assert.ok((await updateCard(db, NOW + 2 * MIN, "Manager", { id: "c1048", waiting_on })).ok);
  const r = await writeEvidence(db, NOW + 3 * MIN, "probe", "cards.c1048", rd("ship", ["checker", "security"]));
  assert.ok(r.ok);
  return { r, card: await cardOf(db, "c1048") };
}

test("the review-hold form: a role, a numbered second session, then nothing or ': [quick |full ]review', any case", () => {
  for (const w of ["Security", "security: review", "Security: Full review", "SECURITY: quick review", "Security 2: full review", "  Security:   full review "]) assert.equal(reviewHoldRole(w), "Security", w);
  assert.equal(reviewHoldRole("Linguist: review"), "Linguist");
  for (const w of ["Security: wait for the owner's ok", "Security: full review, then the owner", "Securitys", "Release: land", "Manager: review", "", null, 7]) assert.equal(reviewHoldRole(w), null, String(w));
});

test("Security's case: a hold that only starts with the role stays through that role's sign-off", async () => {
  const { r, card } = await signedWith("Security: wait for the owner's ok");
  assert.equal(r.cleared, undefined);
  assert.equal(card.waiting_on, "Security: wait for the owner's ok");
  assert.equal(signoffClears(rd("security", ["checker"]), rd("ship", ["checker", "security"]), "Security: wait for the owner's ok"), null);
});

test("the lead's condition: only the lead or that same reviewer may write a review hold; anyone else is refused, and may hold in other words", async () => {
  const db = makeDb();
  assert.ok((await createCard(db, NOW, "Manager", { id: "c1048", title: "Card", owner_role: "Boardsmith", review_level: "Full" })).ok);
  const write = (who, waiting_on, at) => updateCard(db, NOW + at * MIN, who, { id: "c1048", waiting_on });
  assert.ok((await write("Manager", "Checker: Full review", 1)).ok, "the lead");
  assert.ok((await write("Security", "Security: review", 2)).ok, "the reviewer it names");
  assert.ok((await write("Checker", "checker 2: full review", 3)).ok, "a reviewer's second session writes as its role");
  for (const [who, w] of [["Boardsmith", "Checker: Full review"], ["owner", "Security: Full review"], ["Checker", "Security: review"], ["Release", "Security"]]) {
    const r = await write(who, w, 4);
    assert.equal(r.ok, false, `${who} writing "${w}"`);
    assert.equal(r.refused.rule, "review-hold-writer");
  }
  assert.equal((await cardOf(db, "c1048")).waiting_on, "checker 2: full review", "a refused write changes nothing");
  assert.ok((await write("owner", "Security: wait for the owner's ok", 5)).ok, "other words are anyone's");
  assert.ok((await write("Boardsmith", null, 6)).ok, "lifting a hold is not writing one");
});

test("must still allow: the review hold clears on its reviewer's sign-off", async () => {
  const { r, card } = await signedWith("Security: Full review");
  assert.deepEqual({ ...r.cleared }, { waiting_on: "Security: Full review", signedBy: "Security" });
  assert.equal(card.waiting_on ?? null, null);
});
