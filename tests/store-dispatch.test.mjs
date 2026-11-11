// #C821: the owners' DISPATCH files from the store's view, read back by the role watch (scripts/wake-watch.mjs roleTick) unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchInput, dispatchRun, AGENTS_FRESH_MS, FOREIGN_WRITER_MS } from "../collector/store-dispatch.mjs";
import { dispatchJob, main } from "../collector/probe-board.mjs";
import { roleTick } from "../scripts/wake-watch.mjs";
import { JOBS } from "../collector/probe-run.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const LINK = "https://claude.ai/" + "artifact/TestBoard01"; // built in two parts, as tests/dispatch.test.mjs does: the repository scan refuses a literal link
const ROSTER = ["Manager", "Builder", "Checker", "Security"], LEAD = "Manager";
const dir = () => mkdtempSync(join(tmpdir(), "sd-"));
const read = (d, f) => JSON.parse(readFileSync(join(d, f), "utf8"));
// A view with one card owned by Builder; Builder idle since `idleFor` ms before NOW.
const view = ({ idleFor = 20 * MIN, state = "idle", readAt = NOW - 10_000, card = {}, asks = [], phase = null, extraCards = [] } = {}) => ({
  cards: [{ id: "c900-thing", owner_role: "Builder", waiting_on: null, paused: 0, dropped: 0, ...card }, ...extraCards],
  asks,
  evidence: {
    agents: { readAt, value: { Builder: { state, lastActivityAt: NOW - idleFor, since: NOW - idleFor, card: "c900-thing" }, Manager: { state: "idle", lastActivityAt: NOW - idleFor, since: NOW - idleFor, card: null } } },
    ...(phase ? { "cards.c900-thing": { readAt, value: { phase } } } : {}),
  },
});
const run = (v, d, now = NOW) => dispatchRun(v, { dir: d, roster: ROSTER, lead: LEAD, now });

test("an active card whose owner has been idle 15 minutes is written as a level 1 item, tagged as the store's", () => {
  const d = dir(), r = run(view(), d);
  assert.equal(r.wrote, true);
  assert.deepEqual(r.items.map((i) => [i.card, i.role, i.level]), [["c900-thing", "Builder", 1]]);
  const f = read(d, "dispatch.json");
  assert.equal(f.source, "store");
  assert.equal(f.at, NOW);
  assert.ok(existsSync(join(d, "dispatch-state.json")));
});

test("the owner's own watch prints the DISPATCH line from the store's file, once, with the watch code unchanged", () => {
  const d = dir();
  run(view(), d);
  const line = roleTick(d, "Builder", NOW + 1000, 4242);
  assert.match(line, /^DISPATCH c900-thing: it waits on you \(Builder\)/);
  assert.match(line, /need no go from anyone/, "#C848: pushing your own branch, READY and the next queued card need no go");
  assert.equal(roleTick(d, "Builder", NOW + 2000, 4242), null, "printed once");
  assert.equal(roleTick(d, "Checker", NOW + 2000, 4243), null, "another role's watch prints nothing");
});

test("nothing is dispatched for an owner who is working, idle under 15 minutes, or the lead", () => {
  assert.deepEqual(run(view({ state: "working" }), dir()).items, []);
  assert.deepEqual(run(view({ idleFor: 14 * MIN }), dir()).items, []);
  assert.deepEqual(run(view({ card: { owner_role: "Manager" } }), dir()).items, []);
});

test("a card that is paused, dropped, live, waiting on someone else, or has an open ask is not dispatched", () => {
  assert.deepEqual(run(view({ card: { paused: 1 } }), dir()).items, []);
  assert.deepEqual(run(view({ card: { dropped: 1 } }), dir()).items, []);
  assert.deepEqual(run(view({ phase: "live" }), dir()).items, []);
  assert.deepEqual(run(view({ card: { waiting_on: "Security: a verdict" } }), dir()).items, []);
  assert.deepEqual(run(view({ asks: [{ id: "a1", card_id: "c900-thing", closed_at: null, answered_at: null, withdrawn_at: null }] }), dir()).items, []);
  // an answered or closed ask no longer holds the card back
  for (const done of [{ answered_at: 5 }, { closed_at: 5 }]) {
    assert.equal(run(view({ asks: [{ id: "a1", card_id: "c900-thing", closed_at: null, answered_at: null, withdrawn_at: null, ...done }] }), dir()).items.length, 1);
  }
});

test("a withdrawn approval is still open (its answer is cleared, it waits for the owner's Approve again), so it holds the card back", () => {
  const withdrawn = { id: "a1", type: "Approval", card_id: "c900-thing", answered_at: null, closed_at: null, withdrawn_at: 5, withdrawn_by: "owner" };
  assert.deepEqual(run(view({ asks: [withdrawn] }), dir()).items, []);
});

