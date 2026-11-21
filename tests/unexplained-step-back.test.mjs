// #C1114 part 2: a step back needs a reason. A card read at a review phase and then at plan, build or test with no FINDINGS note and no reason does not move: the
// Worker keeps its review reading, marks it rework "unexplained", and moves it on once a reason is attached. Each accepted reason adds 1 to its counter, once.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { unexplainedStepBack, REWORK_REASONS, REASON_COUNTER } from "../worker/board-rules.mjs";
import { createCard, updateCard, writeEvidence } from "../worker/board-store.mjs";

const NOW = 1_800_000_000_000, A = "aaaaaaaaaaaa", B = "bbbbbbbbbbbb", C = "cccccccccccc";
const rd = (phase, extra = {}) => ({ lit: [phase], phase, headSha12: A, signed: [], onMain: false, ...extra });

test("the reasons: one list with wording added; five bump a counter and review findings bumps none", () => {
  assert.ok(REWORK_REASONS.includes("wording"));
  assert.deepEqual(REASON_COUNTER, { "bug found in test": "bugs", "security finding": "security", "design change": "design", wording: "language", "owner change": "owner" });
  assert.equal(REASON_COUNTER["review findings"], undefined);
  for (const k of Object.keys(REASON_COUNTER)) assert.ok(REWORK_REASONS.includes(k), k);
});

test("the rule: a step back from a review phase with no findings and no reason; not a WIP push, a first push, findings, a reason given for that head, main or live", () => {
  for (const p of ["language", "design", "checker", "security", "ship"]) for (const to of ["plan", "build", "test"]) assert.equal(unexplainedStepBack(rd(p), rd(to, { headSha12: B })), true, `${p} -> ${to}`);
  assert.equal(unexplainedStepBack(rd("build"), rd("build", { headSha12: B })), false, "a WIP push before READY moves nothing (#C1066)");
  assert.equal(unexplainedStepBack(rd("build"), rd("checker", { headSha12: B })), false, "forward");
  assert.equal(unexplainedStepBack(rd("checker", { findings: ["checker"] }), rd("build", { headSha12: B })), false, "a FINDINGS note explains it");
  assert.equal(unexplainedStepBack(rd("checker", { reasoned: B }), rd("build", { headSha12: B })), false, "a reason was given for that head");
  assert.equal(unexplainedStepBack(rd("checker", { reasoned: B }), rd("build", { headSha12: C })), true, "not for another head");
  assert.equal(unexplainedStepBack(null, rd("build")), false, "the first reading");
  assert.equal(unexplainedStepBack(rd("checker", { headSha12: "" }), rd("build")), false, "nothing pushed before");
  assert.equal(unexplainedStepBack(rd("ship", { onMain: true }), rd("build", { headSha12: B })), false, "a landed card's next commit is another card's work");
  assert.equal(unexplainedStepBack(rd("checker"), rd("live", { headSha12: B })), false);
});

const fresh = async () => { const db = makeDb(); await createCard(db, NOW, "Manager", { id: "a-card", title: "A card", owner_role: "Builder" }); return db; };
const ev = async (db) => JSON.parse((await db.prepare("SELECT value FROM evidence WHERE key = 'cards.a-card'").first()).value);
const read = (db, at, r) => writeEvidence(db, at, "probe", "cards.a-card", r);
const issues = async (db) => { const r = await db.prepare("SELECT issues FROM cards WHERE id = 'a-card'").first(); return r.issues ? JSON.parse(r.issues) : null; };
const phaseRows = async (db) => (await db.prepare("SELECT phase, kind FROM phase_history WHERE card_id = 'a-card' AND wait IS NULL ORDER BY at, id").all()).results.map((r) => `${r.phase}:${r.kind}`);

test("a step back with no reason keeps the review reading, marks it unexplained, and writes no history; other writes stay open", async () => {
  const db = await fresh();
  await read(db, NOW, rd("checker"));
  const before = await phaseRows(db);
  await read(db, NOW + 60e3, rd("build", { headSha12: B }));
  const e = await ev(db);
  assert.deepEqual(e.lit, ["checker"], "the card did not move back");
  assert.equal(e.rework, "unexplained");
  assert.equal(e.reworkAt, NOW + 60e3);
  assert.deepEqual(e.actual, { headSha12: B, phase: "build" });
  assert.deepEqual(await phaseRows(db), before, "no phase row for a move that did not happen");
  await read(db, NOW + 120e3, rd("build", { headSha12: B }));
  assert.equal((await ev(db)).reworkAt, NOW + 60e3, "held again: the time it began is kept");
  assert.equal((await updateCard(db, NOW + 130e3, "Builder", { id: "a-card", next_note: "working on it" })).ok, true, "an unexplained step back blocks no other write");
});

