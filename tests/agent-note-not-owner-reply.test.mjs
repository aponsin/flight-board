// #C1324 (the owner on a card's thread, "that wasn't for me"): Manager posted a technical note for an agent on a card's thread and the owner saw "1 new reply". Manager's own door now
// refuses a `post` on a card's thread (thread_id is a card id) when the owner has written nothing there, rule agent-note-on-card, and the hint is send_message. The cases that stay
// allowed come first (guard-false-positives): the owner's own threads, an ask's thread and a card thread where the owner has written. #C1336 gives the shared door the same rule (below).
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

// #C1328 (Checker 2's LOW on 7fef3cb7): only kind "decision" is meant for the owner. Any other kind a post carries is still an agent's note: `args?.kind` in place of `=== "decision"` let it through.
test("must still refuse: a post with any kind but decision (note, Decision, an empty kind) on a card thread the owner never wrote in", async () => {
  const { manager, count } = await make();
  for (const kind of ["note", "Decision", "decision ", "status", ""]) {
    const r = await manager({ thread_id: "card-a", body: "a note for Admin", kind });
    assert.equal(r.structuredContent?.refused?.rule, "agent-note-on-card", `kind ${JSON.stringify(kind)}: ${JSON.stringify(r.structuredContent)}`);
  }
  assert.equal(await count("card-a"), 0, "nothing written");
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

// #C1336 (11-20: an agent posted "resetting after this" on #C1331's thread through the shared connector, and the owner got "1 new reply"): the shared connector's post carries the same rule.
// The hint there is "send it to Manager by message". What stays allowed: answering him in a card thread he wrote in, the owner's free threads, an ask's thread, and a post with pictures.
test("the shared door refuses an agent's post on a card thread the owner never wrote in, logged, nothing written, and the hint says to message Manager", async () => {
  const { env, shared, count } = await make();
  for (const who of ["Builder", "Boardsmith", "Checker"]) {
    const r = await shared(who, { thread_id: "card-a", body: "resetting after this" });
    assert.equal(r.isError, true, who);
    assert.equal(r.structuredContent.refused.rule, "agent-note-on-card", who);
    assert.match(r.structuredContent.refused.detail, /send it to Manager by message/);
    assert.doesNotMatch(r.structuredContent.refused.detail, /note for an agent goes by send_message to that agent/, "the shared hint is its own");
  }
  assert.equal(await count("card-a"), 0, "nothing written");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM refusals WHERE rule = 'agent-note-on-card'").first()).n, 3);
});

test("must still allow: on the shared door, an answer in a card thread the owner wrote in, the owner's free thread, an ask's thread, and a post with a picture", async () => {
  const { env, shared, count, ownerSays } = await make();
  await ownerSays("card-a");
  assert.equal((await shared("Builder", { thread_id: "card-a", body: "answering him" })).isError, false, "a card thread he wrote in");
  await env.DB.prepare("INSERT INTO threads (id, num, title, created_at) VALUES ('t-901', 901, 'Mine', ?)").bind(NOW - 5000).run();
  assert.equal((await shared("Builder", { thread_id: "t-901", body: "an answer" })).isError, false, "a free thread, which no card owns");
  const ask = await createAsk(env.DB, NOW, { type: "Thread", title: "Q", asked_by: "Boardsmith", text: "hello" });
  assert.equal(ask.ok, true, JSON.stringify(ask));
  assert.equal((await shared("Boardsmith", { thread_id: ask.id, body: "in the ask's thread" })).isError, false, "an ask's thread");
  assert.equal(await count("card-a"), 2);
  assert.equal((await createCard(env.DB, NOW, "Manager", { id: "card-b", title: "Another" })).ok, true);
  const shots = await shared("Designer", { thread_id: "card-b", body: "Look at this", screenshots: ["no-such-file"] });
  assert.notEqual(shots.structuredContent?.refused?.rule, "agent-note-on-card", "a post with a picture is not refused as an agent's note");
});

test("must still refuse on the shared door too: any kind but decision on a card thread the owner never wrote in; a decision is the decision rule's (Manager's door only)", async () => {
  const { shared, count } = await make();
  for (const kind of ["note", "status", ""]) {
    const r = await shared("Builder", { thread_id: "card-a", body: "a note", kind });
    assert.equal(r.structuredContent?.refused?.rule, "agent-note-on-card", `kind ${JSON.stringify(kind)}`);
  }
  const d = await shared("Builder", { thread_id: "card-a", body: "Which?", kind: "decision", options: [{ key: "A", label: "Yes" }, { key: "B", label: "No" }] });
  assert.equal(d.structuredContent.refused.rule, "decision-needs-manager-door");
  assert.equal(await count("card-a"), 0, "nothing written");
});
