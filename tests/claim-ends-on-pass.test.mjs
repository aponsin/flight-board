// #C1094 (11-16: Checker 2 hit the cap of 6 open claims, every one on a tip already signed, re-cut or landed, and Manager released 5 by hand): a review claim ends by
// itself when the probe reads the claimed tip with a Checker note, when it reads the tip on main (or the card is done), and, for the claimer's own claim, when the card's
// head has moved on since the claim.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { claimReview, writeEvidence, endClaims } from "../worker/board-store.mjs";
import { beat, wakeAsk } from "./helpers/beating-store.mjs";

const T = 1_800_000_000_000;
const sha = (c) => c.repeat(40);
const rd = (c, extra = {}) => ({ lit: ["review"], phase: "review", headSha12: sha(c).slice(0, 12), signed: [], onMain: false, ...extra });
const card = (db, id, num) => db.prepare("INSERT INTO cards (id, num, title, summary, track, created_at, updated_at) VALUES (?, ?, 'A', 's', 'board', 1, 1)").bind(id, num).run();
const open = async (db) => (await db.prepare("SELECT sha FROM review_claims WHERE released_at IS NULL ORDER BY sha").all()).results.map((r) => r.sha);
const why = async (db, c) => (await db.prepare("SELECT released_by FROM review_claims WHERE sha = ?").bind(sha(c)).first())?.released_by;
const read = async (db, at, id, c, extra) => { await beat(db, at); assert.equal((await writeEvidence(db, at, "probe", `cards.${id}`, rd(c, extra))).ok, true); };

test("a claim ends when the probe reads its tip with a Checker note, whoever claims next; a tip without one keeps its claim", async () => {
  const db = makeDb();
  await card(db, "a-card", 1); await card(db, "b-card", 2);
  await read(db, T, "a-card", "1"); await read(db, T, "b-card", "2");
  assert.equal((await claimReview(db, T + 1, "Checker", { sha: sha("1"), checker: "Checker 2", card_id: "a-card" })).ok, true);
  assert.equal((await claimReview(db, T + 2, "Checker", { sha: sha("2"), checker: "Checker 2", card_id: "b-card" })).ok, true);
  await read(db, T + 3000, "a-card", "1", { signed: ["Checker 2"] });
  assert.deepEqual(await open(db), [sha("2")], "the signed tip's claim is over at the reading, the unsigned one is not");
  assert.equal(await why(db, "1"), "signed");
});

test("findings by Checker end the claim too; a Security note alone does not", async () => {
  const db = makeDb();
  await card(db, "a-card", 1); await card(db, "b-card", 2);
  await read(db, T, "a-card", "1"); await read(db, T, "b-card", "2");
  await claimReview(db, T + 1, "Checker", { sha: sha("1"), checker: "Checker 2", card_id: "a-card" });
  await claimReview(db, T + 2, "Checker", { sha: sha("2"), checker: "Checker 2", card_id: "b-card" });
  await read(db, T + 3000, "a-card", "1", { findings: ["Checker 2: F1"] });
  await read(db, T + 4000, "b-card", "2", { signed: ["Security"] });
  assert.deepEqual(await open(db), [sha("2")]);
});

test("a claim on a tip the probe reads on main ends, and so does one on a done card", async () => {
  const db = makeDb();
  await card(db, "a-card", 1); await card(db, "b-card", 2); await card(db, "c-card", 3);
  for (const [id, c] of [["a-card", "1"], ["b-card", "2"], ["c-card", "3"]]) await read(db, T, id, c);
  for (const [id, c] of [["a-card", "1"], ["b-card", "2"], ["c-card", "3"]]) await claimReview(db, T + 1, "Checker", { sha: sha(c), checker: "Checker 2", card_id: id });
  await read(db, T + 3000, "a-card", "1", { onMain: true });
  await db.prepare("UPDATE cards SET done_at = 5 WHERE id = 'b-card'").run();
  assert.equal(await endClaims(db, T + 4000), 1, "the done card is swept by the next call");
  assert.deepEqual(await open(db), [sha("3")]);
  assert.equal(await why(db, "1"), "landed");
  assert.equal(await why(db, "2"), "landed");
});

