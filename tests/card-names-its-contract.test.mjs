// #C1169 (11-17: a card was carded against DATA.md:131 without checking it; the owner: a flight-board card must match the first-level principles): through the
// card_create and card_update TOOLS a flight-board card names what it touches (`contract`) and says whether it changes a definition (`changes_definition`);
// true needs from_thread, the owner's decision thread. A product card is untouched, and the store functions without the tools' option are as before.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { createCard, updateCard, createAsk } from "../worker/board-store.mjs";

const T = 1_800_000_000_000;
const OPTS = { needSummary: true, needGroup: true, needRepo: true, needContract: true };
const make = (db, f) => createCard(db, T, "Manager", { title: "A card", summary: "Build it, because it is needed.", batch: "g-test", repo: "flight-board", ...f }, OPTS);
const refusedAs = (r, rule) => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.refused?.rule, rule, JSON.stringify(r)); };
const decided = async (db) => { const ask = await createAsk(db, T, { type: "Answer", title: "A decision", asked_by: "Manager", question: "Change it?" }); assert.ok(ask.ok, JSON.stringify(ask)); return ask.num; };

test("a flight-board card without contract is refused; with contract and changes_definition false it is made, and both are stored", async () => {
  const db = makeDb();
  refusedAs(await make(db, { id: "c-none" }), "card-contract");
  refusedAs(await make(db, { id: "c-blank", contract: "   " }), "card-contract");
  refusedAs(await make(db, { id: "c-nodef", contract: "principle 1; DATA.md Stalled" }), "card-contract");
  refusedAs(await make(db, { id: "c-str", contract: "principle 1", changes_definition: "no" }), "card-flag");
  const ok = await make(db, { id: "c-ok", contract: "principle 1, 5; DATA.md Started", changes_definition: false });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const row = await db.prepare("SELECT contract, changes_definition FROM cards WHERE id = 'c-ok'").first();
  assert.equal(row.contract, "principle 1, 5; DATA.md Started");
  assert.equal(row.changes_definition, 0);
});

test("changes_definition true without a known from_thread is refused naming the contract; with the owner's thread it is made", async () => {
  const db = makeDb();
  const bad = await make(db, { id: "c-true", contract: "DATA.md Started = first push", changes_definition: true });
  refusedAs(bad, "card-changes-definition");
  assert.match(bad.refused.detail, /this changes DATA\.md Started = first push: ask the owner first/);
  for (const [i, from_thread] of [9999, 0, -1, 1.5].entries()) refusedAs(await make(db, { id: `c-t-${i}`, contract: "x", changes_definition: true, from_thread }), "card-changes-definition");
  const num = await decided(db);
  const ok = await make(db, { id: "c-decided", contract: "DATA.md Started = first push", changes_definition: true, from_thread: num });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal((await db.prepare("SELECT changes_definition AS d FROM cards WHERE id = 'c-decided'").first()).d, 1);
});

test("a product card is untouched; so is the store function without the tool's option; a card with a repo word the board reads as its own is held to the rule", async () => {
  const db = makeDb();
  assert.equal((await make(db, { id: "c-product", repo: "product-app" })).ok, true);
  assert.equal((await createCard(db, T, "Manager", { id: "c-plain", title: "Plain", repo: "flight-board" })).ok, true);
  refusedAs(await make(db, { id: "c-board", repo: "board" }), "card-contract");
});

test("a summary change on a flight-board card carries its contract; a write with no summary does not, and a product card's summary is free", async () => {
  const db = makeDb();
  assert.equal((await make(db, { id: "c-up", contract: "principle 1", changes_definition: false })).ok, true);
  assert.equal((await make(db, { id: "c-prod", repo: "product-app" })).ok, true);
  const upd = (f) => updateCard(db, T, "Manager", f, { needGroup: true, needContract: true });
  refusedAs(await upd({ id: "c-up", summary: "New words." }), "card-contract");
  refusedAs(await upd({ id: "c-up", summary: "New words.", contract: "principle 5", changes_definition: true }), "card-changes-definition");
  assert.equal((await upd({ id: "c-up", next_note: "A note." })).ok, true);
  assert.equal((await upd({ id: "c-up", summary: "New words.", contract: "principle 5", changes_definition: false })).ok, true);
  const num = await decided(db);
  assert.equal((await upd({ id: "c-up", summary: "Newer words.", contract: "DATA.md Stalled", changes_definition: true, from_thread: num })).ok, true);
  assert.equal((await upd({ id: "c-prod", summary: "A product card's words." })).ok, true);
  // moving a product card to the board's repo in the same write as its summary is a board card's summary change
  refusedAs(await upd({ id: "c-prod", summary: "Moved.", repo: "flight-board" }), "card-contract");
});

test("through the card_create and card_update TOOLS (the worker's own wiring)", async () => {
  const env = { DB: makeDb() };
  const call = (body) => worker.fetch(new Request("https://board.test/mcp", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-as": "manager" } }), env, null, T, async () => ({ who: "Manager", role: "agent" }));
  const tool = async (name, args) => (await (await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json()).result.structuredContent;
  const base = { title: "A card", summary: "Build it, because it is needed.", batch: "g-test", repo: "flight-board" };
  refusedAs(await tool("card_create", { id: "c-w1", ...base }), "card-contract");
  assert.equal((await tool("card_create", { id: "c-w2", ...base, contract: "principle 1", changes_definition: false })).ok, true);
  refusedAs(await tool("card_update", { id: "c-w2", summary: "Other words." }), "card-contract");
  assert.equal((await tool("card_update", { id: "c-w2", summary: "Other words.", contract: "principle 1", changes_definition: false })).ok, true);
});

test("the view carries the contract and the flag; a card written before has neither", async () => {
  const db = makeDb();
  assert.equal((await make(db, { id: "c-view", contract: "principle 1", changes_definition: false })).ok, true);
  const row = await db.prepare("SELECT * FROM cards WHERE id = 'c-view'").first();
  assert.equal(row.contract, "principle 1");
  assert.equal(row.changes_definition, 0);
  assert.equal((await createCard(db, T, "Manager", { id: "c-old", title: "Old" })).ok, true);
  const old = await db.prepare("SELECT contract, changes_definition FROM cards WHERE id = 'c-old'").first();
  assert.equal(old.contract, null);
  assert.equal(old.changes_definition, null);
});
