import test from "node:test";
import assert from "node:assert/strict";
import { evidenceWrites, postWrites, evidenceJob, stateArgs } from "../collector/probe-evidence.mjs";

const state = {
  board: { boardId: "b", at: 5 },
  cards: { "card-a": { phase: "build", signed: [], onMain: false }, "card-b": { phase: null }, "Bad Id": { phase: "plan" } },
  agents: { Builder: { state: "working" } },
  ctx: { Builder: { pct: 9 } },
  usage: { weekPct: 12 },
};

test("evidence job: one lit phase per read card, plus agents, ctx and board; no usage", () => {
  const w = evidenceWrites(state, "evidence");
  assert.deepEqual(w.map((x) => x.key), ["cards.card-a", "agents", "ctx", "board"]);
  assert.deepEqual(w[0].value.lit, ["build"]);
  assert.equal(w[0].value.onMain, false);
});

test("usage job writes only usage, and nothing when there is no tile", () => {
  assert.deepEqual(evidenceWrites(state, "usage"), [{ key: "usage", value: { weekPct: 12 } }]);
  assert.deepEqual(evidenceWrites({ ...state, usage: undefined }, "usage"), []);
  assert.deepEqual(evidenceWrites(null, "evidence"), []);
});

test("a refused key is logged and the rest still go; another failure stops", async () => {
  const seen = [], logs = [];
  const f = async (_u, o) => { const k = JSON.parse(o.body).key; seen.push(k); return k === "ctx" ? { ok: false, status: 422, json: async () => ({ refusal: "evidence-key" }) } : { ok: true, status: 200 }; };
  const r = await postWrites([{ key: "cards.a", value: {} }, { key: "ctx", value: {} }, { key: "agents", value: {} }], { base: "https://x.test", headers: {}, fetchImpl: f, log: (l) => logs.push(l) });
  assert.deepEqual(r, { written: 2, refused: 1 });
  assert.equal(seen.length, 3);
  assert.match(logs[0], /ctx refused/);
  await assert.rejects(postWrites([{ key: "a", value: {} }], { base: "https://x.test", headers: {}, fetchImpl: async () => ({ ok: false, status: 503 }) }), /answered 503/);
});

test("the job builds the state without posting it, reads it, and posts the job's keys", async () => {
  let args, posted = [];
  const r = await evidenceJob({
    job: "evidence", base: "https://x.test", headers: {}, configPath: "/c.json", stateFile: "/s.json",
    build: async (a) => { args = a; }, read: () => JSON.stringify(state),
    fetchImpl: async (_u, o) => { posted.push(JSON.parse(o.body).key); return { ok: true, status: 200 }; },
  });
  assert.ok(args.includes("--no-post") && args.includes("--no-derive"));
  assert.deepEqual(stateArgs("/c.json").slice(1, 3), ["--config", "/c.json"]);
  assert.equal(r.written, 4);
  assert.deepEqual(posted, ["cards.card-a", "agents", "ctx", "board"]);
});
