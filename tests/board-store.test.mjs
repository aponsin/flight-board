import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { mint, createCard, updateCard, createAsk, answerAsk, closeAsk, createListItem, updateListItem, writeEvidence, readView } from "../worker/board-store.mjs";

const NOW = 1_800_000_000_000;
const refusals = async (db) => (await db.prepare("SELECT rule, card_id, who FROM refusals ORDER BY id").all()).results;
const decision = { type: "Decision", title: "Pick", asked_by: "Manager", question: "A or B?", options: ["A", "B"], recommended: "A" };

test("a Later ask keeps its steps and expect, and the page's waiting doc carries them (#C747)", async () => {
  const db = makeDb();
  const r = await createAsk(db, NOW, { type: "Later", title: "L", asked_by: "Manager", text: "t", eta_at: NOW + 86_400_000, steps: ["one", { text: "two", cmd: "ls" }], expect: "all green" });
  assert.equal(r.ok, true);
  const { waitingDoc } = await import("../worker/compat-view.mjs");
  const row = (await db.prepare("SELECT * FROM asks WHERE id = ?").bind(r.id).all()).results[0];
  const doc = waitingDoc(row);
  assert.deepEqual(doc.steps, ["one", { text: "two", cmd: "ls" }]);
  assert.equal(doc.expect, "all green");
  assert.equal(doc.kind, "later");
});

test("a card carries the review-skip words (customer_text, look_change, skip): written, read back, changed, and a bad value is refused", async () => {
  const db = makeDb();
  assert.equal((await createCard(db, NOW, "Manager", { id: "c-one", title: "One", customer_text: false, look_change: true, skip: ["security"] })).ok, true);
  assert.equal((await createCard(db, NOW, "Manager", { id: "c-two", title: "Two" })).ok, true);
  const view = async () => Object.fromEntries((await readView(db, NOW)).cards.map((c) => [c.id, [c.customer_text, c.look_change, c.skip]]));
  assert.deepEqual(await view(), { "c-one": [0, 1, '["security"]'], "c-two": [null, null, null] });
  assert.equal((await updateCard(db, NOW, "Manager", { id: "c-two", customer_text: true, skip: ["language", "design"] })).changed, 2);
  assert.deepEqual((await view())["c-two"], [1, null, '["language","design"]']);
  assert.equal((await createCard(db, NOW, "Manager", { id: "c-three", title: "Three", customer_text: "no" })).refused.rule, "card-flag");
  assert.equal((await createCard(db, NOW, "Manager", { id: "c-three", title: "Three", skip: ["Lunch Break"] })).refused.rule, "card-skip");
  assert.equal((await createCard(db, NOW, "Manager", { id: "c-three", title: "Three", skip: Array(17).fill("look") })).refused.rule, "card-skip");
  assert.equal((await createCard(db, NOW, "Manager", { id: "c-four", title: "Four", skip: ["plan", "language", "look"] })).ok, true, "an old card's skip words are kept as they are");
  assert.equal((await createCard(db, NOW, "Manager", { id: "c-three", title: "Three", skip: "security" })).refused.rule, "card-skip");
});

test("closing an ask: an open Later closes, a Decision only after it is answered, a second close and an unknown id are refused and logged; nothing is deleted", async () => {
  const db = makeDb();
  const later = await createAsk(db, NOW, { type: "Later", title: "L", asked_by: "Manager", text: "t", eta_at: NOW + 86_400_000 });
  const dec = await createAsk(db, NOW, { ...decision, title: "D" });
  assert.deepEqual(await closeAsk(db, NOW + 1, "Manager", later.id), { ok: true, id: later.id });
  assert.equal((await closeAsk(db, NOW + 2, "Manager", later.id)).refused.rule, "ask-already-closed");
  assert.equal((await closeAsk(db, NOW + 2, "Manager", dec.id)).refused.rule, "close-unanswered");
  assert.equal((await closeAsk(db, NOW + 2, "Manager", "t999")).refused.rule, "ask-unknown");
  await answerAsk(db, NOW + 3, "owner", { id: dec.id, answer: "A" });
  assert.equal((await closeAsk(db, NOW + 4, "Manager", dec.id)).ok, true);
  const asks = (await readView(db, NOW + 5)).asks;
  assert.deepEqual(asks.map((a) => [a.id, a.closed_at, a.closed_by]), [[later.id, NOW + 1, "Manager"], [dec.id, NOW + 4, "Manager"]], "both rows are still there, closed, with who closed them");
});

test("only the owner or the asking agent closes an ask: another agent is refused and the refusal is logged (Checker on v10)", async () => {
  const db = makeDb();
  const act = await createAsk(db, NOW, { type: "Action", title: "Rotate the key", asked_by: "Manager", steps: ["rotate"], expect: "done" });
  const r = await closeAsk(db, NOW + 1, "Builder", act.id);
  assert.equal(r.refused.rule, "close-not-yours");
  assert.deepEqual(await refusals(db), [{ rule: "close-not-yours", card_id: null, who: "Builder" }]);
  assert.equal((await readView(db, NOW + 2)).asks[0].closed_at, null, "still open");
  assert.equal((await closeAsk(db, NOW + 3, "owner", act.id, "owner")).ok, true);
  assert.equal((await readView(db, NOW + 4)).asks[0].closed_by, "owner");
});