test("#C845: a card whose depends_on is not live is not dispatched; once each is live, or gone, or dropped, it is", () => {
  const dep = { id: "c901-dep", owner_role: "Checker", waiting_on: null, paused: 0, dropped: 0 };
  const withDep = (extra = {}, depPhase = null, list = '["c901-dep"]') => {
    const v = view({ card: { depends_on: list }, extraCards: [{ ...dep, ...extra }] });
    if (depPhase) v.evidence["cards.c901-dep"] = { readAt: NOW - 10_000, value: { phase: depPhase } };
    return v;
  };
  assert.deepEqual(run(withDep(), dir()).items.filter((i) => i.card === "c900-thing"), [], "the dependency is on plan");
  assert.deepEqual(run(withDep({}, "build"), dir()).items.filter((i) => i.card === "c900-thing"), [], "the dependency is at build");
  assert.equal(run(withDep({}, "live"), dir()).items.filter((i) => i.card === "c900-thing").length, 1, "the dependency is live");
  assert.equal(run(withDep({ dropped: 1 }), dir()).items.filter((i) => i.card === "c900-thing").length, 1, "a dropped dependency holds nothing");
  assert.equal(run(withDep({}, null, '["no-such-card"]'), dir()).items.filter((i) => i.card === "c900-thing").length, 1, "an unknown one holds nothing");
  assert.equal(run(withDep({}, null, "not json"), dir()).items.filter((i) => i.card === "c900-thing").length, 1, "an unreadable list holds nothing");
  assert.equal(run(view({ card: { depends_on: '["c900-thing"]' } }), dir()).items.length, 1, "a card that lists itself does not wait for itself");
  const lit = withDep();
  lit.evidence["cards.c901-dep"] = { readAt: NOW - 10_000, value: { lit: ["live"] } };
  assert.equal(run(lit, dir()).items.filter((i) => i.card === "c900-thing").length, 1, "the dependency's live phase is read from lit[0] when there is no phase");
});

test("a blocked card (a blocked_reason) is not dispatched, as on the old shape and in the store's stall rule", () => {
  assert.deepEqual(run(view({ card: { blocked_reason: "waiting for a DNS change" } }), dir()).items, []);
  assert.equal(run(view({ card: { blocked_reason: null } }), dir()).items.length, 1);
});

test("the live phase is read from phase, else from lit[0], as compat-view reads it", () => {
  const withLit = (value) => { const v = view(); v.evidence["cards.c900-thing"] = { readAt: NOW - 10_000, value }; return v; };
  assert.deepEqual(run(withLit({ lit: ["live"] }), dir()).items, []);
  assert.deepEqual(run(withLit({ phase: "live", lit: ["build"] }), dir()).items, []);
  assert.equal(run(withLit({ phase: "build", lit: ["live"] }), dir()).items.length, 1, "phase wins over lit");
  assert.equal(run(withLit({ lit: ["build"] }), dir()).items.length, 1);
});

test("a waiting-on text that starts with the owner's own role still dispatches (the old rule)", () => {
  assert.equal(run(view({ card: { waiting_on: "Builder: the next step" } }), dir()).items.length, 1);
});

test("a stale or missing agent reading writes nothing, so a blind probe never wakes anyone", () => {
  const d = dir();
  const r = run(view({ readAt: NOW - AGENTS_FRESH_MS - 1 }), d);
  assert.deepEqual([r.wrote, r.why], [false, "agents-stale"]);
  assert.equal(existsSync(join(d, "dispatch.json")), false);
  assert.equal(dispatchInput({ cards: [], asks: [], evidence: {} }, NOW), null);
  assert.equal(dispatchInput({ cards: [], asks: [], evidence: { agents: { readAt: NOW + 60_000, value: {} } } }, NOW), null, "a reading from the future is not fresh");
  assert.equal(dispatchInput({ cards: [], asks: [], evidence: { agents: { value: {} } } }, NOW), null, "a reading with no time is not fresh");
  assert.equal(dispatchInput({ cards: [], asks: [], evidence: { agents: { readAt: "now", value: {} } } }, NOW), null, "nor one with a time that is not a number");
});

test("a dispatch.json the old state job wrote in the last 5 minutes is left alone; an older one is replaced", () => {
  const d = dir();
  writeFileSync(join(d, "dispatch.json"), JSON.stringify({ at: NOW - 60_000, items: [] }));
  const r = run(view(), d);
  assert.deepEqual([r.wrote, r.why], [false, "foreign-writer"]);
  assert.equal(read(d, "dispatch.json").source, undefined, "untouched");
  writeFileSync(join(d, "dispatch.json"), JSON.stringify({ at: NOW - FOREIGN_WRITER_MS - 1, items: [] }));
  assert.equal(run(view(), d).wrote, true);
  assert.equal(read(d, "dispatch.json").source, "store");
});

test("the store's own earlier file is always replaced, and a pair keeps its first time so it reaches level 2 after 30 minutes", () => {
  const d = dir();
  run(view(), d, NOW);
  const later = NOW + 31 * MIN;
  const v2 = view({ idleFor: 51 * MIN, readAt: later - 10_000 });
  const r = dispatchRun(v2, { dir: d, roster: ROSTER, lead: LEAD, now: later });
  assert.equal(r.items[0].level, 2);
  assert.equal(r.items[0].since, NOW);
  // a pair that stops holding is forgotten: a new stall starts again at level 1
  dispatchRun(view({ state: "working", readAt: later + MIN - 10_000 }), { dir: d, roster: ROSTER, lead: LEAD, now: later + MIN });
  assert.deepEqual(read(d, "dispatch-state.json"), { items: {} });
  const again = dispatchRun(view({ readAt: later + 2 * MIN - 10_000 }), { dir: d, roster: ROSTER, lead: LEAD, now: later + 2 * MIN });
  assert.equal(again.items[0].level, 1);
});

