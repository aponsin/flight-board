// #C873: the board shows the product's daily full test run (its scripts/daily-e2e.mjs --status): ok shows nothing; red, missed and unknown
// each show once on the page with the run's link, and once in Manager's batch when the state turns to one of them from something else.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { drawPage } from "./helpers/draw-page.mjs";
import { writeEvidence, readView, wakeAsk, takeInbox } from "../worker/board-store.mjs";
import { compatView, probeDoc } from "../worker/compat-view.mjs";
import { e2eReading, e2eStep, e2eWrite, E2E_EVERY_MS, E2E_STALE_MS } from "../collector/probe-evidence.mjs";
import { checkConfig as validate } from "../scripts/config.mjs";

const NOW = Date.now(); // the page reads its own clock
const M = 60_000;
const RUN = "https://github.com/acme/product/actions/runs/123";
const read = (state, over = {}) => ({ state, reason: `the daily full browser run on dev is ${state}`, run: RUN, lastGreenAt: null, ...over });

async function store() {
  const db = makeDb();
  assert.equal((await writeEvidence(db, NOW - 10_000, "probe", "board", { boardId: "flight-board", at: NOW - 10_000, probe: "a".repeat(12), derivedAt: NOW - 600 * M, quietMin: 0 })).ok, true);
  return db;
}
const put = async (db, value, at = NOW - 5_000) => writeEvidence(db, at, "probe", "e2e", value);
const stuck = async (db) => { const { collections, probe } = compatView(await readView(db, NOW)); const d = drawPage(collections, { probe, host: "store" }); return d.els.stuck; };

test("ok shows nothing on the page", async () => {
  const db = await store();
  assert.equal((await put(db, read("ok"))).ok, true);
  const el = await stuck(db);
  assert.equal(el.hidden, true);
  assert.equal(el.innerHTML, "");
});

test("red, missed and unknown each show one line with the run's link", async () => {
  for (const [state, words] of [["red", /failed/], ["missed", /not passed in a day/], ["unknown", /cannot be read/]]) {
    const db = await store();
    await put(db, read(state));
    const el = await stuck(db);
    assert.equal(el.hidden, false, state);
    assert.equal(el.innerHTML.match(/<div /g).length, 1, `${state}: one line`);
    assert.match(el.innerHTML, words);
    assert.ok(el.innerHTML.includes(`<a href="${RUN}" target="_blank" rel="noopener">the run</a>`), `${state}: the link`);
    assert.match(el.innerHTML, state === "unknown" ? /class="sl-owner"/ : /class="sl-you"/, `${state}: unknown is the quieter line`);
  }
});

test("a stale or absent reading draws nothing", async () => {
  const db = await store();
  assert.equal((await stuck(db)).hidden, true, "absent");
  await put(db, read("red"), NOW - 4 * M);
  assert.equal((await stuck(db)).hidden, true, "older than 3 minutes");
  assert.equal(probeDoc(await readView(db, NOW)).e2e, undefined);
});

test("hostile text is escaped and a run that is not https is not a link", async () => {
  const db = await store();
  await put(db, read("red", { reason: `<img src=x onerror=alert(1)> "quoted" & more`, run: `https://x.test/"><script>alert(1)</script>` }));
  let html = (await stuck(db)).innerHTML;
  assert.ok(!html.includes("<img") && !html.includes("<script"), html);
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot; &amp; more"), html);
  assert.ok(!html.includes("<a "), "an address with a quote in it is no link");
  const db2 = await store();
  await put(db2, read("missed", { run: "http://github.com/acme/product/actions/runs/1" }));
  html = (await stuck(db2)).innerHTML;
  assert.ok(!html.includes("<a ") && !html.includes("javascript:"), html);
  assert.match(html, /not passed in a day/);
  const db3 = await store();
  await put(db3, read("red", { run: "javascript:alert(1)" }));
  assert.ok(!(await stuck(db3)).innerHTML.includes("<a "));
});

test("the store refuses a reading that is not shaped like one, and takes the key e2e", async () => {
  const db = await store();
  for (const bad of [null, "red", { state: "green", reason: "x" }, { state: "red" }, { state: "red", reason: "x", run: 5 }]) {
    const r = await put(db, bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.refused.rule, "e2e-shape");
  }
  assert.equal((await put(db, read("red"))).ok, true);
});

