// #C711: the board says so when the Collector stops publishing. The fence leaves a marker when the run's set of derived/all goes
// through; the every-minute probe counts the minutes of the Collector's schedule (8 am to 8 pm Mountain time) since it, and the page's
// chip goes red past 75. A night without runs is no outage.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";
import { quietMinutes, publishedReading, buildState, SCHEDULE } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";
import { fenceSpec, publishedOf } from "../collector/fence.mjs";
import { PUBLISHED_FILE } from "../collector/export.mjs";
import { fullConfig } from "../scripts/config.mjs";

const MIN = 60e3;
const at = (s) => Date.parse(s);
const hh = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

test("the schedule is 8 am to 8 pm Mountain time", () => {
  assert.deepEqual(SCHEDULE, { tz: "America/Boise", from: 8, to: 20 });
});

test("quietMinutes counts only the minutes inside the schedule (November, MST: 8 am is 15:00Z)", () => {
  assert.equal(quietMinutes(at("2026-11-10T15:00:00Z"), at("2026-11-10T16:30:00Z")), 90, "inside the schedule");
  assert.equal(quietMinutes(at("2026-11-10T14:50:00Z"), at("2026-11-10T15:10:00Z")), 10, "starts before 8 am: only the 10 after");
  assert.equal(quietMinutes(at("2026-11-11T02:50:00Z"), at("2026-11-11T15:30:00Z")), 40, "over a night: 10 minutes before 8 pm and 30 after 8 am");
  assert.equal(quietMinutes(at("2026-11-11T03:00:00Z"), at("2026-11-11T14:59:00Z")), 0, "a whole night is nothing");
  assert.equal(quietMinutes(at("2026-11-10T15:00:00Z"), at("2026-11-10T15:00:00Z")), 0);
  assert.equal(quietMinutes(at("2026-11-10T16:00:00Z"), at("2026-11-10T15:00:00Z")), 0, "a time ahead of now is none");
  assert.equal(quietMinutes(NaN, at("2026-11-10T15:00:00Z")), 0);
});

test("quietMinutes follows summer time (July, MDT: 8 am is 14:00Z)", () => {
  assert.equal(quietMinutes(at("2026-07-15T13:00:00Z"), at("2026-07-15T15:00:00Z")), 60);
  assert.equal(quietMinutes(at("2026-07-16T01:50:00Z"), at("2026-07-16T02:30:00Z")), 10, "the schedule ends at 8 pm MDT, 02:00Z");
});

test("quietMinutes looks back two days at most", () => {
  const now = at("2026-11-12T20:00:00Z");
  assert.ok(quietMinutes(at("2026-10-01T00:00:00Z"), now) <= 1440);
  assert.equal(quietMinutes(at("2026-10-01T00:00:00Z"), now), quietMinutes(now - 48 * 60 * MIN, now));
});

test("publishedReading: the marker's time and the minutes since; none yet starts one now, so an install that never publishes is counted", () => {
  const now = at("2026-11-10T18:00:00Z");
  const files = new Map();
  const read = (p) => (files.has(p) ? { whole: true, text: files.get(p) } : null);
  const write = (p, text) => files.set(p, text);
  files.set("/s/m.json", JSON.stringify({ at: now - 90 * MIN }));
  assert.deepEqual(publishedReading("/s/m.json", now, read, write), { at: now - 90 * MIN, quietMin: 90 });
  assert.deepEqual(publishedReading("/s/none.json", now, read, write), { at: now, quietMin: 0 });
  assert.deepEqual(JSON.parse(files.get("/s/none.json")), { at: now, baseline: true }, "the baseline is written");
  assert.deepEqual(publishedReading("/s/none.json", now + 70 * MIN, read, write), { at: now, quietMin: 70 }, "and counted from");
  files.set("/s/junk.json", "not json");
  assert.deepEqual(publishedReading("/s/junk.json", now, read, write), { at: now, quietMin: 0 }, "a file that isn't ours is a new baseline");
  files.set("/s/future.json", JSON.stringify({ at: now + 3 * 60 * MIN }));
  assert.equal(publishedReading("/s/future.json", now, read, write).quietMin, 0, "a time far ahead is none");
  assert.deepEqual(JSON.parse(files.get("/s/future.json")), { at: now, baseline: true }, "and the file now holds a baseline, not the future time");
  assert.deepEqual(publishedReading("/s/future.json", now + 70 * MIN, read, write), { at: now, quietMin: 70 }, "and it is counted from then: a future marker never keeps the chip green");
  assert.equal(publishedReading("/s/nowrite.json", now, () => null, () => { throw new Error("read-only"); }), null, "no marker and no way to write one: no reading");
});

