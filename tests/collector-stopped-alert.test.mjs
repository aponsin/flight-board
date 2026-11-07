// #C711: the board says so when the Collector stops publishing. The fence leaves a marker when the run's set of derived/all goes
// through; the every-minute probe counts the minutes of the Collector's schedule (8 am to 8 pm Mountain time) since it, and the page's
// chip goes red past 60. A night without runs is no outage.
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
const set = (over = {}, resp) => ({ hook_event_name: "PostToolUse", tool_name: "ArtifactData", tool_input: { action: "set", url: URL_, collection: "derived", doc_id: "all", file_path: "/srv/fb/TestBoard01-out/derived-all.json", ...over }, ...(resp === undefined ? {} : { tool_response: resp }) });

test("the fence leaves the marker for a set of derived/all that went through, and for nothing else", () => {
  const now = 1_800_000_000_000;
  const r = publishedOf(set(), spec, now);
  assert.equal(r.path, `${spec.cwd}/${PUBLISHED_FILE}`);
  assert.deepEqual(JSON.parse(r.content), { at: now });
  assert.ok(publishedOf(set({}, { db_write: { op: "set", version: 509 } }), spec, now), "with an answer object");
  assert.ok(publishedOf(set({}, "Database set committed"), spec, now), "with a text answer");
  assert.equal(publishedOf(set({}, { is_error: true }), spec, now), null, "an error answer");
  assert.equal(publishedOf(set({}, { error: "version conflict" }), spec, now), null);
  assert.equal(publishedOf(set({ action: "get" }), spec, now), null);
  assert.equal(publishedOf(set({ collection: "waiting" }), spec, now), null);
  assert.equal(publishedOf(set({ doc_id: "other" }), spec, now), null);
  assert.equal(publishedOf(set({ url: "https://claude.ai/artifact/Other" }), spec, now), null);
  assert.equal(publishedOf({ ...set(), tool_name: "Read" }, spec, now), null);
  assert.equal(publishedOf(null, spec, now), null);
});

test("the chip goes red past 60 minutes of the schedule since the last publish, and says since when", () => {
  const now = Date.now();
  const make = (extra, board = {}) => {
    const b = loadNames(["managerChip", "set:(p)=>{probe=p}"]);
    b.state.messages = [];
    b.set({ v: 1, board: { at: now, wakeAliveAt: now - 5e3, wakeSeenAt: null, ...board, ...extra }, cards: {}, agents: {} });
    return JSON.parse(JSON.stringify(b.managerChip(now)));
  };
  assert.deepEqual(make({ derivedAt: now - 61 * MIN, quietMin: 61 }), { cls: "bad", text: `Collector has not published since ${hh(now - 61 * MIN)}` });
  assert.deepEqual(make({ quietMin: 61 }), { cls: "bad", text: "Collector has not published" });
  assert.deepEqual(make({ derivedAt: now - 60 * MIN, quietMin: 60 }), { cls: "ok", text: "Manager listening" }, "60 is still fine");
  assert.deepEqual(make({ derivedAt: now - 600 * MIN, quietMin: 0 }), { cls: "ok", text: "Manager listening" }, "a long night counts for nothing");
  assert.equal(make({}).text, "Manager listening", "a probe from before #C711 says nothing of it");
  assert.equal(make({ quietMin: 120, wakeAliveAt: null }).text, "Manager not listening · say wake up the team", "the Manager's red comes first");
  assert.equal(make({ quietMin: 120, cardsCheckedAt: now - 6 * MIN }).text, `Cards not checked since ${hh(now - 6 * MIN)}`, "and the cards' red before this one");
});
