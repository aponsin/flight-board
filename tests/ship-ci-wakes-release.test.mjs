// #C1105: a ship candidate's CI run that finishes wakes Release once (11-16: Release sat on a v1.212.4 candidate whose CI had finished green).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun, shipCiDone, shipCiId } from "../collector/store-dispatch.mjs";
import { dispatchLine, DISPATCH_STATE_FILE } from "../gate/reset.mjs";

const MIN = 60e3, HOUR = 60 * MIN;
const AT = Date.UTC(2026, 10, 16, 20, 0);
const ROSTER = ["Manager", "Builder", "Release", "Ops"], LEAD = "Manager";
const scratch = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "c1105-")); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });
const state = (d) => JSON.parse(readFileSync(join(d, DISPATCH_STATE_FILE), "utf8"));
const idle = (at, ago = 20 * MIN) => ({ state: "idle", since: at - ago, lastActivityAt: at - ago, card: null });
// ship: the candidate's reading (null = none written this run); the heartbeat `board` is read each run.
const view = (at, ship, { rel = idle(at), live = "v1.212.3" } = {}) => ({
  cards: [], asks: [], live: { state: "live", version: live, age: 1000 },
  evidence: {
    agents: { readAt: at - 10_000, value: { Release: rel, Manager: idle(at, MIN), Builder: idle(at), Ops: idle(at) } },
    board: { readAt: at - 5_000, value: { at: at - 5_000 } },
    ...(ship ? { ship: { readAt: at - 5_000, value: { version: "1.212.4", at: at - 20 * MIN, ...ship } } } : {}),
  },
});
const run = (d, at, ship, o) => dispatchRun(view(at, ship, o), { dir: d, roster: ROSTER, lead: LEAD, now: at });
const mine = (r) => r.items.filter((i) => i.role === "Release");

test("shipCiId names the version and the result, and nothing odd", () => {
  assert.equal(shipCiId("1.212.4", "green"), "shipci-v1-212-4-green");
  assert.equal(shipCiId("v1.212.4", "red"), "shipci-v1-212-4-red");
  for (const [v, r] of [[null, "green"], ["1.2", "green"], ["1.2.3; x", "red"], ["1.2.3", "blue"], ["1.2.3", undefined]]) assert.equal(shipCiId(v, r), null, `${v} ${r}`);
});

test("a candidate that is queued or running wakes nobody; once its CI passes Release is woken once with a line that says so", () => {
  const d = dir();
  assert.deepEqual(mine(run(d, AT, { ci: "queued" })), []);
  assert.deepEqual(mine(run(d, AT + 2 * MIN, { ci: "running" })), []);
  assert.equal(state(d).shipci.ci, "running");
  const r = run(d, AT + 9 * MIN, { ci: "passed" });
  assert.equal(mine(r).length, 1);
  assert.equal(mine(r)[0].card, "shipci-v1-212-4-green");
  const line = dispatchLine(mine(r)[0]);
  assert.match(line, /^DISPATCH shipci-v1-212-4-green at ship: it SHIP CI FINISHED GREEN/);
  assert.match(line, /\(Release's turn;/);
  assert.equal(state(d).shipci.wokenAt, AT + 9 * MIN);
  // Still idle a minute later: still the same item, not a second wake.
  assert.equal(mine(run(d, AT + 10 * MIN, { ci: "passed" })).length, 1);
});

test("once Release has worked after the wake the candidate is done: no second wake while the candidate stands or after it is gone", () => {
  const d = dir();
  run(d, AT, { ci: "running" });
  assert.equal(mine(run(d, AT + 5 * MIN, { ci: "passed" })).length, 1);
  const working = { state: "working", since: AT + 6 * MIN, lastActivityAt: AT + 6 * MIN, card: null };
  assert.deepEqual(mine(run(d, AT + 7 * MIN, { ci: "passed" }, { rel: working })), []);
  assert.equal(state(d).shipci.done, true);
  assert.deepEqual(mine(run(d, AT + 2 * HOUR, { ci: "passed" }, { rel: idle(AT + 2 * HOUR, HOUR) })), [], "done stays done");
  assert.deepEqual(mine(run(d, AT + 3 * HOUR, null, { rel: idle(AT + 3 * HOUR, HOUR) })), [], "and when it is gone");
});

test("a candidate seen and then gone while its version is not live is a red wake, worded as such", () => {
  const d = dir();
  run(d, AT, { ci: "running" });
  const r = run(d, AT + 4 * MIN, null);
  assert.equal(mine(r).length, 1);
  assert.equal(mine(r)[0].card, "shipci-v1-212-4-red");
  assert.match(dispatchLine(mine(r)[0]), /SHIP CI ENDED WITHOUT PASSING/);
});

test("a candidate gone because its version went live wakes nobody; a green one that merged and went is not woken twice", () => {
  const live = dir();
  run(live, AT, { ci: "running" });
  assert.deepEqual(mine(run(live, AT + 4 * MIN, null, { live: "v1.212.4" })), []);
  assert.equal(state(live).shipci.done, true);
  const green = dir();
  run(green, AT, { ci: "running" });
  assert.equal(mine(run(green, AT + 3 * MIN, { ci: "passed" })).length, 1);
  const r = run(green, AT + 4 * MIN, null); // merged and gone before Release worked: the same green turn stands, no red one added
  assert.deepEqual(mine(r).map((i) => i.card), ["shipci-v1-212-4-green"]);
});

test("nothing is concluded from a stale heartbeat, and nothing is woken for a candidate with no readable version", () => {
  const d = dir();
  run(d, AT, { ci: "running" });
  const stale = view(AT + 30 * MIN, null);
  stale.evidence.board.readAt = AT + 30 * MIN - 20 * MIN;
  const r = dispatchRun(stale, { dir: d, roster: ROSTER, lead: LEAD, now: AT + 30 * MIN });
  assert.deepEqual(mine(r), [], "the reading stopped: the candidate is not called gone");
  assert.equal(state(d).shipci.result, undefined);
  const odd = dir();
  assert.deepEqual(mine(run(odd, AT, { ci: "passed", version: "latest" })), []);
  assert.equal(shipCiDone(view(AT, { ci: "passed", version: null }), null, {}, AT).card, null);
});

test("an old candidate is dropped after 6 hours and a new version starts again", () => {
  const d = dir();
  run(d, AT, { ci: "running" });
  assert.deepEqual(mine(run(d, AT + 7 * HOUR, { ci: "passed" }, { rel: idle(AT + 7 * HOUR, 6 * HOUR) })), [], "past the window");
  const next = run(d, AT + 8 * HOUR, { ci: "passed", version: "1.212.5" }, { rel: idle(AT + 8 * HOUR, 6 * HOUR) });
  assert.deepEqual(mine(next).map((i) => i.card), ["shipci-v1-212-5-green"]);
});
