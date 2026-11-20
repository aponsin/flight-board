// #C1386: the truth check (a Studio job that compares each card's stored reading with git) writes evidence `truth`. The Worker takes it from the probe only, in one
// shape, passes it on while fresh, wakes Manager once per spell of disagreement, and serves the readings to the probe at GET /api/probe/readings.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { writeEvidence, readView, wakeAsk, takeInbox, createCard } from "../worker/board-store.mjs";
import { compatView, probeDoc } from "../worker/compat-view.mjs";
import { truthShape, truthWake, truthWakeLine, evidenceRefusal, TRUTH_CARD } from "../worker/board-rules.mjs";
import { readingDocs } from "../worker/compat-reading.mjs";
import worker from "../worker/board-worker.mjs";

const NOW = Date.now();
const M = 60_000;
const item = (over = {}) => ({ card: "c-one", num: 1301, field: "onMain", reading: "not on main", git: "on main at 3f2a", ...over });
const val = (over = {}) => ({ at: NOW - 5_000, count: 1, items: [item()], ...over });
const CLEAR = { at: NOW - 5_000, count: 0, items: [] };

async function store() {
  const db = makeDb();
  assert.equal((await writeEvidence(db, NOW - 10_000, "probe", "board", { boardId: "flight-board", at: NOW - 10_000, probe: "a".repeat(12), derivedAt: NOW - 600 * M, quietMin: 0 })).ok, true);
  return db;
}
const put = async (db, value, at = NOW - 5_000) => writeEvidence(db, at, "probe", "truth", value);

test("the shape: the contract accepts, anything else is refused as truth-shape", async () => {
  assert.equal(truthShape(val()), true);
  assert.equal(truthShape(CLEAR), true);
  assert.equal(truthShape(val({ count: 500, items: [item({ num: null })] })), true, "num may be null");
  assert.equal(truthShape(val({ count: 10, items: Array.from({ length: 10 }, () => item()) })), true, "ten items");
  for (const f of ["onMain", "deployed", "notes", "pair", "state"]) assert.equal(truthShape(val({ items: [item({ field: f })] })), true, f);
  const bad = [
    null, "x", [], 5, {}, { at: 1, count: 0 }, { count: 0, items: [] },
    val({ extra: 1 }), val({ items: [item({ extra: 1 })] }), val({ items: [{ ...item(), num: undefined }] }),
    val({ at: "now" }), val({ at: NaN }), val({ count: "1" }), val({ count: 1.5 }), val({ count: -1 }), val({ count: 501 }),
    val({ items: "x" }), val({ items: [null] }), val({ items: [[]] }),
    val({ count: 11, items: Array.from({ length: 11 }, () => item()) }),
    val({ count: 1, items: [item(), item()] }),
    val({ items: [item({ field: "other" })] }), val({ items: [item({ field: "" })] }),
    val({ items: [item({ card: "" })] }), val({ items: [item({ card: 5 })] }), val({ items: [item({ num: "1" })] }), val({ items: [item({ num: 1.5 })] }),
    val({ items: [item({ reading: "" })] }), val({ items: [item({ git: "" })] }), val({ items: [item({ reading: "x".repeat(81) })] }), val({ items: [item({ git: "y".repeat(81) })] }), val({ items: [item({ card: "c".repeat(81) })] }),
    val({ items: [item({ reading: "a\nb" })] }), val({ items: [item({ git: "a\u0000b" })] }), val({ items: [item({ reading: "<img src=x onerror=alert(1)>" })] }),
  ];
  const db = await store();
  for (const b of bad) {
    assert.equal(truthShape(b), false, JSON.stringify(b));
    const r = await put(db, b);
    assert.equal(r.ok, false, JSON.stringify(b));
    assert.equal(r.refused.rule, "truth-shape");
  }
  assert.equal(truthShape(val({ items: [item({ reading: "x".repeat(80) })] })), true, "80 characters is fine");
  assert.equal((await put(db, val())).ok, true);
});

test("only the probe writes truth", async () => {
  const db = await store();
  for (const who of ["Manager", "owner", "Builder", null, undefined]) {
    const r = await writeEvidence(db, NOW, who, "truth", val());
    assert.equal(r.ok, false, String(who));
    assert.equal(r.refused.rule, "only-probe-writes-status");
    assert.equal(evidenceRefusal("truth", val(), who).rule, "only-probe-writes-status");
  }
  assert.equal(evidenceRefusal("truth", val(), "probe"), null);
  assert.equal(evidenceRefusal("truth", { count: 1 }, "probe").rule, "truth-shape");
});

test("probeDoc passes truth within the stale window and drops it when stale or absent", async () => {
  const db = await store();
  assert.equal(probeDoc(await readView(db, NOW)).truth, undefined, "absent");
  await put(db, val());
  assert.deepEqual(probeDoc(await readView(db, NOW)).truth, val());
  await put(db, val(), NOW - 6 * M);
  assert.equal(probeDoc(await readView(db, NOW)).truth, undefined, "older than 5 minutes");
});

