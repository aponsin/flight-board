// #C1309 (the owner, t-1795149842663): "on the install tile, it'd be nice to give the install pc pack number or the version number for the product so I can corroborate".
// A board card's Pack and Install tiles name the pack that first held its landing ("pc111"; a phone shows the number alone), read from the pair folder and git by the probe
// (packOf's `pack`, carried in the card). A product card's Live tile names the version it shipped in ("v1.226.10").
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, step, readingDoc, setReadings } from "./harness.mjs";
import { stateErrors, pickState } from "../collector/state-schema.mjs";

const NOW = Date.now(), H = 36e5, ID = "board-c";
const reading = (c = {}) => ({ v: 1, board: { boardId: "TestBoard42xyz", at: NOW - 12e3, probe: null, pageVersion: null },
  cards: { [ID]: { num: 9, phase: "ship", headSha12: "a1b2c3d4e5f6", signed: ["checker", "security"], onMain: true, ci: "passed", ciMin: 4, liveVersion: null, at: NOW - 12e3, ...c } }, agents: {} });
// #C1382: the row draws the card's reading (state.readings); the probe is still read for the product card's liveVersion.
function row(cardFields, probe, rd = null, steps = [step(ID, "build", "Builder", "start", NOW - 2 * H)]) {
  const b = loadNames(["enrich", "gates", "initRow", "probeEvent", "phaseMedians", "CONFIG"]);
  const c = { id: ID, num: 9, name: "A board card", status: "active", phase: "ship", size: "S", level: "Full", who: "Builder", repo: "flight-board", createdAt: NOW - 5 * H, ...cardFields };
  Object.assign(b.state, { initRaw: [c], steps, waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [], checkRequests: [], derived: [] });
  if (probe) b.probeEvent({ type: "data", result: { payload: probe } }, {});
  if (rd) setReadings(b, readingDoc(ID, rd));
  b.state.initiatives = [b.gates(b.enrich(c))];
  b.state.phaseMed = b.phaseMedians(b.state.initiatives);
  return b.initRow(b.state.initiatives[0]);
}
const tile = (h, label) => { const m = h.match(new RegExp(`<div class="(step[^"]*)" title="(${label}[^"]*)">(.*?)</div>`)); return m && { cls: m[1], title: m[2], inner: m[3] }; };

test("a board card's Install and Pack tiles name the pack, and a phone shows the number alone", () => {
  const h = row({}, null, { phase: "install", wait: "install", with: null, pack: "pc111" });
  const t = tile(h, "Install");
  assert.equal(t.cls, "step waits rel", "the install wait is the green tile");
  assert.match(t.inner, /<small class="rs">pc111<span class="sl"> · [^<]+<\/span><\/small>/);
  assert.doesNotMatch(tile(h, "Pack").inner, /pc111/, "the Pack tile, passed, shows its time and not the number");
  assert.equal(tile(h, "Pack").cls, "step done");
  assert.doesNotMatch(tile(row({}, null, { phase: "pack", wait: "pack", pack: "pc111" }), "Pack").inner, /pc111/, "the pack wait names no number on the Pack tile");
});

test("no pack number on the reading: the owner's install words, as before", () => {
  const t = tile(row({}, null, { phase: "install", wait: "install", with: null, pack: null }), "Install");
  assert.match(t.inner, /<small class="rs">[^<]+<span class="sl">'s install<\/span><\/small>/);
  assert.doesNotMatch(t.inner, /pc\d/);
});

test("a number the page does not trust is not drawn: a number, zero, markup, a bare word, or one off the install wait", () => {
  for (const bad of [111, 0, -3, 1.5, 1e6, "111", "pc", "pc1234567", "<b>x</b>", "pc111<b>", null]) {
    const h = row({}, null, { phase: "install", wait: "install", pack: bad });
    assert.doesNotMatch(h, /pc\d|<b>x|<b>/, `pack ${JSON.stringify(bad)} is not drawn`);
  }
  assert.doesNotMatch(row({}, null, { phase: "build", wait: "turn", pack: "pc111" }), /pc111/, "a card not at the install wait names no pack");
});

test("the schema takes pack as a whole number from 1 to 999999, on a card", () => {
  const base = (c) => ({ v: 1, board: { boardId: "TestBoard42xyz", at: Date.now(), probe: null, pageVersion: null }, cards: { x: { num: 1, phase: "ship", headSha12: "a1b2c3d4e5f6", signed: [], onMain: true, ci: "none", ciMin: null, liveVersion: null, at: Date.now(), packed: true, ...c } }, agents: {} });
  assert.deepEqual(stateErrors(base({ pack: 111 })), []);
  for (const bad of [0, -1, 1.5, "111", 1e6, null]) assert.notDeepEqual(stateErrors(base({ pack: bad })), [], `card pack ${JSON.stringify(bad)}`);
  assert.equal(pickState(base({ pack: 111 })).cards.x.pack, 111);
});

// The product half: a product card's Live tile names its version.
const done = (extra) => ({ repo: "Platform", status: "done", phase: "live", doneAt: NOW - H, ...extra });
test("a done product card's Live tile names the version it shipped in; a board card's does not", () => {
  const dr = { state: "done", wait: null, with: null, phase: "live" };
  const p = row(done({ version: "1.226.10" }), null, dr);
  assert.equal(tile(p, "Live").cls, "step done");
  assert.match(tile(p, "Live").inner, /<small class="seen">v1\.226\.10<\/small>/);
  assert.match(tile(row(done({ version: "v1.226.9" }), null, dr), "Live").inner, /<small class="seen">v1\.226\.9<\/small>/, "a v in front is not doubled");
  assert.doesNotMatch(tile(row(done({ repo: "flight-board", version: "1.226.10" }), null, dr), "Live").inner, /v1\.226/, "the board's own cards name a pack, not a version");
  assert.doesNotMatch(tile(row(done({ version: "<i>x</i>" }), null, dr), "Live").inner, /<i>/, "a version that is not x.y.z is not drawn");
});

test("an open product card names a version only once it is live, never while it ships", () => {
  const live = row({ repo: "Platform", phase: "live" }, reading({ phase: "live", seen: ["build", "checker", "security", "ship", "live"], liveVersion: "1.226.10" }), { state: "done", wait: null, with: null, phase: "live" });
  assert.match(tile(live, "Live").inner, /v1\.226\.10/);
  const shipping = row({ repo: "Platform", phase: "ship" }, reading({ liveVersion: "1.226.10" }), { state: "working", wait: null, with: "Builder", working: true, phase: "ship" });
  assert.equal(tile(shipping, "Live").cls, "step", "Live is not reached");
  assert.doesNotMatch(tile(shipping, "Live").inner, /v1\.226/);
});