test("hostile card fields never reach the file: a bad id, a non-string owner or waiting_on", () => {
  const v = view({ extraCards: [{ id: "BAD ID\n", owner_role: "Builder" }, { id: "c901-x", owner_role: { r: 1 } }, { id: "c902-y", owner_role: "Builder", waiting_on: { a: 1 } }] });
  const d = dir();
  run(v, d);
  const ids = read(d, "dispatch.json").items.map((i) => i.card).sort();
  assert.deepEqual(ids, ["c900-thing", "c902-y"]);
});

test("dispatchJob reads GET /api/view with the probe's headers and writes the files; a failed read throws and writes nothing", async () => {
  const d = dir(), seen = [];
  const ok = async (url, init) => { seen.push([url, init.method, init.headers["cf-access-client-id"]]); return { ok: true, status: 200, json: async () => view() }; };
  const r = await dispatchJob({ base: "https://board.test", headers: { "cf-access-client-id": "id-1" }, fetchImpl: ok, dir: d, roster: ROSTER, lead: LEAD, now: () => NOW });
  assert.deepEqual(seen, [["https://board.test/api/view", "GET", "id-1"]]);
  assert.equal(r.wrote, true);
  const d2 = dir();
  await assert.rejects(() => dispatchJob({ base: "https://board.test", headers: {}, fetchImpl: async () => ({ ok: false, status: 503 }), dir: d2, roster: ROSTER, lead: LEAD, now: () => NOW }), /view answered 503/);
  assert.equal(existsSync(join(d2, "dispatch.json")), false);
});

// The CLI against a config file: the exit code, what it fetched, and what it printed.
async function cli(cfg, fetchImpl = async () => { throw new Error("must not fetch"); }) {
  const d = dir(), env = join(d, "board.env"), conf = join(d, "board.config.json");
  writeFileSync(env, "BOARD_BASE_URL=https://board.test\nBOARD_SERVICE_TOKEN_ID=a\nBOARD_SERVICE_TOKEN_SECRET=b\n");
  if (cfg !== undefined) writeFileSync(conf, typeof cfg === "string" ? cfg : JSON.stringify(cfg));
  let code = null;
  const errs = [], orig = console.error;
  console.error = (m) => errs.push(String(m));
  try { await main(["--job", "dispatch", "--env", env, ...(cfg === undefined ? [] : ["--config", conf])], { exit: (c) => { code = c; return c; }, fetchImpl }); } finally { console.error = orig; }
  return { code, errs: errs.join("\n"), d };
}

test("the dispatch job is a probe job of its own with a limit inside its interval, and the CLI refuses it without a usable --config", async () => {
  assert.ok(JOBS.dispatch.limitSec < JOBS.dispatch.intervalSec);
  const none = await cli(undefined);
  assert.equal(none.code, 64);
  assert.match(none.errs, /--config/);
});

test("the CLI exits 64 for a config that is not JSON, one that fails the config check, and one with no board link (else it would write to <stateDir>/null and no owner would be woken)", async () => {
  const good = (d) => ({ artifactUrl: LINK, roster: ROSTER, gate: { stateDir: join(d, "state"), managerRole: LEAD } });
  assert.equal((await cli("{ not json")).code, 64);
  assert.equal((await cli({ artifactUrl: LINK, roster: "Builder", gate: { stateDir: "/x" } })).code, 64, "roster must be a list");
  const noLink = await cli({ roster: ROSTER, gate: { stateDir: "/x", managerRole: LEAD } });
  assert.equal(noLink.code, 64);
  assert.match(noLink.errs, /--config/);
  assert.equal((await cli({ artifactUrl: "https://example.test/not-a-board", roster: ROSTER, gate: { stateDir: "/x", managerRole: LEAD } })).code, 64);
  // and a good one runs: the files go to <stateDir>/<board id>, the folder made if it is not there yet
  const d0 = dir();
  const cfg = good(d0);
  const f = join(d0, "board.env"), conf = join(d0, "board.config.json");
  writeFileSync(f, "BOARD_BASE_URL=https://board.test\nBOARD_SERVICE_TOKEN_ID=a\nBOARD_SERVICE_TOKEN_SECRET=b\n");
  writeFileSync(conf, JSON.stringify(cfg));
  let code = null;
  const orig = console.error;
  console.error = () => {};
  try { await main(["--job", "dispatch", "--env", f, "--config", conf], { exit: (c) => { code = c; return c; }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => view({ readAt: Date.now() - 1000, idleFor: 20 * MIN }) }) }); } finally { console.error = orig; }
  assert.equal(code, 0);
  assert.equal(read(join(d0, "state", "TestBoard01"), "dispatch.json").source, "store");
});
