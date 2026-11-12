// #C996: the evidence job's posts. A run posted 122 keys one after another (15 to 20 s of a 77 to 90 s run on 11-11), ~110 of them cards whose
// reading had not changed. Now: POST_CONCURRENCY at a time; only a changed card's reading, plus every card again after REPOST_MS (the store reads a
// reading not rewritten for an hour as a stale repository copy); and posting stops cleanly before the job's limit with what went recorded.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { JOBS } from "../collector/probe-run.mjs";
import { postWrites, dueWrites, keptAfter, evidenceJob, evidenceWrites, POST_CONCURRENCY, REPOST_MS } from "../collector/probe-evidence.mjs";

const ARGS = { base: "https://x.test", headers: {} };
const writesOf = (n) => Array.from({ length: n }, (_, i) => ({ key: `cards.c${i}`, value: { phase: "build", at: 1 } }));

test("postWrites posts POST_CONCURRENCY at a time, every key goes, and one at a time keeps the order", async () => {
  let inFlight = 0, max = 0;
  const seen = [];
  const fetchImpl = async (_u, o) => { inFlight++; max = Math.max(max, inFlight); seen.push(JSON.parse(o.body).key); await new Promise((r) => setImmediate(r)); inFlight--; return { ok: true, status: 200 }; };
  const r = await postWrites(writesOf(30), { ...ARGS, fetchImpl });
  assert.equal(POST_CONCURRENCY, 6, "the card's number: six at once");
  assert.equal(max, 6, "six at once, not one at a time");
  assert.equal(r.written, 30);
  assert.deepEqual([...seen].sort(), writesOf(30).map((w) => w.key).sort());
  assert.deepEqual([...r.ok].sort(), [...seen].sort());
  const order = [];
  await postWrites(writesOf(8), { ...ARGS, concurrency: 1, fetchImpl: async (_u, o) => { order.push(JSON.parse(o.body).key); return { ok: true, status: 200 }; } });
  assert.deepEqual(order, writesOf(8).map((w) => w.key));
});

test("postWrites: a refusal is logged and the rest still go; another failure starts nothing new, lets those under way finish, and carries the keys that went", async () => {
  const logs = [];
  const r = await postWrites(writesOf(5), { ...ARGS, log: (l) => logs.push(l), fetchImpl: async (_u, o) => (JSON.parse(o.body).key === "cards.c2" ? { ok: false, status: 422, json: async () => ({ refusal: "x" }) } : { ok: true, status: 200 }) });
  assert.deepEqual([r.written, r.refused], [4, 1]);
  assert.match(logs[0], /cards\.c2 refused/);
  let started = 0;
  const fetchImpl = async (_u, o) => { started++; await new Promise((x) => setImmediate(x)); return JSON.parse(o.body).key === "cards.c7" ? { ok: false, status: 503 } : { ok: true, status: 200 }; };
  const err = await postWrites(writesOf(40), { ...ARGS, fetchImpl }).then(() => null, (e) => e);
  assert.match(err.message, /cards\.c7 answered 503/);
  assert.ok(Array.isArray(err.posted) && err.posted.length >= 1 && !err.posted.includes("cards.c7"));
  assert.ok(started < 40, `no new post after the failure (${started} started of 40)`);
  const thrown = await postWrites(writesOf(3), { ...ARGS, fetchImpl: async () => { throw new Error("network down"); } }).then(() => null, (e) => e);
  assert.match(thrown.message, /network down/);
  assert.deepEqual(thrown.posted, []);
});