test("the state carries derivedAt and quietMin; a probe without them still fits; bad ones don't", () => {
  const now = at("2026-11-10T18:00:00Z");
  const s = buildState({ id: "flight-board", now, probe: null, pageVersion: null, cards: {}, agents: {}, published: { at: now - 90 * MIN, quietMin: 90 } });
  assert.equal(s.board.derivedAt, now - 90 * MIN);
  assert.equal(s.board.quietMin, 90);
  const none = buildState({ id: "flight-board", now, probe: null, pageVersion: null, cards: {}, agents: {} });
  assert.ok(!("derivedAt" in none.board) && !("quietMin" in none.board));
  assert.deepEqual(stateErrors(none), []);
  for (const bad of [{ quietMin: -1 }, { quietMin: 1.5 }, { quietMin: "90" }, { derivedAt: "noon" }]) {
    const t = structuredClone(s); Object.assign(t.board, bad);
    assert.ok(stateErrors(t).length, JSON.stringify(bad));
  }
});

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const raw = { artifactUrl: URL_, artifactSlug: "11111111-2222-4333-8444-555555555555", gate: { stateDir: "/srv/fb" }, collector: { repoPath: "/srv/repo", outDir: "/srv/fb/TestBoard01-out" } };
const spec = fenceSpec({ config: fullConfig(raw), configPath: "/srv/team/board.config.json", install: "/srv/fb/install/abc123", uid: 501 });
// The app's own success answer for a set, as 1,025 real writes gave it (Security): { db_write: { op, collection, doc_id, committed, version } }.
const OK = { db_write: { op: "set", collection: "derived", doc_id: "all", committed: true, version: 509, usage: { documents: 15219, max_documents: 25000 } }, owned: true, written: true };
const set = (over = {}, resp = OK, top = {}) => ({ hook_event_name: "PostToolUse", cwd: spec.cwd, tool_name: "ArtifactData", tool_input: { action: "set", url: URL_, collection: "derived", doc_id: "all", file_path: "/srv/fb/TestBoard01-out/derived-all.json", ...over }, ...(resp === undefined ? {} : { tool_response: resp }), ...top });

test("the fence leaves the marker for a set of derived/all that went through, and for nothing else", () => {
  const now = 1_800_000_000_000;
  const r = publishedOf(set(), spec, now);
  assert.equal(r.path, `${spec.cwd}/${PUBLISHED_FILE}`);
  assert.deepEqual(JSON.parse(r.content), { at: now });
  // Only the real success answer counts (Security R1): a text, nothing, an empty or odd object, an array, another document's answer,
  // committed false, a failed write's error all leave no marker.
  const no = (resp, why) => assert.equal(publishedOf(set({}, resp), spec, now), null, why);
  no("db write failed (version_mismatch): the document changed", "the real failure is a text");
  no("Database set committed", "a text, even a happy one");
  const bare = set(); delete bare.tool_response;
  assert.equal(publishedOf(bare, spec, now), null, "no answer at all");
  no(null, "null"); no({}, "an empty object"); no([], "an array");
  no({ is_error: true, db_write: OK.db_write }, "an error with the object");
  no({ error: "version conflict", db_write: OK.db_write }, "an error key with the object");
  no({ db_write: { ...OK.db_write, committed: false } }, "committed false");
  no({ db_write: { ...OK.db_write, committed: "true" } }, "committed as a text");
  no({ db_write: { ...OK.db_write, committed: undefined } }, "committed absent");
  no({ db_write: { ...OK.db_write, op: "update" } }, "another op");
  no({ db_write: { ...OK.db_write, collection: "waiting" } }, "another collection's answer");
  no({ db_write: { ...OK.db_write, doc_id: "other" } }, "another document's answer");
  no({ db_write: [OK.db_write] }, "an array of answers");
  no({ db_write: "committed" }, "a text under the key");
  // The call itself: this board's derived/all set, from the run's own folder.
  assert.equal(publishedOf(set({ action: "get" }), spec, now), null);
  assert.equal(publishedOf(set({ collection: "waiting" }), spec, now), null);
  assert.equal(publishedOf(set({ doc_id: "other" }), spec, now), null);
  assert.equal(publishedOf(set({ url: "https://claude.ai/artifact/Other" }), spec, now), null);
  assert.equal(publishedOf(set({}, OK, { cwd: "/srv/fb/Other" }), spec, now), null, "another folder");
  assert.equal(publishedOf(set({}, OK, { cwd: undefined }), spec, now), null, "no folder");
  assert.equal(publishedOf({ ...set(), tool_name: "Read" }, spec, now), null);
  assert.equal(publishedOf(null, spec, now), null);
});

