// #C713: the app adds its own fields to ArtifactData calls and hands the hook the answer as an object, not text. The fence takes
// both, and the fields cannot widen the board, collection or path limits. Where each real shape comes from:
//   - REAL (the four read fields): the tool_input of the first v3.72 run that failed (8:41 pm MT, 2026-11-06), from
//     hook-parse-failure.json, with the board's ids changed to the test board's.
//   - the answers {db_read: ...} for list, query (also an empty one), get, and a get of a missing document: the structured results
//     of real ArtifactData calls in this Mac's Code session transcripts (toolUseResult), copied with the board's ids changed.
//   - the two write fields (__artifactDbWriteSourcePin, __artifactDisplayTarget): the shapes in the app's own validator
//     (Claude.app ion-dist.asar), as Checker read them. No real set carrying them has been seen: the first real run is the trial.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { fenceSpec, decide, captureOf, parseAdObject, appFieldOk } from "../collector/fence.mjs";

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
const DOC = (id, version = 6) => ({ id, data: { level: "Quick", phase: "live", status: "done" }, version, updatedAt: "2026-10-25T15:53:36.047126Z" });
const RESPONSE = { db_read: { op: "list", collection: "initiatives", docs: [DOC("admin-actions-menu"), DOC("admin-actions-publish", 5)], next_cursor: "wyNbYW5v01nGYiPJRYro48bq_x-4qowQ6LThdmK" } };
const WRITE = { __artifactDbWriteSourcePin: { real: DERIVED, identity: "16777234:48213", linked: true }, __artifactDisplayTarget: { url: URL_, title: "Flight board" } };
const call = (tool_input, over = {}) => ({ session_id: S, cwd: "/srv/fb/TestBoard01", hook_event_name: "PreToolUse", tool_name: "ArtifactData", tool_input, ...over });
const post = (tool_input, tool_response) => ({ ...call(tool_input), hook_event_name: "PostToolUse", tool_response });
const postc = (tool_input) => ({ ...call(tool_input), hook_event_name: "PostToolUse" });
const pass = (c) => assert.equal(decide(c, spec, read, fresh, () => NOW), null, JSON.stringify(c.tool_input));
const refused = (c, part) => { const r = decide(c, spec, read, fresh, () => NOW); assert.ok(r && r.includes(part), `"${part}" in: ${r}`); };

test("the real failed call passes at PostToolUse and is refused at PreToolUse; the bare call passes both", () => {
  refused(call(REAL), "unexpected __artifactDbReadTargetPin");
  pass(post(REAL, RESPONSE));
  const { __artifactDbReadTargetPin, __artifactPlanConsentAsk, __artifactConsentPin, __artifactConsentAskCanReachUser, ...bare } = REAL;
  pass(call(bare));
  pass(post(bare, RESPONSE));
  // Consent plumbing typed before a read is refused, whatever its value (Security R1).
  for (const typed of [{ __artifactSkipConsent: true }, { __artifactGrantAll: { everything: true } }, { __artifactConsentPin: { action: "write_db", slug: SLUG } }, { __artifactPlanConsentAsk: false }])
    refused(call({ ...bare, ...typed }), "unexpected __artifact");
});

test("only the app's exact field names pass, never a name pattern; the write's two are not for a read", () => {
  for (const name of ["__artifactSecret", "__artifactEndpointBodyFile", "__artifactAsk", "__artifactSkipConsent", "__artifactGrantAll", "__artifact", "__artifactDbReadTargetPinX", "artifactConsentPin", "__other"])
    for (const value of [true, false, null, "null", [], {}]) refused(postc({ ...REAL, [name]: value }), `unexpected ${name}`);
  refused(postc({ ...REAL, ...WRITE }), "unexpected __artifactDbWriteSourcePin");
  for (const name of ["__artifactSecret", "__artifactEndpointBodyFile", "__artifactAsk"]) refused(call({ ...setAll(), [name]: null }), `unexpected ${name}`);
});