test("postWrites: past the deadline no new post starts, and the result says so and which went", async () => {
  let t = 0;
  const r = await postWrites(writesOf(10), { ...ARGS, concurrency: 1, deadline: 3, clock: () => t, fetchImpl: async () => { t++; return { ok: true, status: 200 }; } });
  assert.equal(r.stopped, true);
  assert.deepEqual(r.ok, ["cards.c0", "cards.c1", "cards.c2"]);
  const all = await postWrites(writesOf(3), { ...ARGS, concurrency: 1, deadline: 100, clock: () => 0, fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.equal(all.stopped, false);
});

test("dueWrites: a card's unchanged reading waits, a changed one or one past REPOST_MS goes, every other key goes, and `at` is no change", () => {
  const NOW = 10_000_000;
  const w = [{ key: "cards.a", value: { phase: "build", ci: "none", at: NOW } }, { key: "cards.b", value: { phase: "ship", at: NOW } }, { key: "cards.c", value: { phase: "live", at: NOW } }, { key: "board", value: { at: NOW } }, { key: "agents", value: { Builder: { state: "idle" } } }];
  const first = dueWrites(w, null, NOW);
  assert.equal(first.due.length, 5, "nothing kept: everything goes");
  const kept = keptAfter(first, first.due.map((x) => x.key), NOW);
  assert.deepEqual(Object.keys(kept).sort(), ["cards.a", "cards.b", "cards.c"], "only cards are kept: the other keys always go");
  // A minute later: the same readings, read again (a new `at`), and card b changed.
  const later = w.map((x) => ({ ...x, value: { ...x.value, at: NOW + 60_000, ...(x.key === "cards.b" ? { phase: "live" } : {}) } }));
  const second = dueWrites(later, kept, NOW + 60_000);
  assert.deepEqual(second.due.map((x) => x.key), ["board", "agents", "cards.b"], "the other keys, then the one card that changed");
  assert.deepEqual(Object.keys(second.carried).sort(), ["cards.a", "cards.c"]);
  // Past REPOST_MS an unchanged reading goes again; at it, not yet.
  assert.equal(dueWrites(later, kept, NOW + REPOST_MS - 1).due.some((x) => x.key === "cards.a"), false);
  assert.equal(dueWrites(later, kept, NOW + REPOST_MS).due.some((x) => x.key === "cards.a"), true);
  // A time in the future (a clock set back) and an odd entry are due; a card no longer in the state is dropped from what is kept.
  assert.equal(dueWrites(w, { "cards.a": { h: kept["cards.a"].h, at: NOW + 5000 } }, NOW).due.some((x) => x.key === "cards.a"), true);
  assert.equal(dueWrites(w, { "cards.a": "junk", "cards.zzz": { h: "x", at: NOW } }, NOW).due.length, 5);
  const gone = dueWrites(w.slice(0, 1), kept, NOW + 1000);
  assert.deepEqual(Object.keys(keptAfter(gone, [], NOW + 1000)), ["cards.a"]);
  // After a run cut short: the keys that did not go lead the next, never-posted first, then oldest post first.
  const partial = keptAfter(dueWrites(w, null, NOW), ["cards.b"], NOW);
  const lead = dueWrites(w, partial, NOW + REPOST_MS + 1).due.filter((x) => x.key.startsWith("cards."));
  assert.deepEqual(lead.map((x) => x.key), ["cards.a", "cards.c", "cards.b"], "never posted first, the posted one last");
});

const T = 1_800_000_000_000;
const stateOf = (cards, at = T) => JSON.stringify({ v: 1, board: { boardId: "b", at, cardsCheckedAt: at }, cards: Object.fromEntries(Object.entries(cards).map(([id, phase]) => [id, { phase, at, ciMin: null }])), agents: {} });
function rig(over = {}) {
  const files = { "/s/state.json": stateOf({ a: "build", b: "build", c: "build" }) }, posted = [], lines = [];
  const job = () => ({
    job: "evidence", base: "https://x.example", headers: {}, configPath: "/c", stateFile: "/s/state.json", build: async () => ({ stdout: "" }), ghCheck: () => true,
    read: (p) => { if (p === "/c") return JSON.stringify({ collector: { repoPath: "/r" } }); if (p in files) return files[p]; throw new Error("none"); },
    write: (p, t) => { files[p] = t; },
    deployRead: async () => ({ worker: "", tree: "" }), liveFetch: async () => ({ ok: false, status: 500 }),
    fetchImpl: async (url, o) => { const b = JSON.parse(o.body); posted.push(b.key); return { ok: true, status: 200 }; }, log: (l) => lines.push(l), ...over,
  });
  return { files, posted, lines, run: () => evidenceJob(job()) };
}
const cardKeys = (posted) => posted.filter((k) => k.startsWith("cards."));

test("the job posts every card once, then only a changed one, and every card again after REPOST_MS", async () => {
  mock.timers.enable({ apis: ["Date"], now: T });
  try {
    const r = rig();
    await r.run();
    assert.deepEqual(cardKeys(r.posted).sort(), ["cards.a", "cards.b", "cards.c"], "the first run: all of them");
    assert.ok(r.posted.includes("board") && r.posted.includes("run.evidence"), "the other keys every run");
    r.posted.length = 0; mock.timers.tick(120_000);
    r.files["/s/state.json"] = stateOf({ a: "build", b: "build", c: "build" }, Date.now());
    await r.run();
    assert.deepEqual(cardKeys(r.posted), [], "two minutes later, the same readings (only `at` moved): no card");
    assert.ok(r.posted.includes("board"), "the heartbeat still goes");
    assert.ok(r.lines.some((l) => /^\d+ of \d+ key\(s\) due \(3 unchanged\)$/.test(l)), r.lines.join(" | "));
    r.posted.length = 0; mock.timers.tick(120_000);
    r.files["/s/state.json"] = stateOf({ a: "build", b: "ship", c: "build" }, Date.now());
    await r.run();
    assert.deepEqual(cardKeys(r.posted), ["cards.b"], "a changed reading goes at once");
    r.posted.length = 0; mock.timers.tick(REPOST_MS);
    r.files["/s/state.json"] = stateOf({ a: "build", b: "ship", c: "build" }, Date.now());
    await r.run();
    assert.deepEqual(cardKeys(r.posted).sort(), ["cards.a", "cards.b", "cards.c"], "every card again after REPOST_MS, whatever it says");
  } finally { mock.timers.reset(); }
});

test("a store that was down for a run is posted again from the start: nothing is kept for a key that did not go", async () => {
  mock.timers.enable({ apis: ["Date"], now: T });
  try {
    let down = true;
    const r = rig({ fetchImpl: async (_u, o) => { const b = JSON.parse(o.body); if (down) return { ok: false, status: 503 }; r.posted.push(b.key); return { ok: true, status: 200 }; } });
    await assert.rejects(r.run(), /answered 503/);
    down = false; mock.timers.tick(60_000);
    r.files["/s/state.json"] = stateOf({ a: "build", b: "build", c: "build" }, Date.now());
    await r.run();
    assert.deepEqual(cardKeys(r.posted).sort(), ["cards.a", "cards.b", "cards.c"]);
  } finally { mock.timers.reset(); }
});

test("a run that reaches its post deadline stops cleanly, records what went, and the cards left over lead the next run", async () => {
  mock.timers.enable({ apis: ["Date"], now: T });
  try {
    const cards = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`c${String(i).padStart(2, "0")}`, "build"]));
    // Each post takes 25 s here (a store gone slow): the few other keys use half the 150 s the job allows its posts, some cards go, then it stops.
    const r = rig({ fetchImpl: async (_u, o) => { const b = JSON.parse(o.body); r.posted.push(b.key); mock.timers.tick(25_000); return { ok: true, status: 200 }; } });
    r.files["/s/state.json"] = stateOf(cards);
    await r.run();
    const firstRun = cardKeys(r.posted);
    assert.ok(firstRun.length > 0 && firstRun.length < 12, `cut short: ${firstRun.length} of 12 cards went`);
    assert.ok(r.posted.includes("board"), "the heartbeat went before the cards");
    assert.ok(r.lines.some((l) => /^posts stopped at the deadline: \d+ of \d+ written, the rest go first next run$/.test(l)), r.lines.join(" | "));
    assert.deepEqual(Object.keys(JSON.parse(r.files["/s/evidence-posted.json"]).keys).sort(), [...firstRun].sort(), "only what went is recorded");
    // The next run, with a store that answers at once: exactly the cards that did not go (those that went are unchanged).
    const again = rig({});
    again.files["/s/state.json"] = stateOf(cards, Date.now());
    again.files["/s/evidence-posted.json"] = r.files["/s/evidence-posted.json"];
    await again.run();
    assert.deepEqual(cardKeys(again.posted).sort(), Object.keys(cards).map((k) => `cards.${k}`).filter((k) => !firstRun.includes(k)).sort());
  } finally { mock.timers.reset(); }
});

