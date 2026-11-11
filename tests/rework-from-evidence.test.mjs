// #C875 (audit 2026-11-10, group B row 36): Rework is read from evidence. The refusal rule existed (a card in rework takes no other write until a
// reason is attached) but nothing set the flag, so it never fired.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { reworkTriggered, REWORK_REASONS } from "../worker/board-rules.mjs";
import { createCard, updateCard, writeEvidence, readView } from "../worker/board-store.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const A = "aaaaaaaaaaaa", B = "bbbbbbbbbbbb", C = "cccccccccccc";
const rd = (phase, extra = {}) => ({ lit: [phase], phase, headSha12: A, signed: [], onMain: false, ...extra });

test("the rule: a commit after a sign-off or a sent-back review, a review sending the tip back, or a return to build, each on a transition only", () => {
  // A new tip after sign-offs, and after a review that sent the last tip back.
  assert.equal(reworkTriggered(rd("checker", { signed: ["language"] }), rd("checker", { headSha12: B })), true);
  assert.equal(reworkTriggered(rd("checker", { findings: ["checker"] }), rd("checker", { headSha12: B })), true);
  // A review sends the tip back: findings appear where there were none; the same findings on the next reading are not a new event.
  assert.equal(reworkTriggered(rd("checker"), rd("checker", { findings: ["checker"] })), true);
  assert.equal(reworkTriggered(rd("checker", { findings: ["checker"] }), rd("checker", { findings: ["checker"] })), false);
  // Back to build from a review or ship phase.
  for (const p of ["language", "design", "checker", "security", "ship"]) for (const to of ["plan", "build", "test"]) assert.equal(reworkTriggered(rd(p), rd(to)), true, `${p} -> ${to}`);
  // Not rework: the first reading, the same reading, a first push, going forward, a new tip with nothing signed before, landing and live.
  assert.equal(reworkTriggered(null, rd("checker", { findings: ["checker"] })), false, "the first reading has nothing to compare with");
  assert.equal(reworkTriggered(rd("checker"), rd("checker")), false);
  assert.equal(reworkTriggered(rd("build"), rd("checker", { headSha12: B })), false, "the first push is not rework");
  assert.equal(reworkTriggered(rd("checker"), rd("security", { signed: ["checker"] })), false, "forward is not rework");
  assert.equal(reworkTriggered(rd("checker"), rd("checker", { headSha12: B })), false, "a new tip nobody had signed or sent back");
  assert.equal(reworkTriggered(rd("ship", { signed: ["checker"] }), rd("live", { headSha12: B, onMain: true })), false);
  assert.equal(reworkTriggered(rd("checker", { signed: ["checker"] }), rd("live", { headSha12: B })), false, "live is never rework");
  assert.equal(reworkTriggered(rd("ship", { onMain: true, signed: ["checker"] }), rd("build", { headSha12: B })), false, "a landed card's next commit is another card's work");
});

const fresh = async () => { const db = makeDb(); await createCard(db, NOW, "Manager", { id: "a-card", title: "A card", owner_role: "Builder" }); return db; };
const ev = async (db) => JSON.parse((await db.prepare("SELECT value FROM evidence WHERE key = 'cards.a-card'").first()).value);
const read = (db, at, r) => writeEvidence(db, at, "probe", "cards.a-card", r);

