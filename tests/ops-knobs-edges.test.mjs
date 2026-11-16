// #C997, Checker 2's M1 on 0d759b49: seven mutants of the wiring survived the suite. Each test here sets a NON-DEFAULT setting and fails when the
// code falls back to the default: the interval skips a run, the limit sets the child's deadline and the run's own timeout, the slow mark follows
// slowRunSec, and the Worker's two readers (the e2e wake, the probe document) take the posted stale edge.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { writeEvidence, readView, wakeAsk } from "../worker/board-store.mjs";
import { probeDoc } from "../worker/compat-view.mjs";
import { evidenceJob, main } from "../collector/probe-evidence.mjs";
import { headerHtml } from "../worker/page-header.mjs";

const M = 60_000;
const withDir = async (fn) => { const dir = mkdtempSync(join(tmpdir(), "ops-edges-")); try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
const argvFor = (dir) => ["--job", "evidence", "--env", join(dir, "env"), "--config", join(dir, "board.config.json"), "--state", join(dir, "state.json"), "--base", "https://x.example"];
const setup = (dir, ops) => { writeFileSync(join(dir, "env"), ""); writeFileSync(join(dir, "board.config.json"), JSON.stringify({ ops })); };

// E3: main skips a run that is not due under the SET interval (the 60 s default would run it).
test("main skips the run while the set interval has not passed, and runs it once it has", () => withDir(async (dir) => {
  setup(dir, { evidenceIntervalSec: 600 });
  writeFileSync(join(dir, "evidence-started.json"), JSON.stringify({ at: Date.now() - 2 * M }));
  const started = [];
  const codes = [];
  await main(argvFor(dir), { exit: (c) => { codes.push(c); return c; }, start: (...a) => { started.push(a); throw new Error("started"); } });
  assert.deepEqual(codes, [0], "exits 0 without starting");
  assert.equal(started.length, 0, "a run 2 minutes after the last one is not due under a 600 s interval");
  writeFileSync(join(dir, "evidence-started.json"), JSON.stringify({ at: Date.now() - 11 * M }));
  await assert.rejects(main(argvFor(dir), { exit: (c) => c, start: (...a) => { started.push(a); throw new Error("started"); } }), /started/);
  assert.equal(started.length, 1, "11 minutes later it is due");
}));

// E4 and E5: the limit is the setting: it is the run's own timeout, the child's deadline, and what the job is given.
test("the set limit is the run's own timeout and the job's knobs", () => withDir(async (dir) => {
  setup(dir, { evidenceLimitSec: 100 });
  const startOpts = [], jobKnobs = [];
  await main(argvFor(dir), {
    exit: (c) => c,
    start: (job, opts) => { startOpts.push(opts); return { log() {}, step: (n, fn) => fn(), finish: (c) => c }; },
    jobRun: async (o) => { jobKnobs.push(o.knobs); },
  });
  assert.deepEqual(startOpts, [{ limitSec: 100 }], "startRun gets the setting (the run's own alarm)");
  assert.equal(jobKnobs[0].values.evidenceLimitSec, 100);
}));

const T = 1_800_000_000_000;
const STATE = JSON.stringify({ v: 1, board: { boardId: "b", at: T, cardsCheckedAt: T }, cards: {}, agents: {} });
const jobOf = (knobsValues, over = {}, posted = [], lines = []) => ({
  job: "evidence", base: "https://x.example", headers: {}, configPath: "/c", stateFile: "/s/state.json", ghCheck: () => true,
  knobs: { values: knobsValues, ignored: [] },
  read: (p) => { if (p === "/c") return JSON.stringify({}); if (p === "/s/state.json") return STATE; throw new Error("none"); },
  deployRead: async () => ({ worker: "", tree: "" }), liveFetch: async () => ({ ok: false, status: 500 }),
  fetchImpl: async (url, o) => { posted.push(JSON.parse(o.body)); return { ok: true, status: 200 }; }, log: (l) => lines.push(l), ...over,
});
const DEFAULTS = { evidenceIntervalSec: 60, evidenceLimitSec: 170, slowRunSec: 150, staleAfterSec: 300, probeSilentSec: 300 };

test("the state child's deadline is the set limit less 15 s", async () => {
  const seen = [];
  await evidenceJob(jobOf({ ...DEFAULTS, evidenceLimitSec: 100, slowRunSec: 90 }, { build: async (args, ms) => { seen.push(ms); } }));
  assert.deepEqual(seen, [85_000], "100 s limit: the child gets 85 s (the default limit would give 155 s)");
});

// E7 and E8: a run longer than the SET slowRunSec is logged as slow and marked slow in run.evidence.
test("a run over the set slowRunSec is logged slow and marked slow; under the default 150 s it would be neither", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["Date"], now: T });
  const posted = [], lines = [];
  await evidenceJob(jobOf({ ...DEFAULTS, slowRunSec: 30 }, { build: async () => { mock.timers.tick(40_000); } }, posted, lines));
  assert.ok(lines.some((l) => /^slow run: 40 s of 170 s/.test(l)), `the log says slow: ${lines.join(" | ")}`);
  const run = posted.find((b) => b.key === "run.evidence");
  assert.equal(run?.value.slow, true, "run.evidence carries the slow mark at the set edge");
  posted.length = 0; lines.length = 0;
  await evidenceJob(jobOf({ ...DEFAULTS, slowRunSec: 50 }, { build: async () => { mock.timers.tick(40_000); } }, posted, lines));
  assert.ok(!lines.some((l) => /slow run/.test(l)), "40 s is under a 50 s edge");
  assert.equal(posted.find((b) => b.key === "run.evidence")?.value.slow, undefined);
});