// Checker 2's M1 on a7bd1ff5: the wake asks the reviewer to write the FINDINGS note on the held head (A); the probe's reading of the new tip (B) has no `findings` of its own,
// but counts that note in issueCounts. That rise ends the hold; before the fix the chip stayed, the card stayed at review and the reviewer kept a turn already done.
test("the hold ends when the reviewer's finding on the held head is counted: the card moves back and asks for the reason in the usual way", async () => {
  assert.equal(unexplainedStepBack(rd("checker", { rework: "unexplained", reworkCounts: 0 }), rd("build", { headSha12: B, issueCounts: { bugs: 2 } })), false, "a rise above what the hold began with explains it");
  assert.equal(unexplainedStepBack(rd("checker", { rework: "unexplained", reworkCounts: 2 }), rd("build", { headSha12: B, issueCounts: { bugs: 2 } })), true, "no rise: still held");
  assert.equal(unexplainedStepBack(rd("checker", { rework: "unexplained" }), rd("build", { headSha12: B, issueCounts: { bugs: 1 } })), false, "a hold with no recorded count began at 0");
  assert.equal(unexplainedStepBack(rd("checker"), rd("build", { headSha12: B, issueCounts: { bugs: 2 } })), true, "a first hold is not ended by counts already there: the hold records them");
  const db = await fresh();
  await read(db, NOW, rd("checker"));
  await read(db, NOW + 60e3, rd("build", { headSha12: B }));
  assert.equal((await ev(db)).rework, "unexplained");
  assert.equal((await ev(db)).reworkCounts, 0);
  await read(db, NOW + 90e3, rd("build", { headSha12: B }));
  assert.equal((await ev(db)).rework, "unexplained", "nothing new: still held");
  await read(db, NOW + 120e3, rd("build", { headSha12: B, issueCounts: { bugs: 2 } }));
  const e = await ev(db);
  assert.equal(e.rework, true, "the card is in rework now, with no reason yet: its owner is asked for one");
  assert.deepEqual(e.lit, ["build"], "and it is at build");
  assert.equal(e.reworkCounts, undefined);
  assert.equal(e.actual, undefined);
  assert.deepEqual(await issues(db), { bugs: 2 }, "the counters filled from the note");
  assert.ok((await phaseRows(db)).includes("build:start"));
  // a hold that began with counts already on the reading is not ended by those same counts, only by a rise above them
  const db2 = await fresh();
  await read(db2, NOW, rd("checker"));
  await read(db2, NOW + 60e3, rd("build", { headSha12: B, issueCounts: { bugs: 2 } }));
  assert.equal((await ev(db2)).rework, "unexplained");
  assert.equal((await ev(db2)).reworkCounts, 2, "the hold records the counts it began with");
  await read(db2, NOW + 90e3, rd("build", { headSha12: B, issueCounts: { bugs: 2 } }));
  assert.equal((await ev(db2)).rework, "unexplained", "the same counts: still held");
  await read(db2, NOW + 100e3, rd("build", { headSha12: B, issueCounts: { bugs: 1 } }));
  assert.equal((await ev(db2)).reworkCounts, 2, "the count the hold began with is kept, not lowered by a later reading");
  await read(db2, NOW + 110e3, rd("build", { headSha12: B, issueCounts: { bugs: 2 } }));
  assert.equal((await ev(db2)).rework, "unexplained", "back to the same counts: still held, not a rise");
  await read(db2, NOW + 120e3, rd("build", { headSha12: B, issueCounts: { bugs: 3 } }));
  assert.equal((await ev(db2)).rework, true, "a rise ends it");
});

test("a reason attached lets the next reading at that head move the card back, adds 1 to its counter once, and asks for no second reason", async () => {
  const db = await fresh();
  await read(db, NOW, rd("checker"));
  await read(db, NOW + 60e3, rd("build", { headSha12: B }));
  assert.equal((await updateCard(db, NOW + 70e3, "Builder", { id: "a-card", rework_reason: "bug found in test" })).ok, true);
  assert.deepEqual(await issues(db), { bugs: 1 });
  let e = await ev(db);
  assert.equal(e.rework, undefined);
  assert.equal(e.reasoned, B);
  assert.equal(e.actual, undefined);
  assert.deepEqual(e.lit, ["checker"]);
  assert.equal((await updateCard(db, NOW + 71e3, "Builder", { id: "a-card", rework_reason: "bug found in test" })).ok, true);
  assert.deepEqual(await issues(db), { bugs: 1 }, "the same reason written again adds nothing: its flag is gone");
  await read(db, NOW + 120e3, rd("build", { headSha12: B }));
  e = await ev(db);
  assert.deepEqual(e.lit, ["build"], "the card moves back now");
  assert.equal(e.rework, undefined, "the reason is already on file: no second one is asked for");
  assert.equal(e.reasoned, undefined);
  assert.ok((await phaseRows(db)).includes("build:start"));
});