test("the real answers are recorded as the same record a db_* read leaves", () => {
  const r = captureOf(post(REAL, RESPONSE), spec, "1794022000000-deadbeef");
  assert.equal(r.error, undefined);
  assert.equal(r.path, `${EXP}/calls/1794022000000-deadbeef.json`);
  const rec = JSON.parse(r.content);
  assert.deepEqual({ ...rec, docs: rec.docs.map((d) => d.id) }, { tool: "list", collection: "initiatives", limit: 150, cursor: null, where: null, docs: ["admin-actions-menu", "admin-actions-publish"], next: "wyNbYW5v01nGYiPJRYro48bq_x-4qowQ6LThdmK" });
  assert.equal(rec.docs[0].data.phase, "live");
  // The last page of a list has no cursor or an empty one; a real empty query is {op, collection, docs: []}.
  for (const next_cursor of ["", undefined, null]) assert.equal(JSON.parse(captureOf(post(REAL, { db_read: { ...RESPONSE.db_read, next_cursor } }), spec, "x").content).next, null);
  const q = { action: "query", url: URL_, collection: "steps", query: { where: [["at", ">=", 1793700000000]], limit: 200 }, ...FIELDS };
  const empty = captureOf(post(q, { db_read: { op: "query", collection: "steps", docs: [] } }), spec, "x");
  assert.deepEqual(JSON.parse(empty.content), { tool: "query", collection: "steps", limit: 200, cursor: null, where: [{ field: "at", op: ">=", value: 1793700000000 }], docs: [], next: null });
});

test("get: the real shapes (a found document; found: false with no docs); only found: false means none", () => {
  const g = { action: "get", url: URL_, collection: "derived", doc_id: "all", ...FIELDS };
  const seal = (v) => ({ path: `${EXP}/derived/all.json`, content: JSON.stringify({ version: v }) });
  assert.deepEqual(captureOf(post(g, { db_read: { op: "get", collection: "derived", doc_id: "all", found: true, docs: [DOC("all", 505)] } }), spec, "x"), seal(505));
  assert.deepEqual(captureOf(post(g, { db_read: { op: "get", collection: "derived", doc_id: "all", found: false } }), spec, "x"), seal(null));
  const one = (db_read) => parseAdObject({ db_read: { op: "get", collection: "derived", doc_id: "all", ...db_read } }, "get", "derived", "all");
  assert.deepEqual(one({ found: false, docs: [] }), { version: null });
  for (const [over, why] of [
    [{ found: true }, /found does not match/],
    [{ found: true, docs: [] }, /found does not match/],
    [{ found: false, docs: [DOC("all", 3)] }, /found does not match/],
    [{ found: undefined }, /does not say whether/],
    [{ found: "true", docs: [DOC("all", 3)] }, /does not say whether/],
    [{ found: true, docs: [DOC("other", 3)] }, /another document/],
    [{ found: true, docs: [DOC("all", 3), DOC("all", 4)] }, /more than one/],
    [{ found: true, docs: [{ id: "all", data: {} }] }, /no version/],
    [{ found: true, docs: DOC("all", 3) }, /list of documents/],
    [{ doc_id: "other", found: false }, /another document/],
    [{ doc: DOC("all", 3), found: true }, /has doc/],
    [{ exists: true, found: true, docs: [DOC("all", 3)] }, /has exists/],
    [{ count: 1, found: true, docs: [DOC("all", 3)] }, /has count/],
  ]) assert.match(one(over).error ?? "", why, JSON.stringify(over));
});

