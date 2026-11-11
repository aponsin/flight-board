// #C909: a new live product version wakes Ops once for its after-ship check, through the dispatch (no peer message, no Manager).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun, afterShip, afterShipId, AFTER_SHIP_WINDOW_MS } from "../collector/store-dispatch.mjs";
import { dispatchLine, dispatchPending, DISPATCH_FILE, DISPATCH_STATE_FILE } from "../gate/reset.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Builder", "Ops"], LEAD = "Manager";
const dir = () => mkdtempSync(join(tmpdir(), "c909-"));
const read = (d, f) => JSON.parse(readFileSync(join(d, f), "utf8"));
// A view with no cards: the live reading and Ops's agent reading only. `ops`: Ops's state and when it last changed.
const view = ({ version = "v1.209.13", at = NOW, ops = { state: "idle", since: at - 20 * MIN }, live = "live" } = {}) => ({
  cards: [], asks: [], live: { state: live, version, age: 1000 },
  evidence: { agents: { readAt: at - 10_000, value: { Ops: { ...ops, lastActivityAt: ops.since, card: null }, Manager: { state: "idle", since: at - MIN, lastActivityAt: at - MIN, card: null } } } },
});
const run = (v, d, now) => dispatchRun(v, { dir: d, roster: ROSTER, lead: LEAD, now });
const opsItems = (r) => r.items.filter((i) => i.role === "Ops");

test("the turn's id names the version; anything that is not a plain x.y.z names none", () => {
  assert.equal(afterShipId("v1.209.13"), "after-ship-v1-209-13");
  assert.equal(afterShipId("1.2.3"), "after-ship-v1-2-3");
  for (const bad of ["", "v1.2", "v1.2.3.4", "v1.2.3-rc1", "1.2.x", "v1.2.3; rm", null, undefined]) assert.equal(afterShipId(bad), null, String(bad));
});

test("a new live version wakes Ops once: one item on the run that sees it, none after Ops has worked, none for the unchanged version", () => {
  const d = dir();
  // First run: the version already live is remembered, nobody is woken for it.
  assert.deepEqual(opsItems(run(view(), d, NOW)), []);
  assert.equal(read(d, DISPATCH_STATE_FILE).live.version, "1.209.13");
  // Unchanged version, Ops idle: still nobody.
  assert.deepEqual(opsItems(run(view({ at: NOW + MIN }), d, NOW + MIN)), []);
  // A new version: one item for Ops, and its DISPATCH line names the version.
  const t = NOW + 2 * MIN;
  const r = run(view({ version: "v1.209.14", at: t }), d, t);
  assert.equal(opsItems(r).length, 1);
  assert.equal(opsItems(r)[0].card, "after-ship-v1-209-14");
  assert.match(dispatchLine(opsItems(r)[0]), /^DISPATCH after-ship-v1-209-14: it waits on you \(Ops\)/);
  assert.equal(dispatchPending(read(d, DISPATCH_FILE), null, { role: "Ops", level: 1 }).length, 1, "Ops's watch picks it up");
  assert.equal(read(d, DISPATCH_STATE_FILE).live.wokenAt, t);
  // The next run, Ops still idle (its watch may not have printed yet): the same item, the same since, so the watch prints it once.
  const r2 = run(view({ version: "v1.209.14", at: t + MIN, ops: { state: "idle", since: t - 20 * MIN } }), d, t + MIN);
  assert.equal(opsItems(r2).length, 1); assert.equal(opsItems(r2)[0].since, opsItems(r)[0].since);
  // Ops works, then goes idle again: the check was done, no second wake for this version.
  assert.deepEqual(opsItems(run(view({ version: "v1.209.14", at: t + 3 * MIN, ops: { state: "working", since: t + 2 * MIN } }), d, t + 3 * MIN)), []);
  assert.deepEqual(opsItems(run(view({ version: "v1.209.14", at: t + 30 * MIN, ops: { state: "idle", since: t + 10 * MIN } }), d, t + 30 * MIN)), []);
  assert.equal(read(d, DISPATCH_STATE_FILE).live.done, true);
  // The version after it wakes Ops again.
  assert.equal(opsItems(run(view({ version: "v1.209.15", at: t + 40 * MIN, ops: { state: "idle", since: t + 10 * MIN } }), d, t + 40 * MIN)).length, 1);
});

test("Still allowed and held back: a busy Ops is woken when it goes idle; a stale or missing live reading changes nothing; a version over a day old wakes nobody", () => {
  const d = dir();
  run(view(), d, NOW);
  const t = NOW + MIN;
  // Ops busy when the version goes live: no item yet, and the turn is not spent.
  assert.deepEqual(opsItems(run(view({ version: "v1.210.0", at: t, ops: { state: "working", since: t - 5 * MIN } }), d, t)), []);
  assert.equal(read(d, DISPATCH_STATE_FILE).live.done, false);
  // Ops idle a little later: woken then.
  assert.equal(opsItems(run(view({ version: "v1.210.0", at: t + 10 * MIN, ops: { state: "idle", since: t + 5 * MIN } }), d, t + 10 * MIN)).length, 1);
  // A reading that is not live (stale, or missing) keeps what was remembered and wakes nobody.
  const d2 = dir();
  run(view(), d2, NOW);
  assert.deepEqual(opsItems(run(view({ version: "v1.211.0", live: "stale", at: t }), d2, t)), []);
  assert.equal(read(d2, DISPATCH_STATE_FILE).live.version, "1.209.13");
  // Unit: a version first seen over a day ago, never woken, is closed without a wake.
  const old = afterShip(view({ version: "v1.212.0" }), { live: { version: "1.212.0", at: NOW - AFTER_SHIP_WINDOW_MS - 1, done: false } }, { Ops: { state: "idle", since: NOW - 2 * MIN } }, NOW);
  assert.equal(old.card, null); assert.equal(old.live.done, true);
  // Ops not on the roster: no item (dispatchItems' rule), and the turn waits.
  const d3 = dir();
  dispatchRun(view(), { dir: d3, roster: ["Manager"], lead: LEAD, now: NOW });
  const r3 = dispatchRun(view({ version: "v1.213.0", at: t }), { dir: d3, roster: ["Manager"], lead: LEAD, now: t });
  assert.deepEqual(opsItems(r3), []); assert.equal(read(d3, DISPATCH_STATE_FILE).live.wokenAt, undefined);
});
