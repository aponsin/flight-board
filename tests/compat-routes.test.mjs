// GET /api/compat and POST /api/compat/write (#C723 A2/A3) through the Worker, on the same in-memory D1 as the other Worker tests.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { takeInbox, answerAsk, postMessage } from "../worker/board-store.mjs";

const NOW = 1_800_000_000_000;
const WHO = { manager: { who: "Manager", role: "agent" }, owner: { who: "owner", role: "owner" }, probe: { who: "probe", role: "probe" } };
const make = () => {
  const env = { DB: makeDb() };
  const call = (as, path, init = {}) => worker.fetch(new Request(`https://board.test${path}`, init.method === "POST" ? { ...init, headers: { "content-type": "application/json", "x-as": as, ...init.headers } } : { ...init, headers: { "x-as": as, ...init.headers } }), env, null, NOW, async (req) => WHO[req.headers.get("x-as")] ?? null);
  const tool = async (as, name, args) => (await (await call(as, "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.structuredContent;
  const write = async (w, as = "owner") => { const r = await call(as, "/api/compat/write", { method: "POST", body: JSON.stringify(w) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const compat = async () => (await call("owner", "/api/compat")).json();
  return { env, call, tool, write, compat };
};
const decision = { type: "Decision", title: "Hero", question: "Which hero?", options: ["Blue", "Green"], recommended: "Blue" };

test("GET /api/compat answers in the old shapes, with an ETag and a 304", async () => {
  const { call, tool } = make();
  await tool("manager", "ask", decision);
  const r = await call("owner", "/api/compat");
  assert.equal(r.status, 200); const etag = r.headers.get("etag"); assert.match(etag, /^"c-/);
  const body = await r.json();
  assert.equal(body.collections.waiting.length, 1); assert.equal(body.collections.waiting[0].kind, "decision"); assert.equal(body.collections.waiting[0].options[1].key, "B");
  assert.equal((await call("owner", "/api/compat", { headers: { "if-none-match": etag } })).status, 304);
  assert.equal((await call("probe", "/api/compat")).status, 403);
});

test("a choice by key is stored as the option's own text; a key that is no option is refused", async () => {
  const { tool, write, compat } = make();
  const { id } = await tool("manager", "ask", decision);
  const bad = await write({ op: "update", path: `waiting/${id}`, data: { response: { status: "chose", choice: "Z", note: "", at: 1 } } });
  assert.equal(bad.status, 422); assert.equal(bad.body.refused.rule, "answer-not-an-option");
  const ok = await write({ op: "update", path: `waiting/${id}`, data: { response: { status: "chose", choice: "B", note: "", at: 1 }, respondedAt: 1 } });
  assert.equal(ok.status, 200);
  assert.equal((await compat()).collections.waiting[0].response.choice, "B");
  assert.equal((await write({ op: "update", path: `waiting/${id}`, data: { response: { status: "chose", choice: "A", note: "", at: 2 } } })).body.refused.rule, "ask-already-answered");
});

test("Ack and Done answer a non-Decision; a Decision refuses them; a ping alone is accepted and stores nothing", async () => {
  const { tool, write } = make();
  const a = await tool("manager", "ask", { type: "Answer", title: "Is it live?", question: "Is it live?" });
  assert.equal((await write({ op: "update", path: `waiting/${a.id}`, data: { ping: "sent" } })).status, 200);
  assert.equal((await write({ op: "update", path: `waiting/${a.id}`, data: { response: { status: "ack", note: "", at: 1 } } })).status, 200);
  const d = await tool("manager", "ask", decision);
  assert.equal((await write({ op: "update", path: `waiting/${d.id}`, data: { response: { status: "ack", note: "", at: 1 } } })).body.refused.rule, "answer-status");
});

test("asks in full (B2): a note with a choice, something else, help, and the button and note come back whole", async () => {
  const { tool, write, compat } = make();
  const resp = async (id) => (await compat()).collections.waiting.find((w) => w.id === id).response;
  // a choice with a note: the option's own text is the answer, the note rides along
  const d1 = await tool("manager", "ask", decision);
  assert.equal((await write({ op: "update", path: `waiting/${d1.id}`, data: { response: { status: "chose", choice: "B", note: "  but keep the logo  ", at: 1 } } })).status, 200);
  assert.deepEqual({ ...await resp(d1.id), at: 0 }, { status: "chose", choice: "B", note: "but keep the logo", at: 0 });
  // something else: needs its note; the note is what the agent reads
  const d2 = await tool("manager", "ask", decision);
  const bare = await write({ op: "update", path: `waiting/${d2.id}`, data: { response: { status: "chose", choice: "something else", note: "", at: 1 } } });
  assert.equal(bare.body.refused.rule, "answer-needs-note");
  assert.equal((await write({ op: "update", path: `waiting/${d2.id}`, data: { response: { status: "chose", choice: "something else", note: "Make it red", at: 1 } } })).status, 200);
  const r2 = await resp(d2.id); assert.equal(r2.status, "chose"); assert.equal(r2.choice, "something else"); assert.equal(r2.note, "Make it red");
  // help on an action needs a note and keeps it; done and ack keep theirs
  const a = await tool("manager", "ask", { type: "Action", title: "Run it", steps: ["Open Terminal", { text: "Run this", cmd: "node a.mjs" }], expect: "OK" });
  assert.equal((await write({ op: "update", path: `waiting/${a.id}`, data: { response: { status: "help", note: "", at: 1 } } })).body.refused.rule, "answer-needs-note");
  assert.equal((await write({ op: "update", path: `waiting/${a.id}`, data: { response: { status: "help", note: "it printed an error", at: 1 } } })).status, 200);
  const r3 = await resp(a.id); assert.equal(r3.status, "help"); assert.equal(r3.note, "it printed an error");
  const doc = (await compat()).collections.waiting.find((w) => w.id === a.id);
  assert.deepEqual(doc.steps[1], { text: "Run this", cmd: "node a.mjs" });
  // a status the type does not have, and a Decision answered "done", are refused by name
  const a2 = await tool("manager", "ask", { type: "Answer", title: "Live?", question: "Live?" });
  assert.equal((await write({ op: "update", path: `waiting/${a2.id}`, data: { response: { status: "help", note: "x", at: 1 } } })).body.refused.rule, "answer-status");
  const d3 = await tool("manager", "ask", decision);
  assert.equal((await write({ op: "update", path: `waiting/${d3.id}`, data: { response: { status: "done", note: "", at: 1 } } })).body.refused.rule, "answer-status");
  // an answer with a follow-up note: Manager's inbox carries status and note
  const a3 = await tool("manager", "ask", { type: "Answer", title: "Fixed?", question: "Fixed?" });
  await write({ op: "update", path: `waiting/${a3.id}`, data: { response: { status: "ack", note: "and the footer?", at: 1 } } });
  assert.equal((await resp(a3.id)).note, "and the footer?");
});

test("Manager's inbox carries the answer's button and note, and a note over the cap is refused (#C725 B2)", async () => {
  const { env, tool, write } = make();
  const a = await tool("manager", "ask", { type: "Action", title: "Run it", steps: ["Open Terminal"], expect: "OK" });
  const long = await write({ op: "update", path: `waiting/${a.id}`, data: { response: { status: "help", note: "x".repeat(2001), at: 1 } } });
  assert.equal(long.body.refused.rule, "answer-shape");
  assert.equal((await write({ op: "update", path: `waiting/${a.id}`, data: { response: { status: "help", note: "x".repeat(2000), at: 1 } } })).status, 200);
  const d = await tool("manager", "ask", decision);
  await write({ op: "update", path: `waiting/${d.id}`, data: { response: { status: "chose", choice: "something else", note: "Make it red", at: 1 } } });
  const inbox = await takeInbox(env.DB, NOW + 1000);
  const byId = Object.fromEntries(inbox.answers.map((x) => [x.id, x]));
  assert.equal(byId[a.id].answer_status, "help"); assert.equal(byId[a.id].answer_note.length, 2000);
  assert.equal(byId[d.id].answer_status, "other"); assert.equal(byId[d.id].answer_note, "Make it red"); assert.equal(byId[d.id].answer, "Make it red");
});

test("only a Decision has a something-else answer (#C725 B2)", async () => {
  const { env, tool } = make();
  const a = await tool("manager", "ask", { type: "Action", title: "Run it", steps: ["Open Terminal"], expect: "OK" });
  const r = await answerAsk(env.DB, NOW, "owner", { id: a.id, status: "ack", other: true, note: "something else" });
  assert.equal(r.refused?.rule, "answer-shape", JSON.stringify(r));
  const row = await env.DB.prepare("SELECT answered_at FROM asks WHERE id = ?").bind(a.id).first();
  assert.equal(row.answered_at, null, "nothing stored");
});

test("options on an agent's message (B1b): drawn from the thread's last word; the owner's pick is his own message; bad shapes are refused", async () => {
  const { env, tool, write, compat } = make();
  const { id } = await tool("manager", "ask", { type: "Answer", title: "Colour?", question: "Colour?" });
  const options = [{ key: "A", label: "Red" }, { key: "B", label: "Blue" }];
  const ok = await tool("manager", "post", { thread_id: id, body: "Which colour?", kind: "decision", options });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const m = (await compat()).collections.messages.find((x) => x.id === ok.id);
  assert.equal(m.kind, "decision"); assert.deepEqual(m.options, options); assert.equal(m.from, "Manager");
  // the owner's pick is an ordinary message of his
  const pick = await write({ op: "set", path: "messages/m1-pick", data: { thread: id, from: "owner", text: "Chose A: Red", at: 1 } });
  assert.equal(pick.status, 200, JSON.stringify(pick.body));
  // bad shapes: options without the decision kind, one option, a key twice, a key outside A to D, an extra field, a bad kind
  for (const [args, rule] of [
    [{ options }, "message-shape"],
    [{ kind: "decision", options: [options[0]] }, "message-options"],
    [{ kind: "decision", options: [options[0], { key: "A", label: "Again" }] }, "message-options"],
    [{ kind: "decision", options: [options[0], { key: "E", label: "Green" }] }, "message-options"],
    [{ kind: "decision", options: [options[0], { key: "B", label: "Blue", extra: 1 }] }, "message-options"],
    [{ kind: "Decision" }, "message-shape"],
    [{ kind: "decision", options: [options[0], { key: "B", label: "x".repeat(201) }] }, "message-options"],
    [{ kind: "decision", options: [options[0], { key: "B", label: "   " }] }, "message-options"],
  ]) { const r = await tool("manager", "post", { thread_id: id, body: "x", ...args }); assert.equal(r.refused?.rule, rule, JSON.stringify(args)); }
  // a label of exactly 200 characters passes
  const edge = await tool("manager", "post", { thread_id: id, body: "edge", kind: "decision", options: [options[0], { key: "B", label: "x".repeat(200) }] });
  assert.equal(edge.ok, true, JSON.stringify(edge));
  // a field the store does not know is refused at the store itself (the tool's schema is not the only guard)
  const odd = await postMessage(env.DB, NOW, "Manager", { thread_id: id, body: "x", author: "owner" });
  assert.equal(odd.refused?.rule, "message-shape", JSON.stringify(odd));
  // the owner's message carries neither
  const own = await tool("owner", "post", { thread_id: id, body: "x", kind: "decision", options });
  assert.equal(own.refused?.rule, "message-shape");
});

test("card fields the old page draws (B4a): depends-on, issue counts with their time, queue place, and the thread a card came from", async () => {
  const { tool, compat } = make();
  const ask = await tool("manager", "ask", { type: "Answer", title: "Start?", question: "Start?" });
  const a = await tool("manager", "card_create", { id: "card-a", title: "A", from_thread: ask.num });
  assert.equal(a.ok, true, JSON.stringify(a));
  const b = await tool("manager", "card_create", { id: "card-b", title: "B", depends_on: ["card-a"], issues: { bugs: 2, security: 1 }, queue_pos: 3, owner_role: "Builder" });
  assert.equal(b.ok, true, JSON.stringify(b));
  const docs = (await compat()).collections.initiatives, da = docs.find((x) => x.id === "card-a"), db = docs.find((x) => x.id === "card-b");
  assert.deepEqual(db.dependsOn, ["card-a"]); assert.deepEqual(db.issues, { bugs: 2, security: 1 }); assert.equal(db.queuePos, 3); assert.ok(db.issuesAt > 0);
  assert.equal(da.dependsOn, undefined); assert.equal(da.issues, undefined); assert.equal(da.queuePos, undefined);
  assert.equal(da.thread, ask.id, "the card names its thread by id, not by number");
  // an update changes them; issues_at moves with the counts, and null clears
  assert.equal((await tool("manager", "card_update", { id: "card-b", issues: { bugs: 3 }, queue_pos: 1 })).ok, true);
  const after = (await compat()).collections.initiatives.find((x) => x.id === "card-b");
  assert.deepEqual(after.issues, { bugs: 3 }); assert.equal(after.queuePos, 1);
  assert.equal((await tool("manager", "card_update", { id: "card-b", issues: null, depends_on: null, queue_pos: null })).ok, true);
  const gone = (await compat()).collections.initiatives.find((x) => x.id === "card-b");
  assert.equal(gone.issues, undefined); assert.equal(gone.dependsOn, undefined); assert.equal(gone.queuePos, undefined); assert.equal(gone.issuesAt, undefined);
  // each bad shape is refused by name
  for (const [fields, rule] of [
    [{ depends_on: ["Card A"] }, "card-depends"], [{ depends_on: ["card-a", "card-a"] }, "card-depends"], [{ depends_on: Array.from({ length: 9 }, (_, i) => `c${i}`) }, "card-depends"],
    [{ issues: { bugs: -1 } }, "card-issues"], [{ issues: { bugs: 100 } }, "card-issues"], [{ issues: { luck: 1 } }, "card-issues"], [{ issues: [1] }, "card-issues"], [{ issues: { bugs: 1.5 } }, "card-issues"],
    [{ queue_pos: 0 }, "card-queue"], [{ queue_pos: 1000 }, "card-queue"], [{ queue_pos: "2" }, "card-queue"],
  ]) { const r = await tool("manager", "card_update", { id: "card-b", ...fields }); assert.equal(r.refused?.rule, rule, JSON.stringify(fields)); }
});

test("a malformed step is refused when the ask is made", async () => {
  const { tool } = make();
  const r = await tool("manager", "ask", { type: "Action", title: "Run it", steps: [{ text: "x", cmd: 5 }], expect: "OK" });
  assert.equal(r.refused.rule, "steps-shape");
});

test("every route that does not exist yet is refused by name, and logged", async () => {
  const { tool, write, call } = make();
  const { id } = await tool("manager", "ask", decision);
  for (const w of [
    { op: "update", path: "checkRequests/c1", data: { at: 1 } },
  ]) { const r = await write(w); assert.equal(r.status, 422, JSON.stringify(w)); assert.equal(r.body.refused.rule, "no-route-yet", JSON.stringify(w)); }
  // #C726: files now go through the file store's checks; an id that is no stored file's id is refused by name, before anything is stored.
  const bad = await write({ op: "update", path: `waiting/${id}`, data: { response: { status: "chose", choice: "A", note: "", files: ["x"], at: 1 } } });
  assert.equal(bad.status, 422); assert.equal(bad.body.refused.rule, "files-shape");
  const view = await (await call("owner", "/api/view")).json();
  assert.ok(view.refusals.some((x) => x.rule === "no-route-yet"));
  assert.equal(view.asks[0].answered_at, null, "nothing was half-applied");
});

test("an ask the asker closed first: the owner's answer-and-done is refused whole, and nothing is stored (Checker)", async () => {
  const { tool, write, call } = make();
  const a = await tool("manager", "ask", { type: "Action", title: "Run it", steps: ["Run."], expect: "done" });
  await tool("manager", "ask_close", { id: a.id });
  const r = await write({ op: "update", path: `waiting/${a.id}`, data: { response: { status: "done", note: "", at: 1 }, done: true } });
  assert.equal(r.status, 422); assert.equal(r.body.refused.rule, "ask-already-closed");
  const view = await (await call("owner", "/api/view")).json();
  assert.equal(view.asks[0].answered_at, null, "no answer was stored");
  assert.equal((await write({ op: "update", path: `waiting/${a.id}`, data: { done: true } })).body.refused.rule, "ask-already-closed");
  assert.equal((await write({ op: "update", path: `waiting/${a.id}`, data: { ping: "sent" } })).status, 200, "a ping alone still passes");
});

test("to-do and idea rows: add, done, move", async () => {
  const { write, compat } = make();
  assert.equal((await write({ op: "set", path: "todo/t1", data: { text: "Buy milk", rank: 1, area: "home", addedAt: 1, done: false } })).status, 200);
  assert.equal((await write({ op: "set", path: "ideas/t2", data: { text: "An idea", rank: 1, addedAt: 1, done: false, kind: "idea" } })).status, 200);
  const c = (await compat()).collections;
  assert.equal(c.todo.length, 1); assert.equal(c.ideas.length, 1);
  const id = c.todo[0].id;
  assert.equal((await write({ op: "update", path: `todo/${id}`, data: { rank: 2 } })).status, 200);
  assert.equal((await write({ op: "update", path: `todo/${id}`, data: { done: true, doneAt: 5 } })).status, 200);
  assert.equal((await compat()).collections.todo[0].done, true);
  assert.equal((await write({ op: "update", path: `ideas/${c.ideas[0].id}`, data: { startAt: 1 } })).body.refused.rule, "no-route-yet");
});

test("only the owner writes, and the usual POST guards still hold", async () => {
  const { write, call } = make();
  assert.equal((await write({ op: "set", path: "todo/t1", data: { text: "x" } }, "manager")).status, 403);
  assert.equal((await call("owner", "/api/compat/write", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await write({ op: "frob", path: "todo/t1" })).status, 422);
  assert.equal((await write({ op: "set", path: "../x" })).status, 422);
});
