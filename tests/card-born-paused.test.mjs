// #C1348 (11-20 ~8 am MT: a follow-up card that had to wait for a ship was created, then paused in a second write; the dispatch watch sent it to Builder in the seconds between, which
// would have stacked a commit on a signed group head): the card_create tool takes paused (true or false) and writes it in the same record as the card, so the dispatch never sees the
// card unpaused. A card made without paused is dispatched as before.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun } from "../collector/store-dispatch.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Checker", "Security", "Release"], LEAD = "Manager";
const idle = { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN };
const BASE = { title: "A follow-up", summary: "Build it, because it is needed.", batch: "g1-first", repo: "product-app", owner_role: "Boardsmith", review_level: "Quick" };
const WHY = "Paused until the group it follows has shipped.";

function tool(env, args) {
  return worker.fetch(new Request("https://board.test/mcp", { method: "POST", headers: { "content-type": "application/json", "x-as": "m" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "card_create", arguments: args } }) }), env, null, NOW, async () => ({ who: "Manager", role: "agent" })).then((r) => r.json()).then((j) => j.result);
}
const row = (env, id) => env.DB.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first();
const world = (cards) => ({ cards, asks: [], threads: { messages: [], threads: [] }, stackSwitch: [{ repo: "board", stack: false, set_by: "default", set_at: 0 }], evidence: { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle])) } } });
const dispatched = (cards) => dispatchRun(world(cards), { dir: mkdtempSync(join(tmpdir(), "born-")), roster: ROSTER, lead: LEAD, now: NOW }).items.map((i) => `${i.card}:${i.role}:${i.step}`).sort();

test("card_create with paused true makes the card in one write, already paused, and the dispatch never builds it", async () => {
  const env = { DB: makeDb() };
  const r = await tool(env, { ...BASE, id: "born-paused", paused: true, next_note: WHY });
  assert.doesNotMatch(JSON.stringify(r), /refused|unknown/i, JSON.stringify(r));
  const c = await row(env, "born-paused");
  assert.equal(c.paused, 1, "paused in the card's own record");
  assert.equal(c.created_at, c.updated_at, "no second write was needed");
  assert.deepEqual(dispatched([c]), [], "a paused card is built for nobody");
});

test("must still allow: a card made without paused, or with paused false, is not paused and is dispatched as today", async () => {
  const env = { DB: makeDb() };
  await tool(env, { ...BASE, id: "born-plain" });
  await tool(env, { ...BASE, id: "born-false", paused: false });
  const [plain, no] = [await row(env, "born-plain"), await row(env, "born-false")];
  assert.equal(plain.paused, 0);
  assert.equal(no.paused, 0);
  assert.deepEqual(dispatched([plain]), ["born-plain:Boardsmith:build"]);
  assert.deepEqual(dispatched([no]), ["born-false:Boardsmith:build"]);
});

test("the tool's schema lists paused for card_create (the connector refuses a field the schema does not name), and a paused card still needs its note", async () => {
  const env = { DB: makeDb() };
  const list = await worker.fetch(new Request("https://board.test/mcp", { method: "POST", headers: { "content-type": "application/json", "x-as": "m" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), env, null, NOW, async () => ({ who: "Manager", role: "agent" })).then((r) => r.json());
  const create = list.result.tools.find((t) => t.name === "card_create");
  assert.deepEqual(create.inputSchema.properties.paused, { type: "boolean", description: create.inputSchema.properties.paused.description });
  assert.match(create.inputSchema.properties.paused.description, /next_note/);
  const refused = await tool(env, { ...BASE, id: "born-no-note", paused: true });
  assert.match(JSON.stringify(refused), /blocked-needs-note/);
  assert.equal(await row(env, "born-no-note"), null, "nothing is written for a refused card");
});

test("a paused card made through the tool stays paused until it is unpaused, and then it is dispatched", async () => {
  const env = { DB: makeDb() };
  await tool(env, { ...BASE, id: "born-then-free", paused: true, next_note: WHY });
  assert.deepEqual(dispatched([await row(env, "born-then-free")]), []);
  await env.DB.prepare("UPDATE cards SET paused = 0 WHERE id = ?").bind("born-then-free").run();
  assert.deepEqual(dispatched([await row(env, "born-then-free")]), ["born-then-free:Boardsmith:build"]);
});
