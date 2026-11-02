// The collector run on demand, by a fact and not a clock (#C594): the every-minute probe finds a card whose phase the
// repository shows differently from the board's, and the lead's Stop hook asks for a run for it; the same set is asked for
// again only after an hour.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, clashReason, clashIds, clashKey, main, CLASH_AGAIN_MIN, CLASH_FRESH_MS } from "../collector/refresh.mjs";
import { phaseClashIds } from "../collector/state.mjs";
import { fullConfig } from "../scripts/config.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const base = { lead: true, stopActive: false, now: T, run: { startedAt: T - 30 * MIN, finishedAt: T - 29 * MIN } };

test("phaseClashIds: a card with evidence (a head) whose typed phase differs; sorted, at most 10, none for the declared echo", () => {
  const cards = [{ id: "b-card", phase: "build" }, { id: "a-card", phase: "test" }, { id: "c-card", phase: "checker" }, { id: "d-card", phase: "" }, { id: "e-card", phase: "build" }];
  const states = {
    "a-card": { phase: "checker", headSha12: "a".repeat(12) },
    "b-card": { phase: "build", headSha12: "b".repeat(12) },
    "c-card": { phase: "ship", headSha12: null },
    "d-card": { phase: "build", headSha12: "d".repeat(12) },
  };
  assert.deepEqual(phaseClashIds(cards, states), ["a-card"], "agree, no head, no typed phase, and no state are no clash");
  const many = Array.from({ length: 14 }, (_, k) => ({ id: `card-${String.fromCharCode(97 + k)}`, phase: "build" }));
  const all = Object.fromEntries(many.map((c) => [c.id, { phase: "test", headSha12: "a".repeat(12) }]));
  assert.equal(phaseClashIds(many, all).length, 10);
});

test("a clash asks for a run, once per set per hour; an odd id is no reason; the clock is not one", () => {
  assert.equal(decide(base), null, "nothing on the clock");
  assert.equal(decide({ ...base, now: T + 7 * 24 * 60 * MIN }), null, "a week later, still nothing");
  assert.match(decide({ ...base, clashes: ["a-card", "b-card"] }), /^phase differs from the repository: a-card, b-card$/);
  const key = clashKey(["a-card", "b-card"]);
  assert.equal(decide({ ...base, clashes: ["b-card", "a-card"], clashAsked: { key, at: T - (CLASH_AGAIN_MIN - 1) * MIN } }), null, "the same set, asked 59 min ago");
  assert.match(decide({ ...base, clashes: ["a-card", "b-card"], clashAsked: { key, at: T - (CLASH_AGAIN_MIN + 1) * MIN } }), /a-card, b-card/, "an hour on");
  assert.match(decide({ ...base, clashes: ["a-card", "b-card", "c-card"], clashAsked: { key, at: T - 5 * MIN } }), /c-card/, "a new set is asked at once");
  assert.equal(clashReason(["Not An Id!", 5, null], null, T), null);
  assert.equal(clashReason("a-card", null, T), null, "not a list");
  assert.equal(decide({ ...base, stopActive: true, clashes: ["a-card"] }), null);
  assert.equal(decide({ ...base, lead: false, clashes: ["a-card"] }), null);
  assert.equal(decide({ ...base, run: { startedAt: T - 3 * MIN, finishedAt: T - 60 * MIN }, clashes: ["a-card"] }), null, "a run in flight");
  assert.equal(decide({ ...base, run: { startedAt: T - 5 * MIN, finishedAt: T - 4 * MIN }, clashes: ["a-card"] }), null, "within the debounce");
});

test("the probe's file counts only when fresh, whole and a list of strings", () => {
  assert.deepEqual(clashIds({ at: T - 60e3, ids: ["a-card", 4, "b-card"] }, T), ["a-card", "b-card"]);
  assert.deepEqual(clashIds({ at: T - CLASH_FRESH_MS - 1, ids: ["a-card"] }, T), [], "the probe stopped");
  assert.deepEqual(clashIds({ at: T + 5 * MIN, ids: ["a-card"] }, T), [], "from the future");
  assert.deepEqual(clashIds({ at: T, ids: "a-card" }, T), []);
  assert.deepEqual(clashIds(null, T), []);
  assert.equal(clashIds({ at: T, ids: Array.from({ length: 30 }, () => "a-card") }, T).length, 10);
});

test("the hook reads phase-clashes.json, asks, remembers the set, and does not ask again for it", () => {
  const dir = mkdtempSync(join(tmpdir(), "clash-"));
  const raw = { artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", gate: { stateDir: dir }, collector: { repoPath: "/r", outDir: join(dir, "out"), refresh: { repos: [] } } };
  const config = fullConfig(raw), state = join(dir, "TestBoard01");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "export-since.json"), JSON.stringify({ at: T - 30 * MIN }));
  const p = join(dir, "lead.jsonl");
  writeFileSync(p, [{ customTitle: "Manager" }, { type: "user", timestamp: new Date(T - 40 * MIN).toISOString(), message: { role: "user", content: "thanks" } }].map((l) => JSON.stringify(l)).join("\n"));
  const opts = (now = T) => ({ config, env: {}, now, git: () => null });
  assert.equal(main({ transcript_path: p }, opts()), null, "no file from the probe");
  writeFileSync(join(state, "phase-clashes.json"), JSON.stringify({ at: T - 30e3, ids: ["a-card"] }));
  assert.match(main({ transcript_path: p }, opts()), /^Start the collector now: .*once \(phase differs from the repository: a-card\)/);
  const saved = JSON.parse(readFileSync(join(state, "refresh.json"), "utf8"));
  assert.deepEqual(saved.clashAsked, { key: "a-card", at: T });
  const later = T + 20 * MIN;
  writeFileSync(join(state, "phase-clashes.json"), JSON.stringify({ at: later - 30e3, ids: ["a-card"] }));
  assert.equal(main({ transcript_path: p }, opts(later)), null, "the same set, 20 min on: not again");
  assert.deepEqual(JSON.parse(readFileSync(join(state, "refresh.json"), "utf8")).clashAsked, { key: "a-card", at: T }, "kept");
  writeFileSync(join(state, "phase-clashes.json"), JSON.stringify({ at: later - 30e3, ids: ["a-card", "z-card"] }));
  assert.match(main({ transcript_path: p }, opts(later)), /a-card, z-card/, "a new card in the set");
});