test("a commit after a sign-off sets Rework in the card's evidence; other card writes are refused with the reason named; the reason clears it and is kept", async () => {
  const db = await fresh();
  assert.equal((await read(db, NOW, rd("checker", { signed: ["language"] }))).ok, true);
  assert.equal((await ev(db)).rework, undefined, "nothing yet");
  assert.equal((await updateCard(db, NOW, "Manager", { id: "a-card", next_note: "fine" })).ok, true, "writes are open while there is no rework");
  assert.equal((await read(db, NOW + MIN, rd("checker", { headSha12: B }))).ok, true);
  assert.equal((await ev(db)).rework, true, "a new commit after a sign-off");
  // Other writes are refused until a reason is attached; the refusal says what is missing.
  const no = await updateCard(db, NOW + 2 * MIN, "Manager", { id: "a-card", next_note: "again" });
  assert.equal(no.ok, false);
  assert.equal(no.refused.rule, "rework-reason-missing");
  assert.match(no.refused.detail, /Rework: reason missing/);
  assert.ok(REWORK_REASONS.every((r) => no.refused.detail.includes(r)), "the refusal lists the reasons");
  // Repeated readings keep it (the probe reads every minute) and do not need the transition again.
  await read(db, NOW + 3 * MIN, rd("checker", { headSha12: B }));
  assert.equal((await ev(db)).rework, true);
  // The reason: accepted on its own, clears the flag, and is kept in the history.
  assert.equal((await updateCard(db, NOW + 4 * MIN, "Builder", { id: "a-card", rework_reason: "review findings" })).ok, true);
  assert.equal((await ev(db)).rework, undefined);
  assert.deepEqual((await db.prepare("SELECT card_id, reason, at, who FROM rework_history").all()).results, [{ card_id: "a-card", reason: "review findings", at: NOW + 4 * MIN, who: "Builder" }]);
  assert.equal((await updateCard(db, NOW + 5 * MIN, "Manager", { id: "a-card", next_note: "now fine" })).ok, true);
  // The same reading again does not set it a second time.
  await read(db, NOW + 6 * MIN, rd("checker", { headSha12: B }));
  assert.equal((await ev(db)).rework, undefined, "a repeated reading is not a transition");
  // A second rework, a second reason: both are in the history, oldest first, and the view carries them.
  await read(db, NOW + 7 * MIN, rd("security", { headSha12: B, signed: ["checker"] }));
  await read(db, NOW + 8 * MIN, rd("security", { headSha12: C, signed: [] }));
  assert.equal((await ev(db)).rework, true);
  assert.equal((await updateCard(db, NOW + 9 * MIN, "Builder", { id: "a-card", rework_reason: "security finding" })).ok, true);
  const v = await readView(db, NOW + 10 * MIN);
  assert.deepEqual(v.reworkHistory.map((r) => r.reason), ["review findings", "security finding"]);
  assert.equal(v.cards[0].rework_reason, "security finding", "the card keeps the latest reason as before");
});

test("findings appearing set Rework; going back to build sets it; landing or live clears it; a `rework` the probe sends is never believed", async () => {
  const db = await fresh();
  await read(db, NOW, rd("checker"));
  await read(db, NOW + MIN, rd("checker", { findings: ["checker"] }));
  assert.equal((await ev(db)).rework, true, "findings appeared");
  // Landed: no more waiting for a reason.
  await read(db, NOW + 2 * MIN, rd("ship", { headSha12: B, onMain: true }));
  assert.equal((await ev(db)).rework, undefined, "on main clears it");
  // Back to build from a review phase.
  const db2 = await fresh();
  await read(db2, NOW, rd("security", { signed: ["checker"] }));
  await read(db2, NOW + MIN, rd("build"));
  assert.equal((await ev(db2)).rework, true, "the card went back to build");
  await read(db2, NOW + 2 * MIN, rd("live", { onMain: true, headSha12: B }));
  assert.equal((await ev(db2)).rework, undefined, "live clears it");
  // The probe cannot send the flag.
  const db3 = await fresh();
  await read(db3, NOW, rd("checker", { rework: true }));
  assert.equal((await ev(db3)).rework, undefined);
  assert.equal((await updateCard(db3, NOW + MIN, "Manager", { id: "a-card", next_note: "ok" })).ok, true);
});

test("a reason written when there is no rework is kept in the history too, and a bad reason is refused as before", async () => {
  const db = await fresh();
  assert.equal((await updateCard(db, NOW, "Builder", { id: "a-card", rework_reason: "design change" })).ok, true);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM rework_history").first()).n, 1);
  const bad = await updateCard(db, NOW + MIN, "Builder", { id: "a-card", rework_reason: "because" });
  assert.equal(bad.refused.rule, "rework-reason");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM rework_history").first()).n, 1, "a refused reason leaves no row");
  // Clearing the reason (null) writes no history row.
  assert.equal((await updateCard(db, NOW + 2 * MIN, "Builder", { id: "a-card", rework_reason: null })).ok, false);
});