test("the cap counts no ended claim: six claims, two ended by a signature, and the checker claims a seventh and eighth", async () => {
  const db = makeDb();
  const cs = ["1", "2", "3", "4", "5", "6", "7", "8"];
  for (const [i, c] of cs.entries()) { await card(db, `k-${c}`, 10 + i); await read(db, T, `k-${c}`, c); }
  for (const c of cs.slice(0, 6)) assert.equal((await claimReview(db, T + 1, "Checker", { sha: sha(c), checker: "Checker 2", card_id: `k-${c}` })).ok, true);
  assert.equal((await claimReview(db, T + 2, "Checker", { sha: sha("7"), checker: "Checker 2", card_id: "k-7" })).refused?.rule, "review-claim-cap");
  await read(db, T + 3000, "k-1", "1", { signed: ["Checker 2"] });
  await read(db, T + 3000, "k-2", "2", { onMain: true });
  assert.equal((await claimReview(db, T + 4000, "Checker", { sha: sha("7"), checker: "Checker 2", card_id: "k-7" })).ok, true);
  assert.equal((await claimReview(db, T + 4001, "Checker", { sha: sha("8"), checker: "Checker 2", card_id: "k-8" })).ok, true);
});

test("a claimer's own claim on a tip its card has left (read after the claim) ends at its next claim; another checker's does not, and the re-cut rule still holds", async () => {
  const db = makeDb();
  await card(db, "a-card", 1); await card(db, "b-card", 2);
  await read(db, T, "a-card", "1"); await read(db, T, "b-card", "3");
  await claimReview(db, T + 1, "Checker", { sha: sha("1"), checker: "Checker 2", card_id: "a-card" });
  await claimReview(db, T + 2, "Checker", { sha: sha("3"), checker: "Checker", card_id: "b-card" });
  await read(db, T + 3000, "a-card", "4"); // the card was re-cut: its head is now 4444
  await read(db, T + 3000, "b-card", "5"); // so was the other
  assert.deepEqual(await open(db), [sha("1"), sha("3")], "no claim call yet: a re-cut is not a pass, nothing ends by itself");
  assert.equal((await claimReview(db, T + 4000, "Checker", { sha: sha("6"), checker: "Checker 2", card_id: "x-card" })).ok, true);
  assert.deepEqual(await open(db), [sha("3"), sha("6")], "Checker 2's old claim is handed on; Checker's stays");
  assert.match(await why(db, "1"), /^superseded by 444444444444$/);
  const other = await claimReview(db, T + 5000, "Checker", { sha: sha("5"), checker: "Checker 2", card_id: "b-card" });
  assert.equal(other.refused?.rule, "review-claim-held", "Checker still holds b-card's old tip: Checker 2 may not take its re-cut");
});

test("the stall sync sweeps too: a claim on a card closed since (no reading, no claim call) is over once the board is asked what waits", async () => {
  const db = makeDb();
  await card(db, "a-card", 1);
  await read(db, T, "a-card", "1");
  await claimReview(db, T + 1, "Checker", { sha: sha("1"), checker: "Checker 2", card_id: "a-card" });
  await db.prepare("UPDATE cards SET done_at = ? WHERE id = 'a-card'").bind(T + 2).run();
  assert.deepEqual(await open(db), [sha("1")], "nothing has looked yet");
  await wakeAsk(db, T + 3000);
  assert.deepEqual(await open(db), []);
});

test("a claim made after the card's head was last read is not taken for a superseded one (the probe may be behind)", async () => {
  const db = makeDb();
  await card(db, "a-card", 1);
  await read(db, T, "a-card", "1");
  await claimReview(db, T + 5000, "Checker", { sha: sha("9"), checker: "Checker 2", card_id: "a-card" }); // a tip the probe has not read yet
  await claimReview(db, T + 6000, "Checker", { sha: sha("8"), checker: "Checker 2" });
  assert.deepEqual(await open(db), [sha("8"), sha("9")]);
});