test("a marker with a time outside the schema's range can't stop the probe's state (Security R2)", () => {
  const now = at("2026-11-10T18:00:00Z");
  for (const bad of [5, 0, -1, 1577836799999, 1.5e12 + 0.5, "soon", null, 4102444800001 * 2]) {
    const read = () => ({ whole: true, text: JSON.stringify({ at: bad }) });
    const p = publishedReading("/s/m.json", now, read, () => {});
    assert.deepEqual(p, { at: now, quietMin: 0 }, `${JSON.stringify(bad)}: a new baseline`);
    const s = buildState({ id: "flight-board", now, probe: null, pageVersion: null, cards: {}, agents: {}, published: p });
    assert.deepEqual(stateErrors(s), [], `${JSON.stringify(bad)}: the state still fits`);
  }
  const edge = () => ({ whole: true, text: JSON.stringify({ at: 1577836800000 }) });
  const p = publishedReading("/s/m.json", now, edge, () => {});
  assert.equal(p.at, 1577836800000);
  assert.ok(buildState({ id: "flight-board", now, probe: null, pageVersion: null, cards: {}, agents: {}, published: p }), "the lowest time the schema takes");
});

test("a healthy hourly Collector never shows red: its real 59m13s to 60m43s gaps, probed every minute, count at most 61", () => {
  // Hours of 2026-11-10 inside the schedule (15:00Z is 8 am); publishes 60m43s apart, the worst real gap.
  const first = at("2026-11-10T15:04:30Z");
  for (const gap of [59 * MIN + 13e3, 60 * MIN, 60 * MIN + 43e3]) {
    for (let probe = first + 30e3; probe < first + gap; probe += MIN) assert.ok(quietMinutes(first, probe) <= 61, `${gap}: at +${probe - first}`);
    assert.ok(quietMinutes(first, first + gap) <= 75);
  }
  // A run that is a quarter of an hour late is red; one a few minutes late is not.
  assert.ok(quietMinutes(first, first + 76 * MIN) > 75);
  assert.ok(quietMinutes(first, first + 70 * MIN) <= 75);
});

test("the chip goes red past 75 minutes of the schedule since the last publish, and says since when", () => {
  const now = Date.now();
  const make = (extra, board = {}) => {
    const b = loadNames(["managerChip", "set:(p)=>{probe=p}"]);
    b.state.messages = [];
    b.set({ v: 1, board: { at: now, wakeAliveAt: now - 5e3, wakeSeenAt: null, ...board, ...extra }, cards: {}, agents: {} });
    return JSON.parse(JSON.stringify(b.managerChip(now)));
  };
  // The task is hourly (0 8-20 * * *); its real gaps between publishes were 59m13s to 60m43s (Checker, 2026-11-03), so a healthy
  // Collector reaches 61 minutes before the next publish. The limit is one interval plus the run's own time: red past 75.
  assert.deepEqual(make({ derivedAt: now - 76 * MIN, quietMin: 76 }), { cls: "bad", text: `Collector has not published since ${hh(now - 76 * MIN)}` });
  assert.deepEqual(make({ quietMin: 76 }), { cls: "bad", text: "Collector has not published" });
  for (const q of [0, 59, 60, 61, 62, 75]) assert.deepEqual(make({ derivedAt: now - q * MIN, quietMin: q }), { cls: "ok", text: "Manager listening" }, `${q} is still fine`);
  assert.deepEqual(make({ derivedAt: now - 600 * MIN, quietMin: 0 }), { cls: "ok", text: "Manager listening" }, "a long night counts for nothing");
  assert.equal(make({}).text, "Manager listening", "a probe from before #C711 says nothing of it");
  assert.equal(make({ quietMin: 120, wakeAliveAt: null }).text, "Manager not listening · say wake up the team", "the Manager's red comes first");
  assert.equal(make({ quietMin: 120, cardsCheckedAt: now - 6 * MIN }).text, `Cards not checked since ${hh(now - 6 * MIN)}`, "and the cards' red before this one");
});
