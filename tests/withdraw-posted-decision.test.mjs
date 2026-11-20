// #C1332 (the owner, t-1795159050363: a mockup made Manager's A/B moot and the buttons stayed): Manager's door has withdraw_decision. An unanswered decision Manager posted loses its
// buttons and reads "No longer needed", and the card it held is released. Refused: after the owner has picked (written in the thread after it), on another author's message, on a message
// that is no open decision, from the shared door, and with a malformed argument. The refusals are tested first (nothing changes), then the working case.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { createCard, withdrawDecision } from "../worker/board-store.mjs";
import { openDecisionHolds } from "../worker/board-rules.mjs";

const NOW = 1_800_000_000_000;
const SECRET = "s".repeat(43), MSECRET = "m".repeat(43), SESSION = "local_b0c20591-32ff-41db-b0e5-ff9fc3fb26de";
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
async function make() {
  const env = { DB: makeDb(), CONNECTOR_HASH: await sha(SECRET), MANAGER_CONNECTOR_HASH: await sha(MSECRET) };
  const rpc = async (secret, params, method = "tools/call") => (await (await worker.fetch(new Request(`https://board.test/mcp/${secret}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env, null, NOW, async () => null)).json()).result;
  const manager = (name, args) => rpc(MSECRET, { name, arguments: { session: SESSION, ...args } });
  const shared = (as, name, args) => rpc(SECRET, { name, arguments: { as, ...args } });
  assert.equal((await createCard(env.DB, NOW, "Manager", { id: "card-a", title: "A card" })).ok, true);
  const owner = (id, thread, at = NOW + 1000, body = "Chose B: No") => env.DB.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES (?, ?, 'owner', ?, ?)").bind(id, thread, body, at).run();
  const row = (id) => env.DB.prepare("SELECT author, body, kind, options, screenshots FROM messages WHERE id = ?").bind(id).first();
  const decide = async (thread = "card-a") => { const r = await manager("post", { thread_id: thread, body: "Which one?\n\nCard: card-a", kind: "decision", options: [{ key: "A", label: "Yes" }, { key: "B", label: "No" }] }); assert.equal(r.isError, false, JSON.stringify(r)); return r.structuredContent.id; };
  return { env, manager, shared, owner, row, decide, rpc };
}
const rule = (r) => r.structuredContent?.refused?.rule;

// Manager, t-1795159050363: the owner wrote five more messages after the A/B (m-1795159268173-fb02f47f) and never picked; that is the case this tool is for.
test("must still allow: the owner wrote other messages after the decision without picking, and withdraw works", async () => {
  const { env, manager, owner, row, decide } = await make();
  const id = await decide();
  const words = ["a mockup would help", "Chosen at random is fine", "I chose to wait", "chose A: lower case is not the page's pick", "what do you think?"];
  for (const [n, body] of words.entries()) await owner(`m-owner-w${n}`, "card-a", NOW + 1000 + n, body);
  await env.DB.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES ('m-agent-chose', 'card-a', 'Builder', 'Chose A: Yes', ?)").bind(NOW + 2000).run(); // another author's words are not his pick
  await owner("m-owner-earlier-pick", "card-a", NOW - 9000); // his pick of an older decision, before this one
  const r = await manager("withdraw_decision", { message_id: id });
  assert.equal(r.isError, false, JSON.stringify(r));
  const after = await row(id);
  assert.equal(after.body, "No longer needed");
  assert.equal(after.options, null);
  assert.equal(after.kind, "withdrawn");
});

// Manager's edge on e433f02e: a pick belongs to ITS decision. Two decisions in one thread, the owner picks the second: the first can still be withdrawn, with different
// options and with the same ones (a pick after the second decision answers the second); a pick of the first, between them, still blocks it.
test("must still allow: two decisions in one thread, the owner picks the second, and the first can be withdrawn", async () => {
  for (const [first, second] of [[["Yes", "No"], ["Red", "Blue"]], [["Yes", "No"], ["Yes", "No"]]]) {
    const { env, manager, owner, row } = await make();
    const post = async (labels, at) => { const r = await manager("post", { thread_id: "card-a", body: "Which?\n\nCard: card-a", kind: "decision", options: [{ key: "A", label: labels[0] }, { key: "B", label: labels[1] }] }); assert.equal(r.isError, false, JSON.stringify(r)); await env.DB.prepare("UPDATE messages SET created_at = ? WHERE id = ?").bind(at, r.structuredContent.id).run(); return r.structuredContent.id; };
    const d1 = await post(first, NOW + 100), d2 = await post(second, NOW + 200);
    await owner("m-pick-second", "card-a", NOW + 300, `Chose B: ${second[1]}`);
    const r = await manager("withdraw_decision", { message_id: d1 });
    assert.equal(r.isError, false, JSON.stringify([first, second, r]));
    assert.equal((await row(d1)).kind, "withdrawn");
    assert.equal((await row(d2)).kind, "decision", "the second, which he picked, is untouched");
    assert.equal(rule(await manager("withdraw_decision", { message_id: d2 })), "withdraw-answered", "and it is still refused once picked");
  }
});

test("a pick of the first decision between the two still blocks withdrawing it, and a pick that is none of its options does not", async () => {
  const { env, manager, owner } = await make();
  const post = async (labels, at) => { const r = await manager("post", { thread_id: "card-a", body: "Which?\n\nCard: card-a", kind: "decision", options: [{ key: "A", label: labels[0] }, { key: "B", label: labels[1] }] }); await env.DB.prepare("UPDATE messages SET created_at = ? WHERE id = ?").bind(at, r.structuredContent.id).run(); return r.structuredContent.id; };
  const d1 = await post(["Yes", "No"], NOW + 100);
  await owner("m-stray", "card-a", NOW + 150, "Chose B: Something it never offered");
  assert.equal((await manager("withdraw_decision", { message_id: d1 })).isError, false, "a Chose line that is none of its options is no pick of it");
  const { manager: manager2, owner: owner2, env: env2 } = await make();
  const post2 = async (labels, at) => { const r = await manager2("post", { thread_id: "card-a", body: "Which?\n\nCard: card-a", kind: "decision", options: [{ key: "A", label: labels[0] }, { key: "B", label: labels[1] }] }); await env2.DB.prepare("UPDATE messages SET created_at = ? WHERE id = ?").bind(at, r.structuredContent.id).run(); return r.structuredContent.id; };
  const e1 = await post2(["Yes", "No"], NOW + 100);
  await owner2("m-pick-first", "card-a", NOW + 150, "Chose A: Yes");
  await post2(["Red", "Blue"], NOW + 200);
  assert.equal(rule(await manager2("withdraw_decision", { message_id: e1 })), "withdraw-answered");
});

test("refused after the owner has picked (his \"Chose B: No\" in the thread after the decision, among other words): nothing changes", async () => {
  const { env, manager, owner, row, decide } = await make();
  const id = await decide();
  await owner("m-owner-talk", "card-a", NOW + 500, "thinking about it");
  await owner("m-owner-pick", "card-a");
  const r = await manager("withdraw_decision", { message_id: id });
  assert.equal(r.isError, true);
  assert.equal(rule(r), "withdraw-answered");
  const after = await row(id);
  assert.equal(after.kind, "decision");
  assert.notEqual(after.options, null, "the buttons stay");
  assert.notEqual(after.body, "No longer needed");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM refusals WHERE rule = 'withdraw-answered'").first()).n, 1, "logged");
});

test("refused on another author's message: the owner's, and another role's decision", async () => {
  const { env, manager, owner, row } = await make();
  await owner("m-owner-1", "card-a", NOW - 5000);
  assert.equal(rule(await manager("withdraw_decision", { message_id: "m-owner-1" })), "withdraw-not-yours");
  await env.DB.prepare("INSERT INTO messages (id, thread_id, author, body, created_at, kind, options) VALUES ('m-other', 'card-a', 'Builder', 'Q?', ?, 'decision', ?)").bind(NOW - 1000, JSON.stringify([{ key: "A", label: "x" }, { key: "B", label: "y" }])).run();
  assert.equal(rule(await manager("withdraw_decision", { message_id: "m-other" })), "withdraw-not-yours");
  assert.equal((await row("m-other")).kind, "decision");
  assert.equal((await row("m-owner-1")).body, "Chose B: No");
});

test("refused on a message that is no open decision, an unknown id, a bad argument, an extra field, and on the shared door", async () => {
  const { env, manager, shared, row, decide } = await make();
  const id = await decide();
  await env.DB.prepare("INSERT INTO messages (id, thread_id, author, body, created_at, kind) VALUES ('m-plain', 'card-a', 'Manager', 'a plain note', ?, 'note')").bind(NOW - 500).run();
  assert.equal(rule(await manager("withdraw_decision", { message_id: "m-plain" })), "withdraw-not-open-decision");
  assert.equal((await row("m-plain")).body, "a plain note");
  assert.equal(rule(await manager("withdraw_decision", { message_id: "m-nope" })), "withdraw-no-message");
  assert.equal(rule(await manager("withdraw_decision", { message_id: "bad id!" })), "message-shape");
  assert.equal(rule(await manager("withdraw_decision", { message_id: id, extra: 1 })), "message-shape");
  assert.equal(rule(await manager("withdraw_decision", {})), "message-shape");
  assert.equal(await shared("Manager", "withdraw_decision", { message_id: id }), undefined, "the shared door has no such tool (a JSON-RPC error, no result)");
  assert.equal((await row(id)).kind, "decision");
});

test("a withdrawn decision is not withdrawn twice (it is no open decision any more)", async () => {
  const { manager, decide } = await make();
  const id = await decide();
  assert.equal((await manager("withdraw_decision", { message_id: id })).isError, false);
  assert.equal(rule(await manager("withdraw_decision", { message_id: id })), "withdraw-not-open-decision");
});

test("works on an unanswered decision: buttons gone, reads No longer needed, the card is released", async () => {
  const { env, manager, owner, row, decide } = await make();
  await owner("m-owner-old", "card-a", NOW - 9000); // he wrote earlier: that is not an answer to a decision posted after it
  const id = await decide();
  const rows = async () => (await env.DB.prepare("SELECT id, thread_id, author, body, created_at, kind, resolved FROM messages").all()).results;
  const cards = [{ id: "card-a", num: 1 }];
  assert.equal([...openDecisionHolds(await rows(), cards, "Manager").keys()].includes("card-a"), true, "held while open");
  const r = await manager("withdraw_decision", { message_id: id });
  assert.equal(r.isError, false, JSON.stringify(r));
  assert.deepEqual({ id: r.structuredContent.id, withdrawn: r.structuredContent.withdrawn }, { id, withdrawn: true });
  const after = await row(id);
  assert.equal(after.body, "No longer needed");
  assert.equal(after.options, null);
  assert.equal(after.screenshots, null);
  assert.equal(after.kind, "withdrawn");
  assert.equal(after.author, "Manager");
  assert.equal([...openDecisionHolds(await rows(), cards, "Manager").keys()].includes("card-a"), false, "released");
});

test("the store function itself refuses any caller but Manager, even on that caller's own decision", async () => {
  const { env, row } = await make();
  await env.DB.prepare("INSERT INTO messages (id, thread_id, author, body, created_at, kind, options) VALUES ('m-b', 'card-a', 'Builder', 'Q?', ?, 'decision', ?)").bind(NOW - 1000, JSON.stringify([{ key: "A", label: "x" }, { key: "B", label: "y" }])).run();
  const r = await withdrawDecision(env.DB, NOW, "Builder", { message_id: "m-b" });
  assert.equal(r.ok, false);
  assert.equal(r.refused.rule, "withdraw-manager-only");
  assert.equal((await row("m-b")).kind, "decision");
});

test("the tool is on Manager's door only, and takes its session like every write", async () => {
  const { rpc } = await make();
  const names = (await rpc(MSECRET, {}, "tools/list")).tools.map((t) => t.name);
  assert.equal(names.includes("withdraw_decision"), true);
  assert.equal((await rpc(SECRET, {}, "tools/list")).tools.map((t) => t.name).includes("withdraw_decision"), false);
  const noSession = await rpc(MSECRET, { name: "withdraw_decision", arguments: { message_id: "m-x" } });
  assert.equal(noSession.isError, true);
  assert.notEqual(rule(noSession), "withdraw-no-message", "the session check comes before the tool");
});