test("Manager's batch gets one line when the state turns red, and none on the next probe runs", async () => {
  const db = await store();
  await put(db, read("ok"), NOW - 70_000);
  let a = await wakeAsk(db, NOW - 60_000);
  assert.equal(a.count, 0, "ok: nothing");
  await put(db, read("red"), NOW - 50_000);
  a = await wakeAsk(db, NOW - 40_000);
  assert.equal(a.count, 1);
  const got = await takeInbox(db, NOW - 30_000);
  assert.equal(got.stalls.length, 1);
  assert.match(got.stalls[0].reason, /^daily full test run is red: the daily full browser run on dev is red \(https:\/\/github\.com\/acme\/product\/actions\/runs\/123\)/);
  // the probe writes the reading again every minute, with the same state (and a later run, and the hours of a missed one moving on)
  for (let n = 1; n <= 3; n++) {
    await put(db, read("red", { run: `${RUN}${n}`, reason: `still red ${n}` }), NOW - 30_000 + n * 1000);
    a = await wakeAsk(db, NOW - 20_000 + n * 1000);
    assert.equal(a.count, 0, `run ${n}: not told again`);
  }
  assert.deepEqual((await takeInbox(db, NOW - 10_000)).stalls, []);
});

test("it is told again when the state changes (red to missed) and when it turns bad again after ok", async () => {
  const db = await store();
  const T = NOW - 100_000;
  await put(db, read("red"), T); await wakeAsk(db, T + 1000);
  assert.equal((await takeInbox(db, T + 2000)).stalls.length, 1);
  await put(db, read("missed"), T + 3000);
  assert.equal((await wakeAsk(db, T + 4000)).count, 1, "red to missed: one more line");
  assert.match((await takeInbox(db, T + 5000)).stalls[0].reason, /^daily full test run is missed/);
  await put(db, read("ok"), T + 6000); await wakeAsk(db, T + 7000);
  await put(db, read("missed"), T + 8000);
  assert.equal((await wakeAsk(db, T + 9000)).count, 1, "ok then missed: told again");
  assert.match((await takeInbox(db, T + 10_000)).stalls[0].reason, /^daily full test run is missed/);
  await put(db, read("unknown", { run: null }), T + 11_000);
  assert.equal((await wakeAsk(db, T + 12_000)).count, 1, "unknown is told too");
  assert.doesNotMatch((await takeInbox(db, T + 13_000)).stalls[0].reason, /\(https:/);
});

test("a reading that goes stale before Manager reads it drops its line; the same state back is not told twice", async () => {
  const db = await store();
  await put(db, read("red"), NOW - 10 * M);
  assert.equal((await wakeAsk(db, NOW - 10 * M + 1000)).count, 1);
  assert.equal((await wakeAsk(db, NOW)).count, 0, "no fresh reading: nothing pending");
  await put(db, read("red"), NOW - 1000);
  assert.equal((await wakeAsk(db, NOW)).count, 0, "same state again: it was told");
});

// --- The probe's side -----------------------------------------------------------------------------------------------------------------

test("e2eReading reads the script's line even when it exits 1 or 2, and never turns a bad answer into ok", () => {
  const line = JSON.stringify({ state: "red", reason: "ended failure", run: RUN, lastGreenAt: "2026-11-09T05:00:00.000Z" });
  assert.deepEqual(e2eReading({ status: 1, stdout: `${line}\n` }), { state: "red", reason: "ended failure", run: RUN, lastGreenAt: "2026-11-09T05:00:00.000Z" });
  assert.equal(e2eReading({ status: 2, stdout: JSON.stringify({ state: "unknown", reason: "gh: HTTP 404", run: null, lastGreenAt: null }) }).state, "unknown");
  assert.equal(e2eReading({ status: 0, stdout: JSON.stringify({ state: "ok", reason: "fine", run: RUN, lastGreenAt: null }) }).state, "ok");
  for (const r of [null, { error: { code: "ENOENT" } }, { status: 1, stdout: "" }, { status: 1, stdout: "not json" }, { status: 0, stdout: '{"state":"fine"}' }, { status: 0, stdout: "[1]" }]) {
    const v = e2eReading(r);
    assert.equal(v.state, "unknown", JSON.stringify(r));
    assert.equal(v.run, null);
  }
  assert.equal(e2eReading({ status: 1, stdout: JSON.stringify({ state: "red", reason: "x", run: "http://a.test/1", lastGreenAt: "soon" }) }).run, null, "not https");
  assert.equal(e2eReading({ status: 1, stdout: JSON.stringify({ state: "red", reason: "x", run: RUN, lastGreenAt: "soon" }) }).lastGreenAt, null);
});

test("e2eStep asks the script at most every 30 minutes and keeps the answer; e2eWrite writes it, or unknown once it is over 2 hours old", () => {
  const cfg = JSON.stringify({ collector: { dailyE2eRepo: "product", repos: [{ name: "product", path: "~/code/product" }] } });
  const files = new Map(); const logs = [];
  const io = { stateFile: "/s/board/state.json", env: {}, home: "/home/x", log: (l) => logs.push(l), read: (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p); }, write: (p, t) => files.set(p, t) };
  const asked = [];
  const run = (cwd) => { asked.push(cwd); return { status: 1, stdout: JSON.stringify({ state: "red", reason: "r", run: RUN, lastGreenAt: null }) }; };
  assert.equal(e2eStep(cfg, { ...io, run, now: 1_000_000 }).state, "red");
  assert.deepEqual(asked, ["/home/x/code/product"], "run in the product's checkout");
  assert.equal(e2eStep(cfg, { ...io, run, now: 1_000_000 + E2E_EVERY_MS - 1 }).state, "red");
  assert.equal(asked.length, 1, "kept answer within 30 minutes");
  e2eStep(cfg, { ...io, run, now: 1_000_000 + E2E_EVERY_MS });
  assert.equal(asked.length, 2);
  assert.deepEqual(e2eWrite(cfg, { ...io, now: 1_000_000 + E2E_EVERY_MS + 5 }), { key: "e2e", value: { state: "red", reason: "r", run: RUN, lastGreenAt: null } });
  const old = e2eWrite(cfg, { ...io, now: 1_000_000 + E2E_EVERY_MS + E2E_STALE_MS + 1 });
  assert.equal(old.value.state, "unknown");
  assert.match(old.value.reason, /over 2 hours/);
  files.clear();
  assert.match(e2eWrite(cfg, { ...io, now: 5 }).value.reason, /not been read yet/);
});

