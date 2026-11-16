// #C1114 part 1: a card's counters are read from the review notes. The probe counts each FINDINGS or RISKS note's items by kind (collector/findings-count.mjs);
// the Worker raises the card's issues to those counts and never lowers them (raisedIssues, writeEvidence).
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { itemsIn, countFindings } from "../collector/findings-count.mjs";
import { raisedIssues } from "../worker/board-rules.mjs";
import { createCard, updateCard, writeEvidence } from "../worker/board-store.mjs";

const NOW = 1_800_000_000_000;
const TWO = "FINDINGS Full #C1 a-card abc\nF1 LOW scripts/a.mjs:1 one thing.\nF2 MEDIUM scripts/b.mjs:2 another.\nChecked and fine: the rest.";

test("a note with 2 items counts 2; a note with no item lines counts 1; a PASS or SECURE note counts 0", () => {
  assert.equal(itemsIn(TWO), 2);
  assert.equal(itemsIn("FINDINGS Quick: it is wrong somewhere"), 1);
  assert.equal(itemsIn("RISKS Full\nR1 MEDIUM x\nR2 LOW y\nR3 LOW z"), 3);
  assert.equal(itemsIn("PASS Full #C1: F1 fixed, F2 fixed"), 0);
  assert.equal(itemsIn("SECURE #C1 abc"), 0);
  assert.equal(itemsIn(undefined), 0);
});

test("the checker's findings are bugs, Security's are security, language and design by their phase; an unknown phase counts nothing", () => {
  assert.deepEqual(countFindings([["checker", TWO]]), { bugs: 2 });
  assert.deepEqual(countFindings([["security", "RISKS Full\nR1 LOW x"]]), { security: 1 });
  assert.deepEqual(countFindings([["language", "FINDINGS\nL1 a"], ["design", "FINDINGS\nD1 a\nD2 b"]]), { language: 1, design: 2 });
  assert.deepEqual(countFindings([["ship", TWO]]), {});
  assert.deepEqual(countFindings([["checker", "PASS Full"]]), {});
});

test("the same note on every commit of a stack is one finding; a second round with other words adds to the first", () => {
  assert.deepEqual(countFindings([["checker", TWO], ["checker", TWO], ["checker", TWO]]), { bugs: 2 });
  assert.deepEqual(countFindings([["checker", TWO], ["checker", "FINDINGS\nF1 LOW again"]]), { bugs: 3 });
});

test("raisedIssues: raises to the read number, never lowers, null when nothing rises, owner untouched", () => {
  assert.deepEqual(raisedIssues(null, { bugs: 2 }), { bugs: 2 });
  assert.deepEqual(raisedIssues({ bugs: 1, owner: 3 }, { bugs: 2, security: 1 }), { bugs: 2, owner: 3, security: 1 });
  assert.equal(raisedIssues({ bugs: 2 }, { bugs: 2 }), null, "the same reading again changes nothing");
  assert.equal(raisedIssues({ bugs: 5 }, { bugs: 2 }), null, "a smaller reading never lowers");
  assert.equal(raisedIssues({ bugs: 2 }, {}), null);
  assert.equal(raisedIssues({ bugs: 2 }, undefined), null);
  assert.equal(raisedIssues(null, { bugs: 0, security: 100, design: 1.5, owner: 4 }), null, "out-of-range counts and owner are ignored");
});

const rd = (extra = {}) => ({ lit: ["checker"], phase: "checker", headSha12: "aaaaaaaaaaaa", signed: [], onMain: false, ...extra });
const issuesOf = async (db) => { const r = await db.prepare("SELECT issues FROM cards WHERE id = 'a-card'").first(); return r.issues ? JSON.parse(r.issues) : null; };

test("a reading with issueCounts fills the card's counters; the same reading again, a smaller one and a later PASS reading leave them; a bigger one raises them", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "a-card", title: "A card", owner_role: "Builder" });
  assert.equal(await issuesOf(db), null);
  assert.equal((await writeEvidence(db, NOW + 1e3, "probe", "cards.a-card", rd({ findings: ["checker"], issueCounts: { bugs: 2 } }))).ok, true);
  assert.deepEqual(await issuesOf(db), { bugs: 2 });
  await writeEvidence(db, NOW + 2e3, "probe", "cards.a-card", rd({ findings: ["checker"], issueCounts: { bugs: 2 } }));
  assert.deepEqual(await issuesOf(db), { bugs: 2 }, "re-reading the same note does not double-count");
  await writeEvidence(db, NOW + 3e3, "probe", "cards.a-card", rd({ headSha12: "bbbbbbbbbbbb", signed: ["checker"], issueCounts: { bugs: 2 } }));
  assert.deepEqual(await issuesOf(db), { bugs: 2 }, "a later PASS never lowers them");
  await writeEvidence(db, NOW + 4e3, "probe", "cards.a-card", rd({ headSha12: "cccccccccccc", issueCounts: { bugs: 3, security: 1 } }));
  assert.deepEqual(await issuesOf(db), { bugs: 3, security: 1 });
});

test("a typed counter above the read one stays; owner stays; a reading without counts changes nothing", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "a-card", title: "A card", owner_role: "Builder", issues: { bugs: 4, owner: 1 } });
  await writeEvidence(db, NOW + 1e3, "probe", "cards.a-card", rd({ issueCounts: { bugs: 2, design: 1 } }));
  assert.deepEqual(await issuesOf(db), { bugs: 4, owner: 1, design: 1 });
  await writeEvidence(db, NOW + 2e3, "probe", "cards.a-card", rd({}));
  assert.deepEqual(await issuesOf(db), { bugs: 4, owner: 1, design: 1 });
  assert.equal((await updateCard(db, NOW + 3e3, "Manager", { id: "a-card", issues: { bugs: 0 } })).ok, true, "a hand write still sets it (the card's own words stay the lead's)");
});
