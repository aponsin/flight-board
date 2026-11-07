// #C713: the app adds its own fields to every ArtifactData call and hands the hook the answer as an object, not text. The fence
// takes both, and the fields cannot widen the board, collection or path limits. REAL is the tool_input and the shape of the
// answer that failed the first v3.72 run (8:41 pm MT, 2026-11-06), copied from hook-parse-failure.json, with the board's ids
// changed to the test board's and the documents cut to two.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { fenceSpec, decide, captureOf, parseAdObject, appValueOk } from "../collector/fence.mjs";

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const SLUG = "11111111-2222-4333-8444-555555555555";
const raw = { artifactUrl: URL_, artifactSlug: SLUG, gate: { stateDir: "/srv/fb" }, collector: { repoPath: "/srv/repo", outDir: "/srv/fb/TestBoard01-out" } };
const spec = fenceSpec({ config: fullConfig(raw), configPath: "/srv/team/board.config.json", install: "/srv/fb/install/abc123", uid: 501 });
const S = "sess-0001";
const EXP = "/private/tmp/claude-501/-srv-fb-TestBoard01/sess-0001/scratchpad/flight-board-export";
const DERIVED = "/srv/fb/TestBoard01-out/derived-all.json";
const NOW = 1_800_000_000_000;
const read = (p) => { if (p !== DERIVED) throw new Error("no file"); return { cards: {}, at: 5 }; };
const fresh = (p) => (p === DERIVED ? NOW - 60e3 : NOW - 120e3);

const FIELDS = { __artifactDbReadTargetPin: { dir: null, asks: [] }, __artifactPlanConsentAsk: false, __artifactConsentPin: { action: "read_db", slug: SLUG }, __artifactConsentAskCanReachUser: false };
const REAL = { action: "list", url: URL_, collection: "initiatives", query: { limit: 150 }, ...FIELDS };
const RESPONSE = { db_read: { op: "list", collection: "initiatives", docs: [
  { id: "admin-actions-menu", data: { level: "Quick", name: "Admin: one Actions button", phase: "live", status: "done" }, version: 6, updatedAt: "2026-10-25T15:53:36.047126Z" },
  { id: "admin-actions-publish", data: { level: "Quick", phase: "live", status: "done" }, version: 5, updatedAt: "2026-10-25T15:53:36.065897Z" },
], next_cursor: "wyNbYW5v01nGYiPJRYro48bq_x-4qowQ6LThdmK" } };
const call = (tool_input, over = {}) => ({ session_id: S, cwd: "/srv/fb/TestBoard01", hook_event_name: "PreToolUse", tool_name: "ArtifactData", tool_input, ...over });
const post = (tool_input, tool_response) => ({ ...call(tool_input), hook_event_name: "PostToolUse", tool_response });
const pass = (c) => assert.equal(decide(c, spec, read, fresh, () => NOW), null, JSON.stringify(c.tool_input));
const refused = (c, part) => { const r = decide(c, spec, read, fresh, () => NOW); assert.ok(r && r.includes(part), `"${part}" in: ${r}`); };

test("the real failed call passes, before and after the answer; the old failure was these four fields", () => {
  pass(call(REAL));
  pass(post(REAL, RESPONSE));
  const { __artifactDbReadTargetPin, __artifactPlanConsentAsk, __artifactConsentPin, __artifactConsentAskCanReachUser, ...bare } = REAL;
  pass(call(bare));
});

test("the real answer is recorded as the same record a db_* read leaves, with the next cursor", () => {
  const r = captureOf(post(REAL, RESPONSE), spec, "1794022000000-deadbeef");
  assert.equal(r.error, undefined);
  assert.equal(r.path, `${EXP}/calls/1794022000000-deadbeef.json`);
  const rec = JSON.parse(r.content);
  assert.deepEqual({ ...rec, docs: rec.docs.map((d) => d.id) }, { tool: "list", collection: "initiatives", limit: 150, cursor: null, where: null, docs: ["admin-actions-menu", "admin-actions-publish"], next: "wyNbYW5v01nGYiPJRYro48bq_x-4qowQ6LThdmK" });
  assert.equal(rec.docs[0].data.phase, "live");
  // A last page: the cursor is empty, or absent, or null.
  for (const next_cursor of ["", undefined, null]) {
    const last = captureOf(post(REAL, { db_read: { ...RESPONSE.db_read, next_cursor } }), spec, "x");
    assert.equal(JSON.parse(last.content).next, null);
  }
  // A query keeps its where, written as db_query writes it; an empty page is a page.
  const q = { action: "query", url: URL_, collection: "steps", query: { where: [["at", ">=", 1793700000000]], limit: 200 }, ...FIELDS };
  const empty = captureOf(post(q, { db_read: { op: "query", collection: "steps", docs: [], next_cursor: "" } }), spec, "x");
  assert.deepEqual(JSON.parse(empty.content), { tool: "query", collection: "steps", limit: 200, cursor: null, where: [{ field: "at", op: ">=", value: 1793700000000 }], docs: [], next: null });
});

test("get: the version from the one document; none when there is no document", () => {
  const g = { action: "get", url: URL_, collection: "derived", doc_id: "all", ...FIELDS };
  const doc = { id: "all", data: { cards: {} }, version: 505, updatedAt: "2026-11-06T21:03:00Z" };
  for (const db_read of [{ op: "get", collection: "derived", docs: [doc] }, { op: "get", collection: "derived", doc }]) {
    assert.deepEqual(captureOf(post(g, { db_read }), spec, "x"), { path: `${EXP}/derived/all.json`, content: JSON.stringify({ version: 505 }) });
  }
  for (const db_read of [{ op: "get", collection: "derived", docs: [] }, { op: "get", collection: "derived", doc: null }, { op: "get", collection: "derived" }])
    assert.deepEqual(captureOf(post(g, { db_read }), spec, "x"), { path: `${EXP}/derived/all.json`, content: JSON.stringify({ version: null }) });
});

