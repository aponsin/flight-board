// #C1309 (the owner, t-1795149842663): "on the install tile, it'd be nice to give the install pc pack number or the version number for the product so I can corroborate".
// A board card's Pack and Install tiles name the pack that first held its landing ("pc111"; a phone shows the number alone), read from the pair folder and git by the probe
// (packOf's `pack`, carried in the card and in closedPacks). A product card's Live tile names the version it shipped in ("v1.226.10").
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, step } from "./harness.mjs";
import { stateErrors, pickState } from "../collector/state-schema.mjs";

const NOW = Date.now(), H = 36e5, ID = "board-c";
const reading = (c = {}) => ({ v: 1, board: { boardId: "TestBoard42xyz", at: NOW - 12e3, probe: null, pageVersion: null },
  cards: { [ID]: { num: 9, phase: "ship", headSha12: "a1b2c3d4e5f6", signed: ["checker", "security"], onMain: true, ci: "passed", ciMin: 4, liveVersion: null, at: NOW - 12e3, ...c } }, agents: {} });
function row(cardFields, probe, steps = [step(ID, "build", "Builder", "start", NOW - 2 * H)]) {
  const b = loadNames(["enrich", "gates", "initRow", "probeEvent", "phaseMedians", "CONFIG"]);
  const c = { id: ID, num: 9, name: "A board card", status: "active", phase: "ship", size: "S", level: "Full", who: "Builder", repo: "flight-board", createdAt: NOW - 5 * H, ...cardFields };
  Object.assign(b.state, { initRaw: [c], steps, waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [], checkRequests: [], derived: [] });
  if (probe) b.probeEvent({ type: "data", result: { payload: probe } }, {});
  b.state.initiatives = [b.gates(b.enrich(c))];
  b.state.phaseMed = b.phaseMedians(b.state.initiatives);
  return b.initRow(b.state.initiatives[0]);
}
const tile = (h, label) => { const m = h.match(new RegExp(`<div class="(step[^"]*)" title="(${label}[^"]*)">(.*?)</div>`)); return m && { cls: m[1], title: m[2], inner: m[3] }; };

test("a board card's Install and Pack tiles name the pack, and a phone shows the number alone", () => {
  const h = row({}, reading({ packed: true, installed: true, pack: 111 }));
  assert.match(tile(h, "Install").inner, /<small class="seen rs">pc111<span class="sl"> installed<\/span><\/small>/);
  assert.match(tile(h, "Pack").inner, /<small class="seen rs">pc111<span class="sl"> pair built<\/span><\/small>/);
});

test("no pack number read: the old words, as before", () => {
  const h = row({}, reading({ packed: true, installed: true }));
  assert.match(tile(h, "Install").inner, /<small class="seen">installed<\/small>/);
  assert.match(tile(h, "Pack").inner, /<small class="seen">pair built<\/small>/);
});

test("a number the page does not trust is not drawn: a word, zero, a fraction, a huge one, markup, or one on a card not on main", () => {
  for (const bad of ["111", 0, -3, 1.5, 1e6, "<b>x</b>", null]) {
    const h = row({}, reading({ packed: true, installed: true, pack: bad }));
    assert.doesNotMatch(h, /pc\d|<b>x/, `pack ${JSON.stringify(bad)} is not drawn`);
  }
  assert.doesNotMatch(row({}, reading({ onMain: false, packed: true, installed: true, pack: 111 })), /pc111/, "a card not on main names no pack");
});

test("the schema takes pack as a whole number from 1 to 999999, on a card and in closedPacks", () => {
  const base = (c) => ({ v: 1, board: { boardId: "TestBoard42xyz", at: Date.now(), probe: null, pageVersion: null }, cards: { x: { num: 1, phase: "ship", headSha12: "a1b2c3d4e5f6", signed: [], onMain: true, ci: "none", ciMin: null, liveVersion: null, at: Date.now(), packed: true, ...c } }, agents: {} });
  assert.deepEqual(stateErrors(base({ pack: 111 })), []);
  for (const bad of [0, -1, 1.5, "111", 1e6, null]) assert.notDeepEqual(stateErrors(base({ pack: bad })), [], `card pack ${JSON.stringify(bad)}`);
  const withClosed = (p) => ({ ...base({}), closedPacks: { "c-one": p } });
  assert.deepEqual(stateErrors(withClosed({ packed: true, installed: true, pack: 40 })), []);
  for (const bad of [0, "40", 1e6, 2.5]) assert.notDeepEqual(stateErrors(withClosed({ packed: true, pack: bad })), [], `closed pack ${JSON.stringify(bad)}`);
  assert.deepEqual(pickState(withClosed({ packed: true, installed: true, pack: 40 })).closedPacks, { "c-one": { packed: true, installed: true, pack: 40 } }, "the number survives the state writer's filter");
  assert.equal(pickState(base({ pack: 111 })).cards.x.pack, 111);
});

// The product half: a product card's Live tile names its version.
const done = (extra) => ({ repo: "Platform", status: "done", phase: "live", doneAt: NOW - H, ...extra });
test("a done product card's Live tile names the version it shipped in; a board card's does not", () => {
  const p = row(done({ version: "1.226.10" }), null);
  assert.match(tile(p, "Live").inner, /<small class="seen">v1\.226\.10<\/small>/);
  assert.match(tile(row(done({ version: "v1.226.9" }), null), "Live").inner, /<small class="seen">v1\.226\.9<\/small>/, "a v in front is not doubled");
  assert.doesNotMatch(tile(row(done({ repo: "flight-board", version: "1.226.10" }), null), "Live").inner, /v1\.226/, "the board's own cards name a pack, not a version");
  assert.doesNotMatch(tile(row(done({ version: "<i>x</i>" }), null), "Live").inner, /<i>/, "a version that is not x.y.z is not drawn");
});

test("an open product card names a version only once it is live, never while it ships", () => {
  const live = row({ repo: "Platform", phase: "live" }, reading({ phase: "live", seen: ["build", "checker", "security", "ship", "live"], liveVersion: "1.226.10" }));
  assert.match(tile(live, "Live").inner, /v1\.226\.10/);
  const shipping = row({ repo: "Platform", phase: "ship" }, reading({ liveVersion: "1.226.10" }));
  assert.doesNotMatch(tile(shipping, "Live").inner, /v1\.226/);
});
