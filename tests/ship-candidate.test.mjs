// #C679 (2026-11-04: the "Safe to restart" badge was green while Release's v1.200.6 ship waited on CI; the owner restarted and the
// ship died): the probe reads a pushed ship candidate itself, and the state carries it as ship { version, ci, at }, an optional key the
// Worker must take. The page's side is in tests/restart-check.test.mjs. Fictional versions.
import test from "node:test";
import assert from "node:assert/strict";
import { stateErrors, pickState, SHIP_CI, EXTRA_KEYS } from "../collector/state-schema.mjs";
import { shipCandidate, SHIP_CANDIDATE_MAX_MS, buildState } from "../collector/state.mjs";
import worker, { sha256hex, secretName, RATE_MS, changeKey } from "../worker/state-worker.mjs";

const T = Date.UTC(2026, 10, 4, 17, 40);
const SHA = "e3016d3" + "0".repeat(33), SHA2 = "f4127e4" + "0".repeat(33), SHA3 = "a5238f5" + "0".repeat(33);
const PATTERN = "^build/ship-v\\d+\\.\\d+\\.\\d+$";
const tip = (branch, sha, minutesAgo) => ({ branch, sha, at: T - minutesAgo * 60e3, message: "" });
const never = () => false;
const ciOf = (map) => (sha) => ({ ci: map[sha] ?? "none", ciMin: null });

test("a candidate branch pushed and not on main is in flight, with its version and CI state", () => {
  const tips = [tip("build/some-card", SHA2, 1), tip("build/ship-v1.200.6", SHA, 4)];
  assert.deepEqual(shipCandidate({ tips, pattern: PATTERN, now: T, onMain: never, ci: ciOf({ [SHA]: "queued" }) }), { version: "1.200.6", ci: "queued", at: T - 4 * 60e3 });
  for (const ci of ["queued", "running", "passed", "none"]) assert.equal(shipCandidate({ tips, pattern: PATTERN, now: T, onMain: never, ci: ciOf({ [SHA]: ci }) }).ci, ci, ci);
});

test("not in flight: on main already, a finished-bad run, an old branch left after a red run, no pattern, no candidate", () => {
  const tips = [tip("build/ship-v1.200.6", SHA, 4)];
  assert.equal(shipCandidate({ tips, pattern: PATTERN, now: T, onMain: () => true, ci: ciOf({ [SHA]: "queued" }) }), null, "merged: on main");
  assert.equal(shipCandidate({ tips, pattern: PATTERN, now: T, onMain: never, ci: ciOf({ [SHA]: "failed" }) }), null, "its run failed");
  assert.equal(shipCandidate({ tips, pattern: PATTERN, now: T, onMain: never, ci: ciOf({ [SHA]: "cancelled" }) }), null, "its run was cancelled");
  const old = [tip("build/ship-v1.200.5", SHA, SHIP_CANDIDATE_MAX_MS / 60e3 + 1)];
  assert.equal(shipCandidate({ tips: old, pattern: PATTERN, now: T, onMain: never, ci: ciOf({}) }), null, "over 6 hours old");
  assert.notEqual(shipCandidate({ tips: [tip("build/ship-v1.200.5", SHA, SHIP_CANDIDATE_MAX_MS / 60e3 - 1)], pattern: PATTERN, now: T, onMain: never, ci: ciOf({}) }), null, "just under");
  assert.equal(shipCandidate({ tips, pattern: "", now: T, onMain: never, ci: ciOf({}) }), null, "no candidatePattern in the config");
  assert.equal(shipCandidate({ tips: [tip("build/card", SHA, 1)], pattern: PATTERN, now: T, onMain: never, ci: ciOf({}) }), null, "no branch matches");
  assert.equal(shipCandidate({ tips, pattern: "(", now: T, onMain: never, ci: ciOf({}) }), null, "a pattern that is not a regular expression");
  assert.equal(shipCandidate({ tips: [{ ...tips[0], at: T + 3600e3 }], pattern: PATTERN, now: T, onMain: never, ci: ciOf({}) }), null, "a tip dated an hour ahead of this clock");
  assert.equal(shipCandidate({ tips: [{ ...tips[0], sha: "nope" }], pattern: PATTERN, now: T, onMain: never, ci: ciOf({}) }), null, "not a sha");
});

test("the newest candidate that is still in flight counts; a failed newer one does not hide an older live one; a CI read that can't be made still counts", () => {
  const tips = [tip("build/ship-v1.200.4", SHA3, 50), tip("build/ship-v1.200.6", SHA, 4), tip("build/ship-v1.200.5", SHA2, 20)];
  assert.equal(shipCandidate({ tips, pattern: PATTERN, now: T, onMain: never, ci: ciOf({ [SHA]: "running" }) }).version, "1.200.6", "the newest");
  assert.equal(shipCandidate({ tips, pattern: PATTERN, now: T, onMain: never, ci: ciOf({ [SHA]: "failed", [SHA2]: "queued" }) }).version, "1.200.5", "the next one down");
  assert.deepEqual(shipCandidate({ tips: [tips[1]], pattern: PATTERN, now: T, onMain: never, ci: () => null }), { version: "1.200.6", ci: "none", at: T - 4 * 60e3 }, "no CI reading: pushed and not on main");
  assert.equal(shipCandidate({ tips: [tip("build/ship-vX", SHA, 1)], pattern: "^build/ship-", now: T, onMain: never, ci: ciOf({}) }).version, null, "no version in the name: none, never the name");
});