test("the app's fields cannot widen the limits: only plain markers pass", () => {
  for (const [k, v] of [
    ["__artifactDbReadTargetPin", { dir: "/Users/someone", asks: [] }],
    ["__artifactDbReadTargetPin", { dir: null, asks: ["x"] }],
    ["__artifactDbReadTargetPin", { dir: null, asks: [], url: "https://claude.ai/artifact/Other" }],
    ["__artifactConsentPin", { action: "read_db", slug: "00000000-0000-4000-8000-000000000000" }],
    ["__artifactConsentPin", { action: "read_db", slug: SLUG, path: "/etc/passwd" }],
    ["__artifactConsentPin", { action: "delete_db", slug: SLUG }],
    ["__artifactPlanConsentAsk", 1],
    ["__artifactPlanConsentAsk", "false"],
    ["__artifactTarget", "https://claude.ai/artifact/Other"],
    ["__artifactTarget", { a: { b: { c: { d: { e: null } } } } }],
    ["__artifactTarget", [1]],
  ]) refused(call({ ...REAL, [k]: v }), `unexpected ${k}`);
  // Only keys that are the app's own pattern: any other extra key is still refused, with a good value.
  for (const extra of ["out_dir", "as_level", "artifactConsentPin", "__other", "__artifact", "__artifact bad"]) refused(call({ ...REAL, [extra]: false }), `unexpected ${extra}`);
  // The fields change nothing else: a wrong board, collection or limit still refuses.
  refused(call({ ...REAL, url: "https://claude.ai/artifact/Other" }), "this board only");
  refused(call({ ...REAL, collection: "derived" }), "only the exported collections");
  refused(call({ ...REAL, query: { limit: 5000 } }), "query.limit");
  refused(call({ ...REAL, query: { limit: 5, out_dir: "/tmp/x" } }), "query has out_dir");
  assert.equal(appValueOk({ dir: null, asks: [], action: "write_db", slug: SLUG }, spec), true);
  assert.equal(appValueOk(URL_, spec), true);
});

test("the write path: a set carrying the same fields passes; a bad field or a changed set refuses; the answer to a set is not recorded", () => {
  const setAll = { action: "set", url: URL_, collection: "derived", doc_id: "all", file_path: DERIVED, if_version: 505 };
  pass(call({ ...setAll, ...FIELDS }));
  pass(call({ ...setAll, __artifactConsentPin: { action: "write_db", slug: SLUG }, __artifactConsentAskCanReachUser: true, __artifactDbWriteTargetPin: { dir: null, asks: [] } }));
  refused(call({ ...setAll, __artifactConsentPin: { action: "write_db", slug: "other" } }), "unexpected __artifactConsentPin");
  refused(call({ ...setAll, __artifactDbWriteTargetPin: { dir: "/tmp", asks: [] } }), "unexpected __artifactDbWriteTargetPin");
  refused(call({ ...setAll, file_path: "/srv/fb/other.json", ...FIELDS }), "from the collector's derived-all.json");
  refused(call({ ...setAll, collection: "waiting", ...FIELDS }), "derived/all only");
  refused(call({ ...setAll, data: { x: 1 }, ...FIELDS }), "unexpected data");
  assert.deepEqual(captureOf(post({ ...setAll, ...FIELDS }, { db_write: { op: "set", collection: "derived", doc_id: "all", version: 506 } }), spec, "x"), { skip: true });
});

test("parseAdObject: every field held to its type; an unknown key, another call, another collection or a bad cursor is no record", () => {
  const ok = (over) => ({ db_read: { ...RESPONSE.db_read, ...over } });
  assert.equal(parseAdObject(ok({}), "list", "initiatives").docs.length, 2);
  assert.equal(parseAdObject("text", "list", "initiatives"), null, "a text answer is left to the text parser");
  assert.equal(parseAdObject({ db_read: "x" }, "list", "initiatives"), null);
  for (const [over, why] of [
    [{ nextCursor: "abc" }, /has nextCursor/],
    [{ more: true }, /has more/],
    [{ op: "query" }, /another call/],
    [{ collection: "waiting" }, /this collection/],
    [{ docs: "x" }, /not a list/],
    [{ docs: [{ id: "a" }] }, /no id or no data/],
    [{ docs: [{ id: "../x", data: {} }] }, /no id or no data/],
    [{ count: 5 }, /count/],
    [{ next_cursor: 5 }, /not a string/],
    [{ next_cursor: "bad cursor;" }, /board's characters/],
    [{ next_cursor: "a".repeat(513) }, /board's characters/],
  ]) assert.match(parseAdObject(ok(over), "list", "initiatives").error ?? "", why, JSON.stringify(over));
  assert.match(parseAdObject({ db_read: { op: "get", collection: "derived", docs: [{ id: "all", data: {} }] } }, "get", "derived").error, /no version/);
  assert.match(parseAdObject({ db_read: { op: "get", collection: "derived", docs: [{ id: "all", data: {}, version: 1 }, { id: "b", data: {}, version: 1 }] } }, "get", "derived").error, /more than one/);
  // A failed capture marks the export failed, as before.
  const bad = captureOf(post(REAL, ok({ nextCursor: "abc" })), spec, "x");
  assert.match(bad.error, /nextCursor/);
  assert.equal(bad.failed, `${EXP}/calls/FAILED`);
});