test("a list or query is a whole page only with docs as a list, and nothing besides the real keys", () => {
  const ok = (over) => ({ db_read: { ...RESPONSE.db_read, ...over } });
  assert.equal(parseAdObject(ok({}), "list", "initiatives").docs.length, 2);
  assert.equal(parseAdObject("text", "list", "initiatives"), null, "a text answer is left to the text parser");
  assert.equal(parseAdObject({ db_read: "x" }, "list", "initiatives"), null);
  for (const [over, why] of [
    [{ nextCursor: "abc" }, /has nextCursor/],
    [{ more: true }, /has more/],
    [{ doc: DOC("a") }, /has doc/],
    [{ count: 2 }, /has count/],
    [{ exists: true }, /has exists/],
    [{ found: true }, /has found/],
    [{ doc_id: "a" }, /has doc_id/],
    [{ op: "query" }, /another call/],
    [{ collection: "waiting" }, /this collection/],
    [{ docs: "x" }, /list of documents/],
    [{ docs: undefined }, /list of documents/],
    [{ docs: [{ id: "a" }] }, /no id or no data/],
    [{ docs: [{ id: "../x", data: {} }] }, /no id or no data/],
    [{ next_cursor: 5 }, /not a string/],
    [{ next_cursor: "bad cursor;" }, /board's characters/],
    [{ next_cursor: "a".repeat(513) }, /board's characters/],
  ]) assert.match(parseAdObject(ok(over), "list", "initiatives").error ?? "", why, JSON.stringify(over));
  assert.match(parseAdObject({ db_read: { op: "list", collection: "initiatives" } }, "list", "initiatives").error, /list of documents/);
  assert.match(parseAdObject({ db_read: { op: "query", collection: "initiatives", next_cursor: "" } }, "query", "initiatives").error, /list of documents/);
  assert.match(parseAdObject({ ...ok({}), next_cursor: "abc" }, "list", "initiatives").error, /beside db_read/);
  assert.match(parseAdObject({ ...ok({}), truncated: true }, "list", "initiatives").error, /beside db_read/);
  const bad = captureOf(post(REAL, ok({ nextCursor: "abc" })), spec, "x");
  assert.match(bad.error, /nextCursor/);
  assert.equal(bad.failed, `${EXP}/calls/FAILED`);
});

function setAll(extra = {}) { return { action: "set", url: URL_, collection: "derived", doc_id: "all", file_path: DERIVED, if_version: 505, ...extra }; }

test("each field is held to its exact shape (every inner key, every value)", () => {
  const ok = (k, v) => appFieldOk(k, v, spec);
  assert.equal(ok("__artifactDbReadTargetPin", { dir: null, asks: [] }), true);
  for (const v of [{ dir: SLUG, asks: [] }, { dir: "/etc", asks: [] }, { dir: null, asks: [1] }, { dir: null }, { asks: [] }, { dir: null, asks: [], x: 1 }, { dir: null, asks: {} }, null, [], "x"])
    assert.equal(ok("__artifactDbReadTargetPin", v), false, JSON.stringify(v));
  for (const k of ["__artifactPlanConsentAsk", "__artifactConsentAskCanReachUser"]) {
    assert.equal(ok(k, true), true);
    for (const v of [null, "null", "false", 0, [], {}]) assert.equal(ok(k, v), false, `${k} ${JSON.stringify(v)}`);
  }
  assert.equal(ok("__artifactConsentPin", { action: "read_db", slug: SLUG }), true);
  assert.equal(ok("__artifactConsentPin", { action: "write_db", slug: SLUG }), true);
  for (const v of [{ action: "read_db", slug: "other" }, { action: "delete_db", slug: SLUG }, { action: "read_db" }, { slug: SLUG }, { action: "read_db", slug: SLUG, path: "/x" }, { action: "read_db", slug: URL_ }])
    assert.equal(ok("__artifactConsentPin", v), false, JSON.stringify(v));
  assert.equal(ok("__artifactDbWriteSourcePin", WRITE.__artifactDbWriteSourcePin), true);
  assert.equal(ok("__artifactDbWriteSourcePin", { real: DERIVED, identity: null }), true);
  for (const v of [{ real: "/etc/passwd", identity: null }, { real: DERIVED, identity: "abc" }, { real: DERIVED, identity: "1 2" }, { real: DERIVED, identity: "1".repeat(97) }, { real: DERIVED, identity: null, linked: "yes" }, { real: DERIVED, identity: null, extra: 1 }, { identity: null }, { real: DERIVED }])
    assert.equal(ok("__artifactDbWriteSourcePin", v), false, JSON.stringify(v));
  assert.equal(ok("__artifactDisplayTarget", WRITE.__artifactDisplayTarget), true);
  assert.equal(ok("__artifactDisplayTarget", { url: URL_, title: "x".repeat(120) }), true);
  // The app's write path (Claude Code 2.1.317, as Checker read it): the title is optional, the url is the board's link or the
  // /code/artifact form with the board's slug, and the user-only ask is the literal false.
  assert.equal(ok("__artifactDisplayTarget", { url: URL_ }), true);
  assert.equal(ok("__artifactDisplayTarget", { url: `https://claude.ai/code/artifact/${SLUG}` }), true);
  assert.equal(ok("__artifactDisplayTarget", { url: `https://claude.ai/code/artifact/${SLUG}`, title: "Flight board" }), true);
  assert.equal(ok("__artifactUserOnlyConsentAsk", false), true);
  for (const v of [true, null, "false", 0, [], {}, undefined]) assert.equal(ok("__artifactUserOnlyConsentAsk", v), false, String(v));
  for (const v of [{ url: "https://claude.ai/artifact/Other", title: "t" }, { url: "https://claude.ai/code/artifact/other", title: "t" }, { url: `https://staging.claude.ai/code/artifact/${SLUG}` }, { url: `https://claude.ai/code/artifact/${SLUG}/x` }, { url: URL_, title: "x".repeat(121) }, { url: URL_, title: "a\nb" }, { url: URL_, title: 5 }, { url: URL_, title: null }, { title: "t" }, {}, { url: URL_, title: "t", extra: 1 }])
    assert.equal(ok("__artifactDisplayTarget", v), false, JSON.stringify(v));
  assert.equal(ok("__artifactSecret", true), false);
});

test("the write path: a set carrying the app's fields passes at either hook; any wrong field, or a changed set, refuses; a set's answer is not recorded", () => {
  pass(call({ ...setAll(), ...FIELDS, ...WRITE }));
  pass(postc({ ...setAll(), ...FIELDS, ...WRITE }));
  pass(call({ ...setAll(), __artifactConsentPin: { action: "write_db", slug: SLUG } }));
  // The write ask path as the app builds it: user-only ask false, a display target with no title, the /code/artifact url.
  const ASK = { __artifactPlanConsentAsk: false, __artifactUserOnlyConsentAsk: false, __artifactConsentPin: { action: "write_db", slug: SLUG }, __artifactDisplayTarget: { url: `https://claude.ai/code/artifact/${SLUG}` } };
  pass(call({ ...setAll(), ...ASK }));
  pass(postc({ ...setAll(), ...ASK }));
  refused(call({ ...setAll(), ...ASK, __artifactUserOnlyConsentAsk: true }), "unexpected __artifactUserOnlyConsentAsk");
  // It is the write's field only: a read refuses it at either hook.
  const readOnly = { action: "list", url: URL_, collection: "initiatives", query: { limit: 150 }, __artifactUserOnlyConsentAsk: false };
  refused(call(readOnly), "unexpected __artifactUserOnlyConsentAsk");
  refused(postc(readOnly), "unexpected __artifactUserOnlyConsentAsk");
  refused(call({ ...setAll(), __artifactConsentPin: { action: "write_db", slug: "other" } }), "unexpected __artifactConsentPin");
  refused(call({ ...setAll(), __artifactDbWriteSourcePin: { real: "/srv/fb/other.json", identity: null } }), "unexpected __artifactDbWriteSourcePin");
  refused(call({ ...setAll(), __artifactDisplayTarget: { url: "https://claude.ai/artifact/Other", title: "t" } }), "unexpected __artifactDisplayTarget");
  refused(call({ ...setAll(), __artifactSecret: true }), "unexpected __artifactSecret");
  refused(call({ ...setAll({ file_path: "/srv/fb/other.json" }), ...WRITE }), "from the collector's derived-all.json");
  refused(call({ ...setAll({ collection: "waiting" }), ...FIELDS }), "derived/all only");
  refused(call({ ...setAll({ data: { x: 1 } }), ...FIELDS }), "unexpected data");
  assert.deepEqual(captureOf(post({ ...setAll(), ...FIELDS, ...WRITE }, { db_write: { op: "set", collection: "derived", doc_id: "all", version: 506 } }), spec, "x"), { skip: true });
  // The fields change no limit of a read: another board, collection, limit or an out_dir still refuses.
  refused(postc({ ...REAL, url: "https://claude.ai/artifact/Other" }), "this board only");
  refused(postc({ ...REAL, collection: "derived" }), "only the exported collections");
  refused(postc({ ...REAL, query: { limit: 5000 } }), "query.limit");
  refused(postc({ ...REAL, query: { limit: 5, out_dir: "/tmp/x" } }), "query has out_dir");
});
