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
  assert.equal(e.rework, true, "findings are a rework that needs its reason, as before");
  assert.equal(e.actual, undefined);
});