const base = (extra = {}) => ({ id: "TestBoard42xyz", now: T, probe: "ec6b4ed97e39", pageVersion: "842a30f31c16", cards: {}, agents: {}, ...extra });
test("the schema: ship {version, ci, at} fits, version may be null, nothing else does; a state without it still fits", () => {
  assert.deepEqual(EXTRA_KEYS.includes("ship"), true);
  assert.deepEqual(stateErrors(buildState(base())), []);
  const s = buildState(base({ ship: { version: "1.200.6", ci: "queued", at: T } }));
  assert.deepEqual(s.ship, { version: "1.200.6", ci: "queued", at: T });
  assert.deepEqual(buildState(base({ ship: { version: null, ci: "none", at: T } })).ship, { version: null, ci: "none", at: T });
  assert.equal("ship" in buildState(base()), false, "left out when there is none");
  for (const ci of SHIP_CI) assert.deepEqual(stateErrors({ ...s, ship: { ...s.ship, ci } }), [], ci);
  const bad = [{ ...s.ship, ci: "failed" }, { ...s.ship, ci: "x" }, { ...s.ship, version: "v1.2.3" }, { ...s.ship, version: "1.2" }, { ...s.ship, version: "<b>" }, { ...s.ship, at: "now" }, { ...s.ship, at: 5 }, { version: "1.2.3", ci: "queued" }, { ...s.ship, branch: "build/ship-v1.2.3" }, "x", null, [], 7];
  for (const ship of bad) assert.ok(stateErrors({ ...s, ship }).length, JSON.stringify(ship));
  assert.ok(stateErrors({ ...s, ship: { ...s.ship, branch: "SECRET-branch" } }).every((m) => !m.includes("SECRET")), "an error never quotes it");
  assert.throws(() => buildState(base({ ship: { version: "1.2.3", ci: "failed", at: T } })), /doesn't fit the plan/);
});

test("pickState carries ship field by field and nothing else of it", () => {
  const s = buildState(base({ ship: { version: "1.200.6", ci: "running", at: T } }));
  const picked = pickState({ ...s, ship: { ...s.ship } });
  assert.deepEqual(picked.ship, { version: "1.200.6", ci: "running", at: T });
});

// --- The Worker -----------------------------------------------------------------------------------------------------------------

const TOKEN = "a".repeat(64), PATH = "b".repeat(32), BOARD = "TestBoard42xyz";
async function envFor() {
  const kv = new Map();
  const env = { STATE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
  env[await secretName(BOARD)] = JSON.stringify({ token: await sha256hex(TOKEN), path: await sha256hex(PATH) });
  return { env, kv };
}
const post = (body) => new Request(`https://w.example/b/${BOARD}/state`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const answer = (env, now) => worker.fetch(new Request(`https://w.example/mcp/${PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "board_state", arguments: {} } }) }), env, {}, now).then((r) => r.json());

test("the Worker takes a state with ship, stores it the minute it appears or changes, and board_state answers it", async () => {
  const { env, kv } = await envFor();
  const quiet = buildState(base({ id: BOARD }));
  const withShip = (ci, at = T) => buildState(base({ id: BOARD, now: at, ship: { version: "1.200.6", ci, at: T } }));
  assert.equal((await worker.fetch(post(quiet), env, {}, T)).status, 204);
  const key = [...kv.keys()][0], before = kv.get(key);
  // The same state minutes later: nothing the page shows changed, so nothing is written.
  assert.equal((await worker.fetch(post(buildState(base({ id: BOARD, now: T + RATE_MS }))), env, {}, T + RATE_MS)).status, 204);
  assert.equal(kv.get(key), before, "an unchanged POST writes nothing");
  // A candidate appears: stored at once, not at the heartbeat.
  assert.equal((await worker.fetch(post(withShip("queued", T + 2 * RATE_MS)), env, {}, T + 2 * RATE_MS)).status, 204);
  assert.notEqual(kv.get(key), before, "the candidate was stored the next minute");
  assert.deepEqual((await answer(env, T + 2 * RATE_MS)).result.structuredContent.ship, { version: "1.200.6", ci: "queued", at: T });
  // Its CI moves: stored; it goes: stored (the key says no ship).
  const q = kv.get(key);
  assert.equal((await worker.fetch(post(withShip("running", T + 3 * RATE_MS)), env, {}, T + 3 * RATE_MS)).status, 204);
  assert.notEqual(kv.get(key), q, "queued -> running is a change");
  const r = kv.get(key);
  assert.equal((await worker.fetch(post(buildState(base({ id: BOARD, now: T + 4 * RATE_MS }))), env, {}, T + 4 * RATE_MS)).status, 204);
  assert.notEqual(kv.get(key), r, "gone is a change");
  assert.equal("ship" in (await answer(env, T + 4 * RATE_MS)).result.structuredContent, false);
  assert.notEqual(changeKey(withShip("queued")), changeKey(quiet));
  assert.notEqual(changeKey(withShip("queued")), changeKey(withShip("running")));
});

test("the Worker still refuses a ship that is not the plan's, and quotes nothing of it", async () => {
  const { env } = await envFor();
  const s = { ...buildState(base({ id: BOARD })), ship: { version: "1.2.3", ci: "queued", at: T, branch: "SECRET" } };
  const r = await worker.fetch(post(s), env, {}, T);
  assert.equal(r.status, 400);
  assert.ok(!(await r.text()).includes("SECRET"));
});
