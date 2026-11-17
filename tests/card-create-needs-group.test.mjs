// #C1107 (11-16: 15 of 27 cards were loose because grouping lived in the lead's memory): the card_create TOOL refuses a card with no group and lists the open
// groups; the card_update TOOL refuses a write that clears batch. The store functions without the tool's option are as before (importers, older callers).
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard } from "../worker/board-store.mjs";

const T = 1_800_000_000_000;
const make = (db, fields) => createCard(db, T, "Manager", { summary: "Build it, because it is needed.", ...fields }, { needSummary: true, needGroup: true });
const edit = (db, fields) => updateCard(db, T + 1, "Manager", fields, { needGroup: true });
const refusedAs = (r, rule) => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.refused?.rule ?? r.rule, rule, JSON.stringify(r)); return r.refused?.detail ?? r.detail ?? ""; };

test("a card with no batch is refused with card-group; with a batch it is accepted", async () => {
  const db = makeDb();
  refusedAs(await make(db, { id: "c-loose", title: "Loose" }), "card-group");
  assert.equal((await make(db, { id: "c-grouped", title: "Grouped", batch: "g1-first" })).ok, true);
});

test("an empty, blank or non-text batch is no group; an odd one is refused by its own shape rule", async () => {
  const db = makeDb();
  refusedAs(await make(db, { id: "c-bad-null", title: "x", batch: null }), "card-group");
  // An empty or blank text never passed the batch shape rule (card-batch, first); a non-text batch likewise. All are refused, none is made.
  for (const [i, batch] of ["", "   ", "Not A Group", 7].entries()) refusedAs(await make(db, { id: `c-bad-${i}`, title: "x", batch }), "card-batch");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cards").first()).n, 0);
});

test("the refusal lists the open groups, newest first, and leaves out a group whose cards are all dropped or done", async () => {
  const db = makeDb();
  assert.match(refusedAs(await make(db, { id: "c-a", title: "a" }), "card-group"), /none is open/);
  await make(db, { id: "c-old", title: "old", batch: "g1-old" });
  await make(db, { id: "c-mid", title: "mid", batch: "g2-mid" });
  await make(db, { id: "c-gone", title: "gone", batch: "g3-gone" });
  await make(db, { id: "c-new", title: "new", batch: "g4-new" });
  assert.equal((await updateCard(db, T + 2, "Manager", { id: "c-gone", dropped: true })).ok, true);
  await make(db, { id: "c-fin", title: "fin", batch: "g5-fin" });
  assert.equal((await updateCard(db, T + 3, "Manager", { id: "c-fin", done: true, done_evidence: "https://example.test/x" })).ok, true);
  const detail = refusedAs(await make(db, { id: "c-b", title: "b" }), "card-group");
  assert.match(detail, /open group \(g4-new, g2-mid, g1-old\)/, detail);
  assert.doesNotMatch(detail, /g3-gone|g5-fin/);
});

test("more than 12 open groups are cut to 12 with a count of the rest", async () => {
  const db = makeDb();
  for (let i = 1; i <= 14; i++) await make(db, { id: `c-${i}`, title: `t${i}`, batch: `g${String(i).padStart(2, "0")}` });
  const detail = refusedAs(await make(db, { id: "c-x", title: "x" }), "card-group");
  assert.match(detail, /g14, g13, .*, g03 and 2 more\)/, detail);
});

test("a write that clears batch is refused; moving to another group is accepted; a loose existing card is still updated, and a write can give it a group", async () => {
  const db = makeDb();
  await make(db, { id: "c-in", title: "In", batch: "g1-first" });
  for (const [i, batch] of [null, "", "  "].entries()) refusedAs(await edit(db, { id: "c-in", batch }), "card-group");
  assert.equal((await edit(db, { id: "c-in", batch: "g2-second" })).ok, true);
  assert.equal((await edit(db, { id: "c-in", next_note: "no batch word at all" })).ok, true, "a write that does not touch batch is as before");
  // An old card with no group (made without the tool option): still updated, and a write can give it a group.
  await createCard(db, T, "Manager", { id: "c-old", title: "Old loose" });
  assert.equal((await edit(db, { id: "c-old", next_note: "still editable" })).ok, true);
  assert.equal((await edit(db, { id: "c-old", batch: "g2-second" })).ok, true);
});

test("a card without a summary is still refused (the summary rule stands beside the group rule), and the summary is checked first", async () => {
  const db = makeDb();
  refusedAs(await createCard(db, T, "Manager", { id: "c-nosum", title: "x", batch: "g1" }, { needSummary: true, needGroup: true }), "card-summary");
  refusedAs(await createCard(db, T, "Manager", { id: "c-neither", title: "x" }, { needSummary: true, needGroup: true }), "card-summary");
});

// The tool wiring itself (as #C1087's F1): board-worker.mjs's card_create and card_update cases pass { needGroup: true }; dropping either leaves the store tests green.
test("through the card_create and card_update TOOLS (the worker's own wiring): no group is refused with card-group, clearing batch is refused, a group is ok", async () => {
  const { default: worker } = await import("../worker/board-worker.mjs");
  const env = { DB: makeDb() };
  const call = (body) => worker.fetch(new Request("https://board.test/mcp", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-as": "manager" } }), env, null, T, async () => ({ who: "Manager", role: "agent" }));
  const tool = async (name, args) => (await (await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json()).result.structuredContent;
  const words = { summary: "Build the thing, because it is needed." };
  const bare = await tool("card_create", { id: "c-tool-bare", title: "x", ...words });
  assert.equal(bare.refused?.rule ?? bare.rule, "card-group", JSON.stringify(bare));
  assert.equal((await tool("card_create", { id: "c-tool-ok", title: "x", ...words, batch: "g1-first" })).ok, true);
  const clear = await tool("card_update", { id: "c-tool-ok", batch: null });
  assert.equal(clear.refused?.rule ?? clear.rule, "card-group", JSON.stringify(clear));
  assert.match(JSON.stringify(clear), /g1-first/, "the refusal lists the open groups");
  assert.equal((await tool("card_update", { id: "c-tool-ok", batch: "g2-second" })).ok, true);
});

test("the store functions without the tool's option are as before", async () => {
  const db = makeDb();
  assert.equal((await createCard(db, T, "Manager", { id: "c-plain", title: "Plain" })).ok, true);
  assert.equal((await updateCard(db, T + 1, "Manager", { id: "c-plain", batch: null })).ok, true);
});