test("the wake line: counted, the first item named, plain", () => {
  assert.equal(truthWakeLine(CLEAR), null);
  assert.equal(truthWakeLine({ count: 3 }), null, "not shaped");
  assert.equal(truthWakeLine(val({ count: 7 })), "readings disagree with git: 7 (first: #C1301 onMain: reading not on main, git on main at 3f2a)");
  assert.match(truthWakeLine(val({ items: [item({ num: null })] })), /\(first: c-one onMain:/);
  assert.equal(truthWake(CLEAR), null);
  assert.equal(truthWake(val({ count: 4 })).count, 4);
  assert.doesNotMatch(truthWakeLine(val()), /[<>*_`]|\n/);
});

const stalls = async (db, at) => (await takeInbox(db, at)).stalls;

test("one wake row per spell: written at count > 0, kept while it holds, deleted at count 0 so a new spell wakes again", async () => {
  const db = await store();
  const T = NOW - 100_000;
  await put(db, CLEAR, T);
  assert.equal((await wakeAsk(db, T + 1000)).count, 0, "all agree: nothing");
  await put(db, val({ count: 2, items: [item(), item({ card: "c-two", num: 1302, field: "deployed", reading: "live", git: "not deployed" })] }), T + 2000);
  assert.equal((await wakeAsk(db, T + 3000)).count, 1);
  const got = await stalls(db, T + 4000);
  assert.equal(got.length, 1);
  assert.match(got[0].reason, /^readings disagree with git: 2 \(first: #C1301 onMain: reading not on main/);
  // later runs, the same difference or another count or sample: not told again
  for (let n = 1; n <= 3; n++) {
    await put(db, val({ count: 2 + n, items: [item({ reading: `sample ${n}` })] }), T + 5000 + n * 1000);
    assert.equal((await wakeAsk(db, T + 5500 + n * 1000)).count, 0, `run ${n}: not told again`);
  }
  assert.deepEqual(await stalls(db, T + 12_000), []);
  const rows = (await db.prepare("SELECT card_id FROM stall_wakes WHERE card_id = ?").bind(TRUTH_CARD).all()).results;
  assert.equal(rows.length, 1, "exactly one row for the spell");
  // the spell ends: the row goes
  await put(db, CLEAR, T + 20_000);
  assert.equal((await wakeAsk(db, T + 21_000)).count, 0);
  assert.equal((await db.prepare("SELECT card_id FROM stall_wakes WHERE card_id = ?").bind(TRUTH_CARD).all()).results.length, 0, "deleted at count 0");
  // a new spell wakes again
  await put(db, val(), T + 30_000);
  assert.equal((await wakeAsk(db, T + 31_000)).count, 1, "new spell: told again");
  assert.equal((await stalls(db, T + 32_000)).length, 1);
});

test("a stale or absent reading deletes the row, so the same difference after a gap wakes again; a stale one wakes nothing", async () => {
  const db = await store();
  await put(db, val(), NOW - 10 * M);
  assert.equal((await wakeAsk(db, NOW - 10 * M + 1000)).count, 1);
  assert.equal((await wakeAsk(db, NOW)).count, 0, "no fresh reading: nothing pending");
  assert.equal((await db.prepare("SELECT card_id FROM stall_wakes WHERE card_id = ?").bind(TRUTH_CARD).all()).results.length, 0, "row deleted when stale");
  await put(db, val(), NOW - 1000);
  assert.equal((await wakeAsk(db, NOW)).count, 1, "back after a gap: a new spell");
  const db2 = await store();
  await put(db2, val(), NOW - 10 * M);
  assert.equal((await wakeAsk(db2, NOW)).count, 0, "a stale reading wakes nothing");
});

test("an untaken truth line is not retired while the spell holds, and the truth row does not disturb the e2e row", async () => {
  const db = await store();
  await put(db, val(), NOW - 3000);
  await writeEvidence(db, NOW - 3000, "probe", "e2e", { state: "red", reason: "r", run: null, lastGreenAt: null });
  assert.equal((await wakeAsk(db, NOW - 2000)).count, 2);
  assert.equal((await wakeAsk(db, NOW - 1000)).count, 2, "still pending, untaken");
  const got = (await stalls(db, NOW)).map((s) => s.card_id).sort();
  assert.deepEqual(got, ["daily-e2e", TRUTH_CARD]);
});

// --- GET /api/probe/readings ------------------------------------------------------------------------------------------------------------

const WHO = { owner: { who: "owner", role: "owner" }, manager: { who: "Manager", role: "agent" }, probe: { who: "probe", role: "probe" } };
const get = (db, as) => worker.fetch(new Request("https://board.test/api/probe/readings", { headers: { "x-as": as } }), { DB: db }, null, NOW, async (req) => WHO[req.headers.get("x-as")] ?? null);

test("GET /api/probe/readings is the probe's alone and serves the compat answer's readings and the time, nothing else", async () => {
  const db = await store();
  const made = await createCard(db, NOW - 50_000, "Manager", { id: "c-read", title: "A card", summary: "Build it, because it is needed.", batch: "g1-first", repo: "flight-board" }, { needSummary: true, needGroup: true, needRepo: true });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal((await get(db, "owner")).status, 403);
  assert.equal((await get(db, "manager")).status, 403);
  const res = await get(db, "probe");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["now", "readings"]);
  assert.equal(typeof body.now, "number");
  assert.ok(Array.isArray(body.readings) && body.readings.length === 1);
  const view = await readView(db, body.now);
  assert.deepEqual(body.readings, JSON.parse(JSON.stringify(readingDocs(view))), "the same readings");
  assert.deepEqual(body.readings, JSON.parse(JSON.stringify(compatView(view).collections.readings)), "the same as the compat answer's");
  for (const k of ["id", "num", "phase", "state", "wait", "with", "working"]) assert.ok(k in body.readings[0], k);
  // a POST is not the route
  const post = await worker.fetch(new Request("https://board.test/api/probe/readings", { method: "POST", headers: { "x-as": "probe" } }), { DB: db }, null, NOW, async (req) => WHO[req.headers.get("x-as")] ?? null);
  assert.notEqual(post.status, 200);
});
