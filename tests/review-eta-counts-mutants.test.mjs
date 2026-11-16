// #C1115 part 2 (11-16: G6 was due about 1:20 pm and missed it by more than an hour: Checker 2 ran 30 mutants, each against the whole suite, and the ETA never counted them):
// the claim carries the mutant count (and the seconds one takes, and a progress line); the review's ETA adds count x seconds; a review 30 minutes past its ETA wakes Manager
// with the reviewer's progress line, once per spell.
import test from "node:test";
import assert from "node:assert/strict";
import { drawPage } from "./helpers/draw-page.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { reviewExtraMs, reviewEtaAt, reviewLateWakes, reviewClaimRefusal, SLOW_ROW_END, ORDER_ROW_END, STALL_LIKE_MARKS, REVIEW_LATE_MARK, MUTANT_SEC_DEFAULT, REVIEW_LATE_MS, REVIEW_BASE_DEFAULT_MS } from "../worker/board-rules.mjs";
import { initiativeDoc, compatView } from "../worker/compat-view.mjs";
import { createCard, writeEvidence, claimReview, releaseReview, readView } from "../worker/board-store.mjs";
import { beat, wakeAsk, takeInbox } from "./helpers/beating-store.mjs";

const H = 3600e3, MIN = 60e3, NOW = 1_800_000_000_000, T = 1_800_000_000_000;
const SHA = "a".repeat(40), SHA12 = "a".repeat(12);

const page = () => drawPage({ initiatives: [] }, { host: null, expose: ["phaseMedians", "derivedEta", "PHASES", "BUILD_PHASE"] }).b;
function done(b, id, hours) {
  const phases = b.PHASES.map((p) => p[0]).filter((k) => k !== "live"), log = []; let t = NOW - 24 * H - phases.length * hours * H;
  for (const k of phases) { log.push({ phase: k, who: "x", start: t, end: t + hours * H }); t += hours * H; }
  return { id, size: "S", status: "done", doneAt: t, phaseLog: log };
}

test("the page: a review with 30 mutants is due later than one with 3, by the seconds each takes; with none given it is 150 s each; no mutants, the median as before", () => {
  const b = page(), cards = [done(b, "d1", 0.5), done(b, "d2", 0.5), done(b, "d3", 0.5)], med = b.phaseMedians(cards);
  const at = (extra) => b.derivedEta({ id: "x", size: "S", status: "active", phase: "checker", phaseLog: [{ phase: "checker", who: "Checker", start: NOW - MIN }], ...extra }, med, NOW);
  const none = at({}), three = at({ reviewMutants: 3 }), thirty = at({ reviewMutants: 30 });
  assert.ok(thirty > three && three > none, "30 mutants is later than 3, which is later than none");
  assert.equal(thirty - three, 27 * MUTANT_SEC_DEFAULT * 1000, "27 more mutants at 150 s each");
  assert.equal(at({ reviewMutants: 30, mutantSec: 60 }) - none, 30 * 60e3, "the measured time per mutant is used when the claim gives it");
  assert.equal(at({ reviewMutants: 0 }), none);
  assert.equal(at({ reviewMutants: 1 }) - none, MUTANT_SEC_DEFAULT * 1000, "one mutant counts too");
  assert.equal(at({ reviewMutants: "30" }), none, "only a whole number counts");
  // only the checker review: a card at another phase is not moved by a mutant count
  const sec = (extra) => b.derivedEta({ id: "y", size: "S", status: "active", phase: "security", phaseLog: [{ phase: "security", who: "Security", start: NOW - MIN }], ...extra }, med, NOW);
  assert.equal(sec({ reviewMutants: 30 }), sec({}));
});

test("the rules: the extra time is count x seconds, the ETA is the claim plus the checker median plus that, and a missing median reads 30 minutes", () => {
  assert.equal(reviewExtraMs({ mutants: 30 }), 30 * 150e3);
  assert.equal(reviewExtraMs({ mutants: 30, mutant_sec: 60 }), 30 * 60e3);
  assert.equal(reviewExtraMs({}), 0);
  assert.equal(reviewExtraMs({ mutants: -1 }), 0);
  assert.equal(reviewEtaAt({ claimed_at: T, mutants: 30 }, 20 * MIN), T + 20 * MIN + 30 * 150e3);
  assert.equal(reviewEtaAt({ claimed_at: T }, undefined), T + REVIEW_BASE_DEFAULT_MS);
});

const claim = (extra = {}) => ({ sha: SHA, card_id: "c", checker: "Checker 2", claimed_at: T, released_at: null, mutants: 30, mutant_sec: 150, progress: "mutant 12 of 30, 2 survivors being re-run", progress_at: T + 40 * MIN, ...extra });
const card = { id: "c", num: 1106 };
const wakes = (now, over = {}) => reviewLateWakes({ now, claims: [claim()], cards: [card], evidence: { c: { phase: "checker", lit: ["checker"] } }, medians: { checker: 20 * MIN }, ...over });

