// #C1149 (the review dispatch woke Checker 2 for #C1148, a product card Manager created with no repo word, which the board reads as its own): the card_create TOOL refuses a
// card with no repo and lists the known repos. The store function without the tool's option, and the reading of an old card with no repo as the board's, are as before.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard } from "../worker/board-store.mjs";
import worker from "../worker/board-worker.mjs";
import { reviewerOf } from "../worker/board-rules.mjs";
import { reviewerFor } from "../collector/store-dispatch.mjs";

const T = 1_800_000_000_000;
const make = (db, fields) => createCard(db, T, "Manager", { summary: "Build it, because it is needed.", batch: "g1-first", ...fields }, { needSummary: true, needGroup: true, needRepo: true });
const refusedAs = (r, rule) => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.refused?.rule ?? r.rule, rule, JSON.stringify(r)); return r.refused?.detail ?? r.detail ?? ""; };
const count = async (db) => (await db.prepare("SELECT COUNT(*) AS n FROM cards").first()).n;

test("a card with no repo is refused with card-repo-missing and is not written; with a repo it is accepted", async () => {
  const db = makeDb();
  refusedAs(await make(db, { id: "c-none", title: "No repo" }), "card-repo-missing");
  assert.equal(await count(db), 0);
  assert.equal((await make(db, { id: "c-flight", title: "Board", repo: "flight-board" })).ok, true);
  assert.equal((await make(db, { id: "c-prod", title: "Product", repo: "product-app" })).ok, true);
});

test("a null repo is no repo; an empty or blank one never passed the repo shape rule (card-repo), first; none of them is made", async () => {
  const db = makeDb();
  refusedAs(await make(db, { id: "c-bad-null", title: "x", repo: null }), "card-repo-missing");
  for (const [i, repo] of ["", "   "].entries()) refusedAs(await make(db, { id: `c-bad-${i}`, title: "x", repo }), "card-repo");
  assert.equal(await count(db), 0);
});

test("the refusal lists the known repos: flight-board always, then every repo word a card carries ('board' reads as flight-board)", async () => {
  const db = makeDb();
  assert.match(refusedAs(await make(db, { id: "c-a", title: "a" }), "card-repo-missing"), /known: flight-board\)/);
  await make(db, { id: "c-b", title: "b", repo: "product-app" });
  await make(db, { id: "c-c", title: "c", repo: "board" });
  await make(db, { id: "c-d", title: "d", repo: "product-app" });
  const detail = refusedAs(await make(db, { id: "c-e", title: "e" }), "card-repo-missing");
  assert.match(detail, /known: flight-board, product-app\)/, detail);
});

test("the store function without the tool's option still makes a card with no repo (importers, older callers)", async () => {
  const db = makeDb();
  assert.equal((await createCard(db, T, "Manager", { id: "c-old", title: "Old" })).ok, true);
});

test("through the card_create tool: no repo is refused, a repo is accepted", async () => {
  const env = { DB: makeDb() };
  const tool = async (args) => {
    const res = await worker.fetch(new Request("https://board.test/mcp", { method: "POST", headers: { "content-type": "application/json", "x-as": "m" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "card_create", arguments: args } }) }), env, null, T, async () => ({ who: "Manager", role: "agent" }));
    return (await res.json()).result;
  };
  const base = { id: "c-tool", title: "Tool", summary: "Build it, because it is needed.", batch: "g1-first" };
  const refused = await tool(base);
  assert.match(JSON.stringify(refused), /card-repo-missing/);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards").first()).n, 0);
  assert.doesNotMatch(JSON.stringify(await tool({ ...base, repo: "product-app" })), /card-repo-missing/);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards").first()).n, 1);
});

test("an old card with no repo word is still read as the board's by both reviewer readings; 'board' too; a product word is not", () => {
  const REVIEWERS = { "flight-board": "Checker 2" }, ROSTER = ["Checker", "Checker 2"];
  for (const [card, want] of [[{ repo: "" }, "Checker 2"], [{}, "Checker 2"], [{ repo: "board" }, "Checker 2"], [{ repo: "flight-board" }, "Checker 2"], [{ repo: "product-app" }, undefined]]) {
    assert.equal(reviewerOf(card, REVIEWERS), want, JSON.stringify(card));
    assert.equal(reviewerFor(card, REVIEWERS, ROSTER), want, JSON.stringify(card));
  }
});
