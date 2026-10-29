// The page tells when its own data is behind (#C452, data-behind: the owner at 23:44Z saw "Needs you 0" and "No
// initiatives in flight" while the db held a Stripe step and #C451, the header "live · 1 min": the db's stream had gone
// quiet without its error callback, so nothing said to reload).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNames } from "./harness.mjs";
import { lastWriteAt, buildState } from "../collector/state.mjs";
import { stateErrors, pickState } from "../collector/state-schema.mjs";

const NOW = Date.now(), MIN = 60e3;
const reading = (lastWrite) => ({ v: 1, board: { boardId: "TestBoard42xyz", at: NOW - 30e3, probe: null, pageVersion: null, lastWriteAt: lastWrite }, cards: {}, agents: {} });
function board(heldAt) {
  const b = loadNames(["probeEvent", "stampText", "received", "dataBehind", "catchUp"]);
  b.received([{ id: "s1", at: heldAt }, { id: "s2", at: heldAt - 5 * MIN }], heldAt);
  return b;
}

test("the owner's 23:44Z case: the live state knows a write the page never received; the stamp turns", () => {
  const b = board(NOW - 3 * MIN);
  b.probeEvent({ type: "data", result: { payload: reading(NOW - 140e3) } }, {});
  assert.equal(b.dataBehind(NOW), true);
  assert.equal(b.stampText(NOW), "Board data behind, reloading · live 30 s · data 3 min");
});

test("caught up, or the write under 2 min old: both ages, never the live age alone", () => {
  const b = board(NOW - 3 * MIN);
  b.probeEvent({ type: "data", result: { payload: reading(NOW - 3 * MIN) } }, {});
  assert.equal(b.stampText(NOW), "live 30 s · data 3 min", "the page holds the db's last write");
  const fresh = board(NOW - 3 * MIN);
  fresh.probeEvent({ type: "data", result: { payload: reading(NOW - 60e3) } }, {});
  assert.equal(fresh.dataBehind(NOW), false, "a write a minute old may still be on its way");
  // The viewer's clock a minute behind the Studio's: the doc the page holds is the write, whenever it says it arrived.
  const skew = loadNames(["probeEvent", "received", "dataBehind"]);
  skew.received([{ id: "s3", at: NOW - 140e3 }], NOW - 200e3);
  skew.probeEvent({ type: "data", result: { payload: reading(NOW - 140e3) } }, {});
  assert.equal(skew.dataBehind(NOW), false, "the newest doc held counts, not only its arrival");
  const old = board(NOW - 3 * MIN);
  old.probeEvent({ type: "data", result: { payload: { ...reading(null), board: { ...reading(null).board, lastWriteAt: undefined } } } }, {});
  assert.equal(old.stampText(NOW), "live 30 s · data 3 min", "a probe from before lastWriteAt: nothing to compare");
});

test("behind: every collection read again first, then one reload if still behind 2 min later", () => {
  const b = board(NOW - 10 * MIN);
  b.probeEvent({ type: "data", result: { payload: reading(NOW - 140e3) } }, {});
  assert.equal(b.catchUp(NOW), "resubscribed");
  assert.equal(b.catchUp(NOW + 30e3), null, "waits for the re-read");
  assert.equal(b.catchUp(NOW + 2 * MIN), "reloaded");
  const ok = board(NOW - 10 * MIN);
  assert.equal(ok.catchUp(NOW), null, "no live state: nothing to compare");
});

test("the Collector: lastWriteAt is the gate journal's newest time, nothing else of it; the state carries it and fits", () => {
  const dir = mkdtempSync(join(tmpdir(), "data-behind-")), p = join(dir, "gate.json");
  writeFileSync(p, JSON.stringify({ journal: [{ op: "set", collection: "steps", doc_id: "a", data: { text: "x" }, at: NOW - 9 * MIN }, { op: "set", collection: "messages", doc_id: "b", data: {}, at: NOW - 2 * MIN }, { at: NOW + 9 * MIN }] }));
  assert.equal(lastWriteAt(p, NOW), NOW - 2 * MIN, "the newest, a time ahead of the clock aside");
  assert.equal(lastWriteAt(join(dir, "none.json"), NOW), null);
  writeFileSync(p, "{not json");
  assert.equal(lastWriteAt(p, NOW), null);
  const s = buildState({ id: "TestBoard42xyz", now: NOW, probe: null, pageVersion: null, cards: {}, agents: {}, lastWrite: NOW - 2 * MIN });
  assert.equal(s.board.lastWriteAt, NOW - 2 * MIN);
  const before = { v: 1, board: { boardId: "TestBoard42xyz", at: NOW, probe: null, pageVersion: null }, cards: {}, agents: {} };
  assert.equal(stateErrors(before).length, 0, "a reading from a probe before it still fits");
  assert.equal(Object.hasOwn(pickState(before).board, "lastWriteAt"), false);
  assert.ok(stateErrors({ ...before, board: { ...before.board, lastWriteAt: "soon" } }).length, "not a time: refused");
  assert.match(readFileSync(new URL("../collector/state.mjs", import.meta.url), "utf8"), /lastWrite: lastWriteAt\(join\(stateDir, id, "gate\.json"\), now\)/, "the run reads the gate's own file");
});
