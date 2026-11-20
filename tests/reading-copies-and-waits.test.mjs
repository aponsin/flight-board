// #C1385 (Checker 2's F1 and F2 on 7a36bfca): the page copies STRIP, tileOf and tileAt from worker/reading.mjs (the page is one inlined file) and said "a test holds them equal"; this is that test,
// over every state, wait, phase, overlay and working value. And two wait rules of waitOf that nothing pinned: the turn wait at a review phase, and a land wait that needs a sign-off.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";
import { STRIP, tileOf, tileAt, waitOf, STATES, WAITS } from "../worker/reading.mjs";

test("the page's STRIP, tileOf and tileAt are the module's, on every combination", () => {
  const b = loadNames(["STRIP", "tileOf", "tileAt"]);
  assert.deepEqual([...b.STRIP], [...STRIP]);
  const phases = [...STRIP, null, "plan", "constructor"];
  let n = 0;
  for (const state of [...STATES, "waiting", undefined]) for (const wait of [...WAITS, null, undefined]) for (const overlay of [undefined, "paused", "blocked"]) for (const working of [true, false, undefined]) for (const phase of phases) {
    const r = { id: "c", state, wait, overlay, working, phase };
    assert.equal(b.tileOf(r), tileOf(r), JSON.stringify(r));
    for (const at of [...STRIP, "plan"]) assert.equal(b.tileAt(r, at), tileAt(r, at), `${JSON.stringify(r)} at ${at}`);
    n++;
  }
  assert.equal(b.tileOf(null), tileOf(null));
  assert.equal(b.tileAt(undefined, "build"), tileAt(undefined, "build"));
  assert.ok(n > 2000);
});

test("a card sent back with a session on it draws the working tile; with nobody on it, the wait tile", () => {
  const b = loadNames(["tileOf"]);
  for (const f of [tileOf, b.tileOf]) {
    assert.equal(f({ state: "rework", wait: null, working: true }), "working");
    assert.equal(f({ state: "rework", wait: null, working: false }), "wait");
  }
});

// The turn wait at a review phase: the phase's role is on another card, so the card waits for its turn (and is not "stuck", which means no wait explains it).
const NOW = 1_800_000_000_000;
const card = { id: "c1", owner_role: "Builder", repo: "" };
const at = (phase, extra = {}) => ({ lit: [phase], phase, headSha12: "aaaaaaaaaaaa", signed: [], onMain: false, ...extra });
const ask = (phase, e, agents) => waitOf({ card, e, phase, kind: "board", now: NOW, claims: [], agents, config: {}, ctx: {} });

test("a review card whose reviewer is on another card waits its turn; on this card, or idle, it has no wait", () => {
  assert.deepEqual(ask("checker", at("checker"), { Checker: { state: "working", card: "other" } }), { kind: "turn" });
  assert.equal(ask("checker", at("checker"), { Checker: { state: "working", card: "c1" } }), null, "on this very card: no turn wait");
  assert.equal(ask("checker", at("checker"), { Checker: { state: "idle" } }), null);
  assert.equal(ask("checker", at("checker"), {}), null);
  assert.deepEqual(ask("language", at("language"), { Linguist: { state: "working", card: "other" } }), { kind: "turn" });
  assert.equal(ask("build", at("build"), { Builder: { state: "working", card: "other" } }), null, "build is not a review phase: the owner's other card is not a turn wait here");
});

test("a landing wait needs a sign-off: a ship card off main waits to land when signed, and has no wait when nothing signed it", () => {
  assert.deepEqual(ask("ship", at("ship", { signed: ["checker"] }), {}), { kind: "land" });
  assert.equal(ask("ship", at("ship", { signed: [] }), {}), null);
  assert.equal(ask("ship", at("ship"), {}), null);
});