test("a review 30 minutes past its ETA wakes Manager with the reviewer's progress line; before that, nothing", () => {
  const eta = T + 20 * MIN + 30 * 150e3; // 20 min + 75 min
  assert.deepEqual(wakes(eta), [], "at the ETA");
  assert.deepEqual(wakes(eta + REVIEW_LATE_MS - 1000), [], "29 min 59 s past it");
  const w = wakes(eta + REVIEW_LATE_MS + 1000);
  assert.equal(w.length, 1);
  assert.equal(w[0].card_id, "c");
  assert.match(w[0].reason, /^#C1106 review by Checker 2 is over 30 min past its ETA, 30 mutants: mutant 12 of 30, 2 survivors being re-run$/);
  assert.equal(wakes(eta + REVIEW_LATE_MS + 5 * MIN)[0].reason, w[0].reason, "the words do not change from minute to minute: one row per spell");
  assert.deepEqual(wakes(T + 3 * H, { claims: [claim({ mutants: 3 })] }).map((x) => x.card_id), ["c"], "3 mutants: 20 min + 7.5 min + 30 min is long past by 3 h");
  assert.deepEqual(wakes(T + 100 * MIN, { claims: [claim({ mutants: 3 })] }).length, 1);
  assert.match(wakes(T + 3 * H, { claims: [claim({ progress: undefined })] })[0].reason, /no progress line$/);
});

test("a late review is named only for an open claim on a card still at the checker review; not once signed, released, closed, or in another phase; an outage does not count", () => {
  const late = T + 3 * H;
  assert.equal(wakes(late).length, 1);
  assert.deepEqual(wakes(late, { claims: [claim({ released_at: T + MIN })] }), [], "released");
  assert.deepEqual(wakes(late, { evidence: { c: { phase: "security", lit: ["security"] } } }), [], "the card moved on");
  assert.deepEqual(wakes(late, { cards: [{ ...card, done_at: T + MIN }] }), [], "closed");
  assert.deepEqual(wakes(late, { cards: [{ ...card, dropped: 1 }] }), [], "dropped");
  assert.deepEqual(wakes(late, { cards: [] }), [], "no such card");
  const eta = T + 20 * MIN + 30 * 150e3;
  assert.deepEqual(wakes(eta + REVIEW_LATE_MS + MIN, { outages: [{ start: eta + 5 * MIN, end: eta + 25 * MIN }] }), [], "20 of those minutes were a silent probe");
});

test("the claim's shape: mutants 0 to 200, mutant_sec 1 to 3600, progress one line of up to 160 characters; release takes none of them", () => {
  const ok = (b) => reviewClaimRefusal({ sha: SHA, ...b }, "Checker", "claim");
  assert.equal(ok({ mutants: 30, mutant_sec: 150, progress: "mutant 12 of 30" }), null);
  assert.equal(ok({}), null, "all optional");
  assert.equal(ok({ mutants: 201 })?.rule, "review-claim-shape");
  assert.equal(ok({ mutants: -1 })?.rule, "review-claim-shape");
  assert.equal(ok({ mutants: 2.5 })?.rule, "review-claim-shape");
  assert.equal(ok({ mutant_sec: 0 })?.rule, "review-claim-shape");
  assert.equal(ok({ mutant_sec: 3601 })?.rule, "review-claim-shape");
  assert.equal(ok({ progress: "a\nb" })?.rule, "review-claim-shape");
  assert.equal(ok({ progress: "x".repeat(161) })?.rule, "review-claim-shape");
  assert.equal(ok({ progress: 5 })?.rule, "review-claim-shape");
  assert.equal(ok({ progress: `stuck${SLOW_ROW_END}` })?.rule, "review-claim-shape", "a line ending as a slow row does would be deleted and re-added on every sync");
  assert.equal(ok({ progress: `x${REVIEW_LATE_MARK}` })?.rule, "review-claim-shape");
  // Security's LOW 1 reopened: SQLite's LIKE ignores ASCII case, so the match does too; and every cleanup's mark is in the one list, #C1103's ORDER_ROW_END included.
  assert.equal(ok({ progress: `x${SLOW_ROW_END.toUpperCase()}` })?.rule, "review-claim-shape", "upper case still matches the cleanup's LIKE");
  assert.equal(ok({ progress: `x${ORDER_ROW_END}` })?.rule, "review-claim-shape", "the group-order row's ending");
  assert.equal(ok({ progress: `x${ORDER_ROW_END.toUpperCase()}` })?.rule, "review-claim-shape");
  assert.equal(ok({ progress: `x${REVIEW_LATE_MARK.toUpperCase()}` })?.rule, "review-claim-shape");
  assert.deepEqual([...STALL_LIKE_MARKS].sort(), [ORDER_ROW_END, REVIEW_LATE_MARK, SLOW_ROW_END].sort(), "the list holds every LIKE mark");
  assert.equal(reviewClaimRefusal({ sha: SHA, mutants: 3 }, "Checker", "release")?.rule, "review-claim-shape");
});

async function world() {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "c", title: "A card", owner_role: "Boardsmith" });
  await beat(db, T);
  await writeEvidence(db, T, "probe", "cards.c", { lit: ["checker"], phase: "checker", headSha12: SHA12, signed: [], onMain: false });
  return db;
}
const claimRow = async (db) => db.prepare("SELECT mutants, mutant_sec, progress, progress_at, claimed_at FROM review_claims WHERE sha = ?").bind(SHA).first();