test("list rows: words only, a bad word is refused and logged, done stamps done_at once and reopening clears it", async () => {
  const db = makeDb();
  const a = await createListItem(db, NOW, "owner", { kind: "todo", text: "One", area: "Search", rank: 3 });
  assert.equal(a.ok, true);
  for (const [f, rule] of [[{ kind: "todo", text: "" }, "list-text"], [{ kind: "todo", text: "x", rank: -1 }, "list-rank"], [{ kind: "todo", text: "x", done: "yes" }, "list-done"], [{ kind: "todo", text: "x", eta_at: 5 }, "unknown-field"], [{ kind: "todo", text: "x", id: "mine" }, "list-id"], [{ kind: "todo", text: "x".repeat(2001) }, "list-text"]]) {
    assert.equal((await createListItem(db, NOW, "Manager", f)).refused.rule, rule, rule);
  }
  assert.equal((await updateListItem(db, NOW + 1, "owner", { id: a.id, done: true })).changed, 1);
  assert.equal((await updateListItem(db, NOW + 2, "owner", { id: a.id, done: true })).ok, true);
  const row = async () => (await readView(db, NOW + 9)).lists[0];
  assert.deepEqual([(await row()).done, (await row()).done_at], [1, NOW + 1], "the second done leaves done_at as it was");
  await updateListItem(db, NOW + 3, "owner", { id: a.id, done: false, note: "back" });
  assert.deepEqual([(await row()).done, (await row()).done_at, (await row()).note], [0, null, "back"]);
  assert.equal((await updateListItem(db, NOW, "owner", { id: "nope", done: true })).refused.rule, "list-unknown");
  assert.equal((await refusals(db)).length, 7);
});

test("a list row records who marked it done: the first marker stays, anyone may mark, reopening clears it, a row created done is stamped (Checker on v11)", async () => {
  const db = makeDb();
  const a = await createListItem(db, NOW, "owner", { kind: "todo", text: "One" });
  const row = async (id = a.id) => (await readView(db, NOW + 9)).lists.find((l) => l.id === id);
  assert.equal((await row()).done_by, null);
  assert.equal((await updateListItem(db, NOW + 1, "Manager", { id: a.id, done: true })).ok, true, "the lead marks to-dos done routinely");
  assert.deepEqual([(await row()).done_by, (await row()).done_at], ["Manager", NOW + 1]);
  await updateListItem(db, NOW + 2, "owner", { id: a.id, done: true });
  assert.equal((await row()).done_by, "Manager", "a second done does not take the record");
  await updateListItem(db, NOW + 3, "owner", { id: a.id, done: false });
  assert.deepEqual([(await row()).done_by, (await row()).done_at], [null, null]);
  await updateListItem(db, NOW + 4, "owner", { id: a.id, note: "edit only" });
  assert.equal((await row()).done_by, null, "an edit of the words leaves it alone");
  const b = await createListItem(db, NOW, "Builder", { kind: "idea", text: "Two", done: true });
  assert.deepEqual([(await row(b.id)).done_by, (await row(b.id)).done_at], ["Builder", NOW]);
});

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

test("the probe's own phase keys are accepted as lit phases, the language review's key included (the board config calls it language)", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "c-one", title: "One" });
  for (const phase of ["plan", "build", "test", "language", "design", "checker", "security", "ship", "live"]) assert.equal((await writeEvidence(db, NOW, "probe", "cards.c-one", { lit: [phase] })).ok, true, phase);
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

test("the store notices a silent probe: no evidence for 3 minutes shows the probe chip red, and no card goes stalled", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "c-one", title: "One" });
  await writeEvidence(db, NOW, "probe", "cards.c-one", { lit: ["build"] });
  assert.equal((await readView(db, NOW + 60_000)).probe.state, "ok");
  const quiet = await readView(db, NOW + 3 * 60_000 + 1);
  assert.deepEqual([quiet.probe.state, quiet.probe.since], ["silent", NOW]);
  assert.ok(!JSON.stringify(quiet.cards).includes("stalled"), "silence is the probe's chip, not a card state");
  assert.notEqual(quiet.tag, (await readView(db, NOW + 60_000)).tag, "the page learns of it");
  // a timed-out run's own report is not a heartbeat
  await writeEvidence(db, NOW + 4 * 60_000, "probe", "run.timeout", { step: "x" });
  assert.equal((await readView(db, NOW + 4 * 60_000 + 1)).probe.state, "silent");
  // a good reading brings it back
  await writeEvidence(db, NOW + 5 * 60_000, "probe", "cards.c-one", { lit: ["build"] });
  assert.equal((await readView(db, NOW + 5 * 60_000 + 1)).probe.state, "ok");
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
