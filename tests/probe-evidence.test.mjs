import test from "node:test";
import assert from "node:assert/strict";
import { evidenceWrites, postWrites, evidenceJob, stateArgs, liveWrite } from "../collector/probe-evidence.mjs";

const cfg = JSON.stringify({ liveUrl: "https://live.test/" });
const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test("live: the version from the liveUrl's /version.json, with a v; anything else writes nothing", async () => {
  let asked;
  assert.deepEqual(await liveWrite(cfg, { fetchImpl: async (u, o) => { asked = [u, o.redirect]; return { ok: true, json: async () => ({ version: "1.209.0", commit: "x" }) }; } }), { key: "live", value: { version: "v1.209.0" } });
  assert.deepEqual(asked, ["https://live.test/version.json", "error"]);
  assert.equal(await liveWrite(cfg, { fetchImpl: ok({ version: "main; drop table" }) }), null);
  assert.equal(await liveWrite(cfg, { fetchImpl: ok({}) }), null);
  assert.equal(await liveWrite(cfg, { fetchImpl: async () => ({ ok: false, status: 404 }) }), null);
  assert.equal(await liveWrite(cfg, { fetchImpl: async () => { throw new Error("down"); } }), null);
  assert.equal(await liveWrite(JSON.stringify({ liveUrl: "http://live.test/" }), { fetchImpl: ok({ version: "1.0.0" }) }), null);
  assert.equal(await liveWrite("not json", { fetchImpl: ok({ version: "1.0.0" }) }), null);
  assert.equal(await liveWrite("{}", { fetchImpl: ok({ version: "1.0.0" }) }), null);
});

test("the evidence job posts live last; the usage job never reads it", async () => {
  const posted = [];
  const run = (job) => evidenceJob({ job, base: "https://x.test", headers: {}, configPath: "/c.json", stateFile: "/s.json", build: async () => {},
    read: (p) => (p === "/c.json" ? cfg : JSON.stringify(state)), liveFetch: ok({ version: "1.209.0" }),
    fetchImpl: async (_u, o) => { posted.push(JSON.parse(o.body).key); return { ok: true, status: 200 }; } });
  assert.equal((await run("evidence")).written, 5);
  assert.equal(posted.at(-1), "live");
  posted.length = 0;
  await run("usage");
  assert.deepEqual(posted, ["usage"]);
});

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