// W3 and C1: the Worker reads the stale edge the probe posted.
async function store(now) {
  const db = makeDb();
  assert.equal((await writeEvidence(db, now - 10_000, "probe", "board", { boardId: "flight-board", at: now - 10_000, probe: "a".repeat(12), derivedAt: now - 600 * M, quietMin: 0 })).ok, true);
  return db;
}
const knobs = (db, at, staleAfterSec) => writeEvidence(db, at, "probe", "knobs", { values: { staleAfterSec }, ignored: [] });
const e2eRed = { state: "red", reason: "the daily full browser run on dev is red", run: "https://github.com/acme/product/actions/runs/1", lastGreenAt: null };

test("the e2e wake and the probe document take the posted stale edge (a longer one keeps a 6-minute reading, a shorter one drops a 3-minute one)", async () => {
  const NOW = Date.now();
  // Longer edge: a red e2e reading 6 minutes old still counts under 600 s; the default 300 s would have dropped it.
  let db = await store(NOW);
  await writeEvidence(db, NOW - 6 * M, "probe", "e2e", e2eRed);
  await writeEvidence(db, NOW - 6 * M, "probe", "stuck", { items: [] });
  assert.equal((await wakeAsk(db, NOW)).count, 0, "default edge: 6 minutes is stale, nothing pending");
  assert.equal(probeDoc(await readView(db, NOW)).e2e, undefined, "default edge: dropped from the document");
  db = await store(NOW);
  await knobs(db, NOW - 5_000, 600);
  await writeEvidence(db, NOW - 6 * M, "probe", "e2e", e2eRed);
  assert.equal((await wakeAsk(db, NOW)).count, 1, "posted 600 s: the red reading is current, Manager is told");
  assert.deepEqual(probeDoc(await readView(db, NOW)).e2e?.state, "red", "posted 600 s: kept in the document");
  // Shorter edge: a 3-minute-old reading counts under the default, not under 120 s.
  db = await store(NOW);
  await writeEvidence(db, NOW - 3 * M, "probe", "e2e", e2eRed);
  assert.equal((await wakeAsk(db, NOW)).count, 1, "default edge: 3 minutes is current");
  assert.equal(probeDoc(await readView(db, NOW)).e2e?.state, "red");
  db = await store(NOW);
  await knobs(db, NOW - 5_000, 120);
  await writeEvidence(db, NOW - 3 * M, "probe", "e2e", e2eRed);
  assert.equal((await wakeAsk(db, NOW)).count, 0, "posted 120 s: 3 minutes is stale");
  assert.equal(probeDoc(await readView(db, NOW)).e2e, undefined);
});

// L3: the page's header escapes an ignored setting's text.
test("the header escapes the text of an ignored setting", () => {
  const html = headerHtml({ live: { state: "live", version: "v1", age: 1000 }, probe: { state: "ok", lastAt: 1 }, knobsIgnored: [{ key: "staleAfterSec", why: "<b>x</b> & more" }] });
  assert.ok(!html.includes("<b>x</b>"), "no raw tag from a reason");
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt; &amp; more/);
});
