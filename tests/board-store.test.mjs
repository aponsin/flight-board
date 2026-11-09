import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { mint, createCard, updateCard, createAsk, writeEvidence, readView } from "../worker/board-store.mjs";

const NOW = 1_800_000_000_000;
const refusals = async (db) => (await db.prepare("SELECT rule, card_id, who FROM refusals ORDER BY id").all()).results;
const decision = { type: "Decision", title: "Pick", asked_by: "Manager", question: "A or B?", options: ["A", "B"], recommended: "A" };

test("the store mints #C and #T numbers in order, separately", async () => {
  const db = makeDb();
  assert.deepEqual([await mint(db, "C"), await mint(db, "C"), await mint(db, "T")], [1, 2, 1]);
});

test("a card is created with a minted number; a duplicate id and a bad word are refused and logged", async () => {
  const db = makeDb();
  assert.deepEqual(await createCard(db, NOW, "Manager", { id: "c-one", title: "One" }), { ok: true, id: "c-one", num: 1 });
  assert.equal((await createCard(db, NOW, "Manager", { id: "c-one", title: "Again" })).refused.rule, "card-exists");
  assert.equal((await createCard(db, NOW, "Manager", { id: "c-two", title: "Two", status: "done" })).refused.rule, "only-probe-writes-status");
  assert.equal((await createCard(db, NOW, "Manager", { id: "c-two", title: "Two", colour: "red" })).refused.rule, "unknown-field");
  assert.deepEqual((await refusals(db)).map((r) => r.rule), ["card-exists", "only-probe-writes-status", "unknown-field"]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cards").first()).n, 1);
  // a refused write does not burn a number
  assert.equal((await createCard(db, NOW, "Manager", { id: "c-two", title: "Two" })).num, 2);
});

test("an ask missing a part is refused in the same call; a good one gets a #T number", async () => {
  const db = makeDb();
  const { recommended, ...bad } = decision;
  const r = await createAsk(db, NOW, bad);
  assert.equal(r.ok, false);
  assert.equal(r.refused.rule, "ask-missing-part");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM asks").first()).n, 0);
  const ok = await createAsk(db, NOW, decision);
  assert.deepEqual([ok.ok, ok.id, ok.num], [true, "t1", 1]);
  assert.equal((await createAsk(db, NOW, { type: "Later", title: "t", asked_by: "M", text: "x" })).refused.rule, "later-without-eta");
  assert.equal((await createAsk(db, NOW, { ...decision, card_id: "nope" })).refused.rule, "card-unknown");
});

test("only the probe writes evidence; one lit phase", async () => {
  const db = makeDb();
  assert.equal((await writeEvidence(db, NOW, "Manager", "cards.c-one", { lit: ["build"] })).refused.rule, "only-probe-writes-status");
  assert.equal((await writeEvidence(db, NOW, "probe", "cards.c-one", { lit: ["build", "test"] })).refused.rule, "one-lit-phase");
  assert.equal((await writeEvidence(db, NOW, "probe", "cards.c-one", { lit: ["build"] })).ok, true);
});

test("a typed word cannot contradict evidence: dropping a card the probe reads as live is refused", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "c-one", title: "One" });
  await writeEvidence(db, NOW, "probe", "cards.c-one", { lit: ["live"], phase: "live" });
  assert.equal((await updateCard(db, NOW, "Manager", { id: "c-one", dropped: true })).refused.rule, "contradicts-evidence");
  assert.equal((await updateCard(db, NOW, "Manager", { id: "c-one", summary: "ok" })).ok, true);
  assert.equal((await updateCard(db, NOW, "Manager", { id: "ghost", summary: "x" })).refused.rule, "card-unknown");
});

test("the view carries a tag that changes only when something shown changes, and Live now from the probe's reading", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "c-one", title: "One" });
  const a = await readView(db, NOW), b = await readView(db, NOW + 5000);
  assert.equal(a.tag, b.tag, "time passing alone does not change the tag");
  await writeEvidence(db, NOW, "probe", "live", { version: "1.2.3" });
  const c = await readView(db, NOW + 1000);
  assert.notEqual(c.tag, a.tag);
  assert.deepEqual([c.live.state, c.live.version], ["live", "1.2.3"]);
  const old = await readView(db, NOW + 4 * 60_000);
  assert.equal(old.live.state, "stale", "an old reading is stale, never live");
});
