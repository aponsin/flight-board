// #C949: a landed card is closed with card_update { done: true, done_evidence } from EVERY door (the shared connector for the sixteen roles,
// Manager's own door, the Access path), and a refusal says what is missing, not "already done". Fictional names.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { createCard } from "../worker/board-store.mjs";
import { cardWriteRefusal } from "../worker/board-rules.mjs";

const NOW = 1_800_000_000_000;
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const SECRET = "s".repeat(43), MSECRET = "m".repeat(43);
const make = async () => {
  const env = { DB: makeDb(), CONNECTOR_HASH: await sha(SECRET), MANAGER_CONNECTOR_HASH: await sha(MSECRET) };
  const door = (secret) => async (method, params) => (await worker.fetch(new Request(`https://board.test/mcp/${secret}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env, null, NOW, async () => null)).json();
  const shared = door(SECRET), manager = door(MSECRET);
  const access = async (who, role, args) => (await worker.fetch(new Request("https://board.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "card_update", arguments: args } }) }), env, null, NOW, async () => ({ who, role }))).json();
  return { env, shared, manager, access };
};
const open = async (env, id) => { const r = await createCard(env.DB, NOW, "Manager", { id, title: id, owner_role: "Boardsmith" }); assert.equal(r.ok, true, JSON.stringify(r)); };
const done = (env, id) => env.DB.prepare("SELECT done_at, done_evidence FROM cards WHERE id = ?").bind(id).first();

test("both connector doors offer card_update with done and done_evidence, and say how a card is closed", async () => {
  const { shared, manager } = await make();
  for (const list of [(await shared("tools/list")).result.tools, (await manager("tools/list")).result.tools]) {
    const t = list.find((x) => x.name === "card_update");
    assert.equal(t.inputSchema.properties.done.type, "boolean");
    assert.equal(t.inputSchema.properties.done_evidence.type, "string");
    assert.match(t.description, /done: true and done_evidence/);
  }
});

test("a close with valid evidence works from the shared door, Manager's door and the Access path; a done card cannot be reopened or closed twice", async () => {
  const { env, shared, manager, access } = await make();
  for (const id of ["via-shared", "via-manager", "via-access"]) await open(env, id);
  const ev = "https://example.com/landed";
  const a = await shared("tools/call", { name: "card_update", arguments: { as: "Boardsmith", id: "via-shared", done: true, done_evidence: ev } });
  const b = await manager("tools/call", { name: "card_update", arguments: { id: "via-manager", done: true, done_evidence: ev } });
  const c = await access("Boardsmith", "agent", { id: "via-access", done: true, done_evidence: ev });
  for (const [r, id] of [[a, "via-shared"], [b, "via-manager"], [c, "via-access"]]) {
    assert.ok(!r.error, JSON.stringify(r));
    assert.notEqual((await done(env, id)).done_at, null, id);
    assert.equal((await done(env, id)).done_evidence, ev);
  }
  const again = await shared("tools/call", { name: "card_update", arguments: { as: "Boardsmith", id: "via-shared", done: true, done_evidence: "/tmp/other" } });
  assert.match(JSON.stringify(again), /already done/);
  assert.equal((await done(env, "via-shared")).done_evidence, ev, "the first evidence stays");
  const reopen = await manager("tools/call", { name: "card_update", arguments: { id: "via-manager", done: false } });
  assert.match(JSON.stringify(reopen), /card-done/);
  assert.notEqual((await done(env, "via-manager")).done_at, null, "still done");
});

test("a refusal names what is missing: done without evidence, evidence without done, done false", () => {
  const msg = (f) => cardWriteRefusal({ id: "x", ...f }, null);
  assert.equal(msg({ done: true }).rule, "done-needs-evidence");
  assert.match(msg({ done: true }).detail, /done_evidence/);
  const noDone = msg({ done_evidence: "/tmp/a" });
  assert.equal(noDone.rule, "card-done");
  assert.match(noDone.detail, /without done/);
  assert.match(noDone.detail, /done: true/);
  assert.doesNotMatch(noDone.detail, /already|reopen/, "it does not read as an already-done card");
  const off = msg({ done: false, done_evidence: "/tmp/a" });
  assert.equal(off.rule, "card-done");
  assert.match(off.detail, /never reopens a done card/);
});
