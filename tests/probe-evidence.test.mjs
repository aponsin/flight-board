import test from "node:test";
import assert from "node:assert/strict";
import { evidenceWrites, postWrites, evidenceJob, stateArgs, liveWrite } from "../collector/probe-evidence.mjs";

// The real board config's shape: liveUrl is under collector, and the top level has none.
const cfg = JSON.stringify({ liveUrl: null, collector: { liveUrl: "https://live.test/" } });
const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test("live: the version from the liveUrl's /version.json, with a v; anything else writes nothing", async () => {
  let asked;
  assert.deepEqual(await liveWrite(cfg, { fetchImpl: async (u, o) => { asked = [u, o.redirect]; return { ok: true, json: async () => ({ version: "1.209.0", commit: "x" }) }; } }), { key: "live", value: { version: "v1.209.0" } });
  assert.deepEqual(asked, ["https://live.test/version.json", "error"]);
  assert.equal(await liveWrite(cfg, { fetchImpl: ok({ version: "main; drop table" }) }), null);
  assert.equal(await liveWrite(cfg, { fetchImpl: ok({}) }), null);
  assert.equal(await liveWrite(cfg, { fetchImpl: async () => ({ ok: false, status: 404 }) }), null);
  assert.equal(await liveWrite(cfg, { fetchImpl: async () => { throw new Error("down"); } }), null);
  assert.equal(await liveWrite(cfg, { fetchImpl: ok({ version: "x1.2.3" }) }), null);
  assert.equal(await liveWrite(cfg, { fetchImpl: ok({ version: "1.2.3\nextra" }) }), null);
  const logs = [];
  assert.equal(await liveWrite(JSON.stringify({ collector: { liveUrl: "http://live.test/" } }), { fetchImpl: ok({ version: "1.0.0" }), log: (l) => logs.push(l) }), null);
  assert.equal(await liveWrite("not json", { fetchImpl: ok({ version: "1.0.0" }), log: (l) => logs.push(l) }), null);
  // The old fixture put liveUrl at the top level; the real config has none there, so it is not read.
  assert.equal(await liveWrite(JSON.stringify({ liveUrl: "https://live.test/" }), { fetchImpl: ok({ version: "1.0.0" }), log: (l) => logs.push(l) }), null);
  assert.equal(logs.length, 3, "each unusable liveUrl says so in the log");
  assert.match(logs[0], /collector\.liveUrl/);
});

test("the evidence job posts live last; the usage job never reads it", async () => {
  const posted = [];
  const run = (job) => evidenceJob({ job, base: "https://x.test", headers: {}, configPath: "/c.json", stateFile: "/s.json", build: async () => {}, sessionsRead: () => [],
    read: (p) => (p === "/c.json" ? cfg : JSON.stringify(state)), liveFetch: ok({ version: "1.209.0" }),
    fetchImpl: async (_u, o) => { posted.push(JSON.parse(o.body).key); return { ok: true, status: 200 }; } });
  assert.equal((await run("evidence")).written, 8, "the state's four keys, this run's own reading (#C962), look (#C956), the scheduled tasks' models (#C1006), then live");
  assert.equal(posted.at(-1), "live");
  assert.equal(posted.at(-2), "schedule.models");
  assert.equal(posted.at(-3), "look");
  posted.length = 0;
  await run("usage");
  assert.deepEqual(posted, ["usage"]);
});

test("a product site that never answers delays no evidence write: live is read after them", async () => {
  const order = [];
  const r = await evidenceJob({ job: "evidence", base: "https://x.test", headers: {}, configPath: "/c.json", stateFile: "/s.json", build: async () => {}, sessionsRead: () => [],
    read: (p) => (p === "/c.json" ? cfg : JSON.stringify(state)),
    liveFetch: async () => { order.push("live read"); throw new Error("timed out"); },
    fetchImpl: async (_u, o) => { order.push(JSON.parse(o.body).key); return { ok: true, status: 200 }; } });
  // #C996: the other keys go before the cards (the heartbeat is never starved by a long run of cards), then live read, look and the scheduled tasks' models (#C1006) as before.
  assert.deepEqual(order, ["agents", "ctx", "board", "run.evidence", "cards.card-a", "live read", "look", "schedule.models"], "look (#C956) and the models (#C1006) are posted after the product site was asked, and never wait on it");
  assert.equal(r.written, 7);
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

test("evidence job also writes stuck and ship when the state has them (#C723 B3a), and nothing for a state without", () => {
  const stuck = { Builder: { kind: "step", card: "card-a", since: 5 } }, ship = { version: null, ci: "running", at: 5 };
  const w = evidenceWrites({ ...state, stuck, ship }, "evidence");
  assert.deepEqual(w.map((x) => x.key), ["cards.card-a", "agents", "ctx", "board", "stuck", "ship"]);
  assert.deepEqual(w.find((x) => x.key === "ship").value, ship);
  assert.deepEqual(evidenceWrites(state, "evidence").map((x) => x.key), ["cards.card-a", "agents", "ctx", "board"]);
  assert.ok(!evidenceWrites({ ...state, stuck, ship }, "usage").some((x) => x.key === "stuck" || x.key === "ship"), "the usage job writes only usage");
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
  assert.deepEqual([r.written, r.refused], [2, 1]);
  assert.deepEqual(r.ok.sort(), ["agents", "cards.a"], "the keys that went (#C996: the caller records them)");
  assert.equal(r.stopped, false);
  assert.equal(seen.length, 3);
  assert.match(logs[0], /ctx refused/);
  await assert.rejects(postWrites([{ key: "a", value: {} }], { base: "https://x.test", headers: {}, fetchImpl: async () => ({ ok: false, status: 503 }) }), /answered 503/);
});

test("the job builds the state without posting it, reads it, and posts the job's keys", async () => {
  let args, posted = [];
  const r = await evidenceJob({
    job: "evidence", base: "https://x.test", headers: {}, configPath: "/c.json", stateFile: "/s.json",
    build: async (a) => { args = a; }, read: () => JSON.stringify(state), sessionsRead: () => [],
    fetchImpl: async (_u, o) => { posted.push(JSON.parse(o.body).key); return { ok: true, status: 200 }; },
  });
  assert.ok(args.includes("--no-post") && args.includes("--no-derive"));
  assert.deepEqual(stateArgs("/c.json").slice(1, 3), ["--config", "/c.json"]);
  assert.equal(r.written, 7);
  assert.deepEqual(posted, ["agents", "ctx", "board", "run.evidence", "cards.card-a", "look", "schedule.models"], "the state's keys (the other keys before the cards, #C996) and this run's reading, then the lanes from the config (#C956) and the scheduled tasks' models (#C1006)");
});
