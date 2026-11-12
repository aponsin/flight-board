// #C1009: on the store the page never says "Not sent". Ping is a threadPings write the store turns into a wake row that Manager's next
// read takes; the page shows "Pinged HH:MM" from the view's threadPings; replies say "Saved. Manager has it."; a bare owner Ack leaves
// a thread answered. (the owner's #T1858, 11-12: "Not sent" and "unanswered 5 min" although Manager had read and answered.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { loadNames } from "./harness.mjs";
import { takeInbox } from "../worker/board-store.mjs";

const NOW = 1_800_000_000_000;
const WHO = { manager: { who: "Manager", role: "agent" }, owner: { who: "owner", role: "owner" } };
const make = () => {
  const env = { DB: makeDb(), FILES: { put: async () => {}, get: async () => null, delete: async () => {} } };
  const call = (as, path, init = {}, now = NOW) => worker.fetch(new Request(`https://board.test${path}`, init.method === "POST" ? { ...init, headers: { "content-type": "application/json", "x-as": as, ...init.headers } } : { ...init, headers: { "x-as": as, ...init.headers } }), env, null, now, async (req) => WHO[req.headers.get("x-as")] ?? null);
  const tool = async (as, name, args, now = NOW) => (await (await call(as, "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }, now)).json()).result.structuredContent;
  const write = async (w, now = NOW) => { const r = await call("owner", "/api/compat/write", { method: "POST", body: JSON.stringify(w) }, now); return { status: r.status, body: await r.json().catch(() => null) }; };
  const compat = async () => (await (await call("owner", "/api/compat")).json()).collections;
  return { env, tool, write, compat };
};
const pingOf = (id, at = NOW) => ({ op: "set", path: `threadPings/${id}`, data: { at } });

test("a Ping is stored: Manager's next read has it, the view's threadPings shows when, and a read takes it", async () => {
  const { env, tool, write, compat } = make();
  const { id } = await tool("manager", "ask", { type: "Answer", title: "Is it live?", question: "Is it live?" });
  const r = await write(pingOf(id));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await compat()).threadPings, [{ id, at: NOW }]);
  const got = await takeInbox(env.DB, NOW + 1);
  assert.equal(got.stalls.length, 1, "the ping is for Manager");
  assert.match(got.stalls[0].reason, new RegExp(`pinged thread ${id}`));
  assert.equal((await takeInbox(env.DB, NOW + 2)).stalls.length, 0, "taken: not sent again");
  // A second press, later, is a new wake.
  assert.equal((await write(pingOf(id), NOW + 120_000)).status, 200);
  assert.equal((await takeInbox(env.DB, NOW + 120_001)).stalls.length, 1);
});

test("a Ping on a thread the store does not know is refused by name; a delete has no route", async () => {
  const { write } = make();
  const r = await write(pingOf("no-such-thread"));
  assert.notEqual(r.status, 200);
  assert.match(JSON.stringify(r.body), /thread-unknown/);
  assert.notEqual((await write({ op: "delete", path: "threadPings/x" })).status, 200);
});

// The page side: on the store no send can fail, so no line says "Not sent"; the page's own code is read from its source.
const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
test("the page's store replies say Manager has it, never Not sent, and sendPing needs no connector there", () => {
  assert.match(page, /async function sendPing\(anchor,text,ref\)\{let opening=false;\s*if\(STORE\)return true;/);
  assert.match(page, /STORE\?"Saved\. Manager has it\."/g);
  assert.match(page, /STORE\?"Manager has it\."/);
  assert.match(page, /how==="sent"&&!STORE\?"Sent":"Saved"/);
});

test("a bare owner Ack after the team spoke leaves the thread answered; a real question still waits", () => {
  const b = loadNames(["threadOpen", "threadOf", "ackOnly", "itemOf"]);
  const m = (thread, from, text, at) => ({ id: `m${at}`, thread, from, text, at });
  Object.assign(b.state, {
    waiting: [], initRaw: [], initiatives: [], todo: [], ideas: [], threads: [],
    messages: [m("t-a", "Owner", "Is it live?", 1), m("t-a", "Manager", "Yes", 2), m("t-a", "Owner", "Ack.", 3),
      m("t-b", "Owner", "Is it live?", 1), m("t-b", "Manager", "Yes", 2), m("t-b", "Owner", "Why not sooner?", 3),
      m("t-c", "Owner", "ok", 1)],
  });
  assert.equal(b.threadOpen("t-a"), false);
  assert.equal(b.threadOpen("t-b"), true);
  assert.equal(b.threadOpen("t-c"), true, "nobody has answered yet: even a lone 'ok' is the owner's word to answer");
});