test("a child that ends at its own cap (limit less 15 s) leaves the job under the limit: no post starts past the deadline, the late writes included", async () => {
  mock.timers.enable({ apis: ["Date"], now: T });
  try {
    const limitMs = JOBS.evidence.limitSec * 1000;
    const files = {}, posted = [];
    const r = rig({
      build: async () => { mock.timers.tick(limitMs - 15_000); return { stdout: "" }; },
      fetchImpl: async (_u, o) => { posted.push(JSON.parse(o.body).key); mock.timers.tick(1_000); return { ok: true, status: 200 }; },
    });
    Object.assign(r.files, files);
    await r.run();
    assert.ok(Date.now() - T < limitMs, `the job ended at ${(Date.now() - T) / 1000} s of ${limitMs / 1000}`);
    assert.ok(Date.now() - T <= limitMs - 8_000, "room left for a post that was under way");
    assert.equal(cardKeys(posted).length, 0, "the child ended past the deadline: no card went, they lead the next run");
    assert.ok(posted.includes("board") && posted.includes("run.evidence"), "but the heartbeat and the run's own reading went, so the view does not freeze: " + posted.join(","));
    assert.ok(!posted.includes("live"), "the live read is skipped when the run is out of time");
    assert.ok(JSON.parse(r.files["/s/evidence-posted.json"]).keys["cards.a"] === undefined, "no card is recorded as posted");
  } finally { mock.timers.reset(); }
});

test("the usage job keeps no record and posts what it always did", async () => {
  const files = {}, posted = [];
  await evidenceJob({
    job: "usage", base: "https://x.example", headers: {}, configPath: "/c", stateFile: "/s/state.json", build: async () => ({ stdout: "" }), ghCheck: () => true,
    read: (p) => { if (p === "/c") return JSON.stringify({ collector: { repoPath: "/r" } }); if (p === "/s/state.json") return JSON.stringify({ v: 1, board: { boardId: "b", at: T }, cards: {}, agents: {}, usage: { x: 1 } }); throw new Error("none"); },
    write: (p, t) => { files[p] = t; }, fetchImpl: async (_u, o) => { posted.push(JSON.parse(o.body).key); return { ok: true, status: 200 }; }, log: () => {}, actions: { gh: () => { throw new Error("none"); } },
  }).catch(() => {});
  assert.deepEqual(posted, ["usage"]);
  assert.equal(Object.keys(files).some((p) => p.endsWith("evidence-posted.json")), false);
  assert.ok(evidenceWrites);
});
