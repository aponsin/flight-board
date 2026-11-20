// #C1147 (Security's follow-up on #C1073): on the shared connector door the caller's name is only the `as` it declares, so a message of
// kind "decision" (which holds a card) is accepted only from Manager's own door (its secret, no `as`) or the owner's Access role.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { decisionRefusal } from "../worker/board-worker.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";

const NOW = 1_800_000_000_000;
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const SECRET = "s".repeat(43), MSECRET = "m".repeat(43);
const noAccess = async () => null;
const OPTIONS = [{ key: "A", label: "Yes" }, { key: "B", label: "No" }];
const ASK = { type: "Decision", title: "Which one?", question: "Go?", options: ["Yes", "No"], recommended: "Yes" };

async function make() {
  const env = { DB: makeDb(), CONNECTOR_HASH: await sha(SECRET), MANAGER_CONNECTOR_HASH: await sha(MSECRET) };
  await env.DB.prepare("INSERT INTO threads (id, num, title, created_at) VALUES ('t-100', 900, 'Pack order', ?)").bind(NOW - 600_000).run();
  await env.DB.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES ('m-t-100', 't-100', 'owner', 'hello', ?)").bind(NOW - 600_000).run();
  const rpc = async (secret, name, args) => (await (await worker.fetch(new Request(`https://board.test/mcp/${secret}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env, null, NOW, noAccess)).json()).result;
  const shared = (as, name, args) => rpc(SECRET, name, { as, ...args });
  const manager = (name, args) => rpc(MSECRET, name, args);
  const decisions = async () => (await env.DB.prepare("SELECT author FROM messages WHERE kind = 'decision'").all()).results.map((r) => r.author);
  const refusals = async () => (await env.DB.prepare("SELECT rule FROM refusals").all()).results.map((r) => r.rule);
  return { env, shared, manager, decisions, refusals };
}

test("the shared door refuses a post of kind decision, whoever `as` claims to be, and stores nothing", async () => {
  const { shared, decisions, refusals } = await make();
  for (const as of ["Manager", "Builder", "Checker"]) {
    const r = await shared(as, "post", { thread_id: "t-100", body: "hold it", kind: "decision", options: OPTIONS });
    assert.equal(r.isError, true, `${as}: ${JSON.stringify(r)}`);
    assert.equal(r.structuredContent.refused?.rule ?? r.structuredContent.rule, "decision-needs-manager-door");
  }
  assert.deepEqual(await decisions(), []);
  assert.ok((await refusals()).includes("decision-needs-manager-door"));
});

test("the shared door stores no decision under another spelling of the kind, and refuses Manager's Decision ask that names a thread", async () => {
  const { shared, decisions } = await make();
  for (const kind of ["Decision", " DECISION ", "decision"]) { // the first two are refused by the message shape; the hold reads the exact word
    assert.equal((await shared("Manager", "post", { thread_id: "t-100", body: "x", kind, options: OPTIONS })).isError, true, kind);
  }
  const ask = await shared("Manager", "ask", { ...ASK, related_thread: "t-100" });
  assert.equal(ask.isError, true, JSON.stringify(ask));
  assert.deepEqual(await decisions(), []);
});

test("Manager's own door posts a decision, by the post tool and by a Decision ask that names a thread", async () => {
  const { manager, decisions } = await make();
  const p = await manager("post", { session: "local_b0c20591-32ff-41db-b0e5-ff9fc3fb26de", thread_id: "t-100", body: "which?", kind: "decision", options: OPTIONS });
  assert.equal(p.isError, false, JSON.stringify(p));
  const a = await manager("ask", { session: "local_b0c20591-32ff-41db-b0e5-ff9fc3fb26de", ...ASK, related_thread: "t-100" });
  assert.equal(a.isError, false, JSON.stringify(a));
  assert.deepEqual(await decisions(), ["Manager", "Manager"]);
});

test("the shared door still posts plain messages, other kinds, and a Decision ask with related_thread none or from another role", async () => {
  const { shared, decisions } = await make();
  assert.equal((await shared("Builder", "post", { thread_id: "t-100", body: "plain" })).isError, false);
  assert.equal((await shared("Builder", "post", { thread_id: "t-100", body: "a note", kind: "note" })).isError, false);
  assert.equal((await shared("Manager", "ask", { ...ASK, related_thread: "none" })).isError, false, "an ask, not a message");
  assert.equal((await shared("Builder", "ask", ASK)).isError, false, "another role's Decision ask is an ask item as before");
  assert.deepEqual(await decisions(), []);
});

test("decisionRefusal: only the shared door is refused; the Access and Manager doors pass", () => {
  const args = { thread_id: "t-100", body: "x", kind: "decision" };
  assert.equal(decisionRefusal("shared", "post", "Builder", args).rule, "decision-needs-manager-door");
  assert.equal(decisionRefusal("manager", "post", "Manager", args), null);
  assert.equal(decisionRefusal("access", "post", "owner", args), null);
  assert.equal(decisionRefusal("shared", "post", "Builder", { ...args, kind: undefined }), null);
  assert.equal(decisionRefusal("shared", "card_update", "Builder", args), null);
});