test("the store: a claim keeps its mutants and progress, a repeated claim updates them and keeps the time it was made, and the card shows the count to the page", async () => {
  const db = await world();
  assert.equal((await claimReview(db, T + MIN, "Checker", { sha: SHA, checker: "Checker 2", card_id: "c", mutants: 30, mutant_sec: 120 })).ok, true);
  let r = await claimRow(db);
  assert.deepEqual([r.mutants, r.mutant_sec, r.progress, r.claimed_at], [30, 120, null, T + MIN]);
  assert.equal((await claimReview(db, T + 20 * MIN, "Checker", { sha: SHA, checker: "Checker 2", progress: "mutant 8 of 30" })).ok, true);
  r = await claimRow(db);
  assert.deepEqual([r.mutants, r.mutant_sec, r.progress, r.progress_at, r.claimed_at], [30, 120, "mutant 8 of 30", T + 20 * MIN, T + MIN], "only the progress changed");
  const view = await readView(db, T + 21 * MIN);
  const c = view.cards.find((x) => x.id === "c");
  const doc = initiativeDoc(c, view.evidence["cards.c"], view.reviewClaims.find((x) => x.card_id === "c"));
  assert.equal(doc.reviewMutants, 30);
  assert.equal(doc.mutantSec, 120);
  assert.equal(initiativeDoc(c, view.evidence["cards.c"], undefined).reviewMutants, undefined);
  // Checker 2's M3: the page gets the count through compatView, which looks the claim up by card id (dropping that argument left every test green)
  const compat = compatView(view).collections.initiatives.find((i) => i.reviewMutants === 30);
  assert.ok(compat, "compatView carries the claim's mutant count to the card");
  assert.equal(compat.mutantSec, 120);
  assert.equal(compatView({ ...view, reviewClaims: [] }).collections.initiatives.filter((i) => i.reviewMutants !== undefined).length, 0, "no claim, no count");
  // a repeat with only the count keeps the progress line and its time
  assert.equal((await claimReview(db, T + 21 * MIN + 30e3, "Checker", { sha: SHA, checker: "Checker 2", mutants: 12 })).ok, true);
  r = await claimRow(db);
  assert.deepEqual([r.mutants, r.mutant_sec, r.progress, r.progress_at], [12, 120, "mutant 8 of 30", T + 20 * MIN], "only the count changed");
  // another checker cannot change it
  assert.equal((await claimReview(db, T + 22 * MIN, "Checker", { sha: SHA, checker: "Checker", progress: "mine" })).ok, false, "refused: Checker 2 has it");
  assert.equal((await claimRow(db)).progress, "mutant 8 of 30");
});

test("the store: 30 minutes past the ETA Manager's inbox gets the progress line once; a new progress line is a new wake; releasing the claim ends the spell", async () => {
  const db = await world();
  await claimReview(db, T + MIN, "Checker", { sha: SHA, checker: "Checker 2", card_id: "c", mutants: 4, mutant_sec: 60, progress: "mutant 1 of 4" });
  const lines = async (at) => (await takeInbox(db, at)).stalls.map((s) => s.reason).filter((r) => r.includes(" min past its ETA"));
  const keep = async (at) => { await beat(db, at - 1000); await wakeAsk(db, at); };
  // ETA = claim + 30 min (no median yet) + 4 min = T + 35 min; late from T + 65 min
  await keep(T + 60 * MIN);
  assert.deepEqual(await lines(T + 60 * MIN + 500), [], "not late yet");
  await keep(T + 70 * MIN);
  const first = await lines(T + 70 * MIN + 500);
  assert.equal(first.length, 1);
  assert.match(first[0], /^#C\d+ review by Checker 2 is over 30 min past its ETA, 4 mutants: mutant 1 of 4$/);
  const rows = async () => (await db.prepare("SELECT reason FROM stall_wakes WHERE reason LIKE '%min past its ETA%'").all()).results.map((r) => r.reason);
  await keep(T + 72 * MIN);
  assert.equal((await rows()).length, 1, "the same words: one row for the spell");
  await claimReview(db, T + 73 * MIN, "Checker", { sha: SHA, checker: "Checker 2", progress: "mutant 3 of 4" });
  await keep(T + 74 * MIN);
  assert.deepEqual(await rows(), [first[0].replace("mutant 1 of 4", "mutant 3 of 4")], "the old line's row went with the old words and the new line has its own");
  await releaseReview(db, T + 75 * MIN, "Checker", { sha: SHA, checker: "Checker 2" });
  await keep(T + 76 * MIN);
  assert.deepEqual(await rows(), [], "the review is released: the spell is over");
});
