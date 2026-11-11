// The #C726 hooks in the store and the write router (Security's mutation findings on d2617ac): an ask with a bad screenshot is
// refused and stored nowhere, and a refused answer links no file.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";

const NOW = 1_800_000_000_000;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const fakeR2 = () => {
  const m = new Map();
  return { m, put: async (k, v, o) => { m.set(k, { bytes: new Uint8Array(v), type: o?.httpMetadata?.contentType }); }, get: async (k) => (m.has(k) ? { body: m.get(k).bytes } : null), delete: async (k) => { m.delete(k); } };
};
const WHO = { manager: { who: "Manager", role: "agent" }, owner: { who: "owner", role: "owner" } };
const make = () => {
  const env = { DB: makeDb(), FILES: fakeR2() };
  const call = (as, path, init = {}) => worker.fetch(new Request(`https://board.test${path}`, init.method === "POST" ? { ...init, headers: { "content-type": "application/json", "x-as": as, ...init.headers } } : { ...init, headers: { "x-as": as, ...init.headers } }), env, null, NOW, async (req) => WHO[req.headers.get("x-as")] ?? null);
  const tool = async (as, name, args) => (await (await call(as, "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.structuredContent;
  const write = async (w) => { const r = await call("owner", "/api/compat/write", { method: "POST", body: JSON.stringify(w) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const upload = async (name, type, bytes) => (await (await call("owner", "/api/files", { method: "POST", body: JSON.stringify({ name, type, data: Buffer.from(bytes).toString("base64") }) })).json());
  return { env, tool, write, upload };
};
const decision = { type: "Decision", title: "Hero", question: "Which hero?", options: ["Blue", "Green"], recommended: "Blue", related_thread: "none" };
const count = async (env, sql) => (await env.DB.prepare(sql).first()).n;

test("an ask whose screenshots name an unknown id, a non-image file or a plain URL is refused and stores no ask (createAsk hook)", async () => {
  const { env, tool, upload } = make();
  const txt = await upload("log.txt", "text/plain", new TextEncoder().encode("x"));
  assert.ok(txt.id, "the text file is stored");
  for (const [shot, rule] of [["zzzzzzzzzzzzzzzzzzzz", "file-unknown"], [txt.id, "screenshots-shape"], ["https://evil.example/x.png", "screenshots-shape"]]) {
    const r = await tool("manager", "ask", { ...decision, screenshots: [shot] });
    assert.equal(r.refused?.rule ?? r.rule, rule, shot);
  }
  assert.equal(await count(env, "SELECT COUNT(*) AS n FROM asks"), 0, "no ask was stored");
  assert.equal(await count(env, "SELECT COUNT(*) AS n FROM refusals WHERE rule IN ('file-unknown','screenshots-shape')"), 3, "each refusal is logged");
});

test("a refused answer links no file: an answered Decision and a bad choice, each with a stored file", async () => {
  const { env, tool, write, upload } = make();
  const img = await upload("hero.png", "image/png", PNG);
  const { id } = await tool("manager", "ask", decision);
  const badChoice = await write({ op: "update", path: `waiting/${id}`, data: { response: { status: "chose", choice: "Z", note: "", files: [img.id], at: 1 } } });
  assert.equal(badChoice.status, 422);
  assert.equal(await count(env, "SELECT COUNT(*) AS n FROM file_links"), 0, "a bad choice links nothing");
  assert.equal((await write({ op: "update", path: `waiting/${id}`, data: { response: { status: "chose", choice: "B", note: "", at: 1 } } })).status, 200);
  const again = await write({ op: "update", path: `waiting/${id}`, data: { response: { status: "chose", choice: "A", note: "", files: [img.id], at: 2 } } });
  assert.equal(again.status, 422); assert.equal(again.body.refused.rule, "ask-already-answered");
  assert.equal(await count(env, "SELECT COUNT(*) AS n FROM file_links"), 0, "an already-answered ask links nothing");
  const other = await tool("manager", "ask", decision);
  assert.equal((await write({ op: "update", path: `waiting/${other.id}`, data: { response: { status: "chose", choice: "A", note: "", files: [img.id], at: 3 } } })).status, 200);
  assert.equal(await count(env, "SELECT COUNT(*) AS n FROM file_links WHERE ref_id = '" + other.id + "'"), 1, "a good answer links its file");
});
