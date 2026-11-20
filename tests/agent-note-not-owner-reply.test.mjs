// #C1324 (the owner on a card's thread, "that wasn't for me"): Manager posted a technical note for an agent on a card's thread and the owner saw "1 new reply". Manager's own door now
// refuses a `post` on a card's thread (thread_id is a card id) when the owner has written nothing there, rule agent-note-on-card, and the hint is send_message. The cases that stay
// allowed come first (guard-false-positives): the owner's own threads, an ask's thread, a card thread where the owner has written, and the shared door (another role's post).
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { createCard, createAsk } from "../worker/board-store.mjs";

const NOW = 1_800_000_000_000;
const SECRET = "s".repeat(43), MSECRET = "m".repeat(43), SESSION = "local_b0c20591-32ff-41db-b0e5-ff9fc3fb26de";
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
async function make() {
  const env = { DB: makeDb(), CONNECTOR_HASH: await sha(SECRET), MANAGER_CONNECTOR_HASH: await sha(MSECRET) };
  const rpc = async (secret, params) => (await (await worker.fetch(new Request(`https://board.test/mcp/${secret}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }) }), env, null, NOW, async () => null)).json()).result;
  const manager = (args) => rpc(MSECRET, { name: "post", arguments: { session: SESSION, ...args } });
  const shared = (as, args) => rpc(SECRET, { name: "post", arguments: { as, ...args } });
  assert.equal((await createCard(env.DB, NOW, "Manager", { id: "card-a", title: "A card" })).ok, true);
  const count = async (t) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?").bind(t).first()).n;
  const ownerSays = (t) => env.DB.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES (?, ?, 'owner', 'a word', ?)").bind(`m-o-${t}`, t, NOW - 1000).run();
  return { env, manager, shared, count, ownerSays };
}

test("must still allow: Manager's post in the owner's own free thread, in an ask's thread, and on a card thread where the owner has written", async () => {
  const { env, manager, count, ownerSays } = await make();
  await env.DB.prepare("INSERT INTO threads (id, num, title, created_at) VALUES ('t-900', 900, 'Mine', ?)").bind(NOW - 5000).run();
  await ownerSays("t-900");
  assert.equal((await manager({ thread_id: "t-900", body: "an answer" })).isError, false, "the owner's free thread");
  const ask = await createAsk(env.DB, NOW, { type: "Thread", title: "Q", asked_by: "Manager", text: "hello" });
  assert.equal(ask.ok, true, JSON.stringify(ask));
  assert.equal((await manager({ thread_id: ask.id, body: "in the ask's thread" })).isError, false, "an ask's thread");
  await ownerSays("card-a");
  assert.equal((await manager({ thread_id: "card-a", body: "a reply to him" })).isError, false, "a card thread he wrote in");
  assert.equal(await count("t-900"), 2);
  assert.equal(await count("card-a"), 2);
});

// Checker 2's F1: a Manager decision with options goes on a card thread before the owner has written there (#C1294), and a post with screenshots is for him to look at.
test("must still allow: a Manager decision, and a post with screenshots, on a card thread the owner never wrote in", async () => {
  const { manager, count } = await make();
  const d = await manager({ thread_id: "card-a", body: "Which one?", kind: "decision", options: [{ key: "A", label: "Yes" }, { key: "B", label: "No" }] });
  assert.equal(d.isError, false, JSON.stringify(d));
  assert.equal(await count("card-a"), 1);
  const shots = await manager({ thread_id: "card-a", body: "Look at this", screenshots: ["no-such-file"] });
  assert.notEqual(shots.structuredContent?.refused?.rule, "agent-note-on-card", "a post with a picture is not refused as an agent's note");
  const empty = await manager({ thread_id: "card-a", body: "a note for Admin", screenshots: [] });
  assert.equal(empty.structuredContent.refused.rule, "agent-note-on-card", "an empty screenshots list carries nothing");
});

test("a post on a card thread the owner never wrote in is refused on Manager's door, logged, nothing written, and the hint names send_message", async () => {
  const { env, manager, count } = await make();
  const r = await manager({ thread_id: "card-a", body: "a note for Admin" });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.refused.rule, "agent-note-on-card");
  assert.match(r.structuredContent.refused.detail, /send_message/);
  assert.equal(await count("card-a"), 0, "nothing written");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM refusals WHERE rule = 'agent-note-on-card'").first()).n, 1);
});

test("must still allow: the shared door (another role's own post on its card's thread) is unchanged", async () => {
  const { shared, count } = await make();
  assert.equal((await shared("Builder", { thread_id: "card-a", body: "built it" })).isError, false);
  assert.equal(await count("card-a"), 1);
});