test("with no collector.dailyE2eRepo, or one naming no repos entry, the reading is skipped: a log line, nothing written, no script run", () => {
  const logs = []; let ran = 0;
  const io = { stateFile: "/s/b/state.json", env: {}, log: (l) => logs.push(l), run: () => { ran++; return { status: 0, stdout: "" }; }, read: () => { throw new Error("none"); }, write: () => { throw new Error("no write"); } };
  for (const c of [{ collector: {} }, { collector: { dailyE2eRepo: "" } }, { collector: { dailyE2eRepo: "product", repos: [] } }, { collector: { dailyE2eRepo: "product", repos: [{ name: "product" }] } }]) {
    assert.equal(e2eStep(JSON.stringify(c), io), null);
    assert.equal(e2eWrite(JSON.stringify(c), io), null);
  }
  assert.equal(e2eWrite("not json", io), null);
  assert.equal(ran, 0);
  assert.ok(logs.some((l) => /no collector\.dailyE2eRepo/.test(l)) && logs.some((l) => /no entry named product/.test(l)), logs.join("\n"));
});

test("config: dailyE2eRepo is empty by default and must name a collector.repos entry", () => {
  const repo = { name: "product", path: "/p", notes: {} };
  const errs = (collector) => validate({ owner: "Sam", collector }).filter((e) => /dailyE2eRepo/.test(e));
  assert.deepEqual(errs({}), []);
  assert.deepEqual(errs({ dailyE2eRepo: "" }), []);
  assert.deepEqual(errs({ repos: [repo], dailyE2eRepo: "product" }), []);
  assert.equal(errs({ repos: [repo], dailyE2eRepo: "other" }).length, 1);
  assert.equal(errs({ dailyE2eRepo: 5 }).length, 1);
});