test("each reason bumps its own counter; review findings and a reason on no rework bump none", async () => {
  for (const [reason, kind] of [["bug found in test", "bugs"], ["security finding", "security"], ["design change", "design"], ["wording", "language"], ["owner change", "owner"]]) {
    const db = await fresh();
    await read(db, NOW, rd("checker"));
    await read(db, NOW + 60e3, rd("build", { headSha12: B }));
    await updateCard(db, NOW + 70e3, "Builder", { id: "a-card", rework_reason: reason });
    assert.deepEqual(await issues(db), { [kind]: 1 }, reason);
  }
  const db = await fresh();
  await read(db, NOW, rd("checker"));
  await read(db, NOW + 60e3, rd("build", { headSha12: B }));
  await updateCard(db, NOW + 70e3, "Builder", { id: "a-card", rework_reason: "review findings" });
  assert.equal(await issues(db), null, "review findings: the notes count those");
  const db2 = await fresh();
  await read(db2, NOW, rd("build"));
  await updateCard(db2, NOW + 1e3, "Builder", { id: "a-card", rework_reason: "bug found in test" });
  assert.equal(await issues(db2), null, "a reason on a card with no rework waiting for one adds nothing");
});

test("a reason on a rework the probe saw through FINDINGS bumps its counter once too, and a typed counter stays", async () => {
  const db = await fresh();
  await createCard(db, NOW, "Manager", { id: "b-card", title: "B", owner_role: "Builder", issues: { bugs: 2 } });
  await writeEvidence(db, NOW, "probe", "cards.b-card", rd("checker"));
  await writeEvidence(db, NOW + 60e3, "probe", "cards.b-card", rd("checker", { findings: ["checker"] }));
  // #C1406 restated: findings alone set no flag; the rework is the builder's new tip, still in build (it was read at checker).
  assert.equal((JSON.parse((await db.prepare("SELECT value FROM evidence WHERE key = 'cards.b-card'").first()).value)).rework, undefined, "findings set no flag");
  await writeEvidence(db, NOW + 65e3, "probe", "cards.b-card", rd("build", { headSha12: B }));
  assert.equal((JSON.parse((await db.prepare("SELECT value FROM evidence WHERE key = 'cards.b-card'").first()).value)).rework, true);
  await updateCard(db, NOW + 70e3, "Builder", { id: "b-card", rework_reason: "bug found in test" });
  assert.deepEqual(JSON.parse((await db.prepare("SELECT issues FROM cards WHERE id = 'b-card'").first()).issues), { bugs: 3 });
});

test("a reading that returns to a review phase (the reviewer filed findings) releases the hold and the normal rework rules take over", async () => {
  const db = await fresh();
  await read(db, NOW, rd("checker"));
  await read(db, NOW + 60e3, rd("build", { headSha12: B }));
  await read(db, NOW + 120e3, rd("checker", { headSha12: B, findings: ["checker"] }));
  const e = await ev(db);
  assert.deepEqual(e.lit, ["checker"]);
  assert.equal(e.rework, undefined, "findings set no flag (#C1406 restated: the reading says findings from git, the owner's turn needs no hand step)");
  assert.equal(e.actual, undefined);
});

// Checker 2's L1 on a7bd1ff5: migration 0036 on a database that already holds rows (the other tests run it on an empty one).
test("migration 0036 on a filled database keeps the cards, their reasons, the history rows and their ids and index; 'wording' is refused before and accepted after", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("../worker/migrations/", import.meta.url);
  const files = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys = ON");
  for (const f of files.filter((n) => n < "0036")) sql.exec(readFileSync(new URL(f, dir), "utf8"));
  sql.exec("INSERT INTO cards (id, num, title, rework_reason, created_at, updated_at) VALUES ('c1', 1, 'One', 'bug found in test', 1, 1), ('c2', 2, 'Two', NULL, 1, 1)");
  sql.exec("INSERT INTO rework_history (card_id, reason, at, who) VALUES ('c1', 'bug found in test', 10, 'Builder'), ('c1', 'review findings', 20, NULL)");
  assert.throws(() => sql.exec("INSERT INTO rework_history (card_id, reason, at) VALUES ('c1', 'wording', 30)"), /CHECK|constraint/i, "refused before");
  for (const f of files.filter((n) => n.startsWith("0036"))) sql.exec(readFileSync(new URL(f, dir), "utf8"));
  assert.deepEqual(sql.prepare("SELECT id, rework_reason FROM cards ORDER BY num").all().map((r) => ({ ...r })), [{ id: "c1", rework_reason: "bug found in test" }, { id: "c2", rework_reason: null }]);
  assert.deepEqual(sql.prepare("SELECT id, card_id, reason, at, who FROM rework_history ORDER BY id").all().map((r) => ({ ...r })), [{ id: 1, card_id: "c1", reason: "bug found in test", at: 10, who: "Builder" }, { id: 2, card_id: "c1", reason: "review findings", at: 20, who: null }], "rows and ids kept");
  assert.equal(sql.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'rework_history_card'").all().length, 1, "the index is kept");
  sql.exec("INSERT INTO rework_history (card_id, reason, at) VALUES ('c1', 'wording', 30)");
  assert.equal(sql.prepare("SELECT id FROM rework_history WHERE reason = 'wording'").get().id, 3, "the next id follows the old ones");
  sql.exec("UPDATE cards SET rework_reason = 'wording' WHERE id = 'c2'");
  assert.equal(sql.prepare("SELECT rework_reason FROM cards WHERE id = 'c2'").get().rework_reason, "wording", "accepted after");
});
