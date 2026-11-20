// #C1267 (the owner, t-1795125576591): the step tiles show states a program sets, never a guess. Stuck is the dark tile with "slow · N× usual"
// and only when nobody is on the step; an agent working slowly keeps the blinking blue and a small "slow N×". A card that is done but not live yet
// (queued for a board release, waiting for the install) is the green and white stripes (class "waits rel"); a paused card keeps the plain ring.
// #C1382: each case is the card's reading (state.readings): stuck = the dark tile, working = the blue, wait install = green, other waits = yellow, wait ask = red and white stripes.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, step, readingDoc, setReadings } from "./harness.mjs";

const NOW = Date.now(), MIN = 60e3, H = 36e5, ID = "tile-card";
const base = { id: ID, num: 448, name: "Tile card", status: "active", phase: "build", size: "S", level: "Full", who: "Builder", createdAt: NOW - 9 * H, nextNote: "x", nextNoteAt: NOW };
const hist = ["d1", "d2", "d3"].map((id) => ({ id, status: "done", size: "S", doneAt: NOW - H, phaseLog: [{ phase: "build", start: NOW - 9 * H, end: NOW - 8 * H }] }));
// `reading` is laid over a build-phase waiting reading; null serves none.
function board(card, { reading = {}, steps = [step(ID, "build", "Builder", "start", NOW - 2.5 * H)], done = hist } = {}) {
  const b = loadNames(["enrich", "gates", "initRow", "phaseMedians", "CONFIG"]);
  b.CONFIG.collector = { notes: { language: "refs/notes/linguist", checker: "refs/notes/checker", security: "refs/notes/security" } };
  Object.assign(b.state, { initRaw: [card], steps, waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [], checkRequests: [], derived: [] });
  if (reading) setReadings(b, readingDoc(ID, { phase: card.phase, ...reading }));
  b.state.initiatives = [...done, b.gates(b.enrich(card))];
  b.state.phaseMed = b.phaseMedians(b.state.initiatives);
  return b.initRow(b.state.initiatives[b.state.initiatives.length - 1]);
}
const tile = (h, label) => { const m = h.match(new RegExp(`<div class="(step[^"]*)" title="(${label}[^"]*)">(.*?)</div>`)); return m && { cls: m[1], title: m[2], inner: m[3] }; };

test("slow with nobody on it (the reading is stuck) is the stuck tile and says slow · N× usual", () => {
  const t = tile(board(base, { reading: { state: "stuck", wait: null, working: false } }), "Build");
  assert.match(t.cls, /^step now stuck$/);
  assert.match(t.inner, /<small class="slow">slow<span class="sl"> ·<\/span> 2\.5×<span class="sl"> usual<\/span><\/small>/); // #C1279: the words shorten to "slow 2.5×" on a phone (CSS hides .sl)
});

test("slow with an agent working (the reading is working) keeps the blue and says slow N×, never the stuck tile", () => {
  const t = tile(board(base, { reading: { state: "working", wait: null, working: true } }), "Build");
  assert.match(t.cls, /^step now$/);
  assert.doesNotMatch(t.cls, /\bstuck\b/, "an agent is on it: blue, not dark");
  assert.match(t.inner, /<small class="slow">slow 2\.5×<\/small>/);
});

test("not slow: no slow word", () => {
  const t = tile(board(base, { reading: { state: "working", wait: null, working: true }, steps: [step(ID, "build", "Builder", "start", NOW - 1.5 * H)] }), "Build");
  assert.doesNotMatch(t.inner, /class="slow"/);
});

// #C1300: red is the owner's open ask, except the install's own ask, which reads green. #C1382: the open ask is a tile (red and white stripes, "waits ask"), never the red box before it;
// the install wait is the Install tile's green.
test("a card waiting on the install is green on the Install tile, with no red box; an open ask is the red-striped tile", () => {
  const install = board({ ...base, phase: "ship", repo: "Flight-Board" }, { reading: { phase: "install", state: "waiting", wait: "install", with: "Owner" } });
  assert.doesNotMatch(install, /class="wait gate/, "the install's ask is not a red box");
  assert.match(tile(install, "Install").cls, /^step waits rel$/); // #C1308: the install's wait is the Install tile's; a board card's Ship tile is called Land
  assert.doesNotMatch(tile(install, "Land").cls, /\brel\b/, "Land does not carry the green");
  const other = board({ ...base, phase: "checker", repo: "Flight-Board" }, { reading: { phase: "checker", state: "waiting", wait: "ask", with: "Owner", ask: 77 } });
  assert.match(tile(other, "Checker").cls, /^step waits ask$/, "an ask that is not the install's is the red-striped tile");
  assert.match(tile(other, "Checker").inner, /Asked #T77/);
  assert.doesNotMatch(other, /class="wait gate/, "and no red box before it");
});

// #C1300 (the owner's pick A): green stripes mean one thing, the owner's install; yellow stripes are the normal process (a board release by Release, a product ship, a pack not cut yet).
test("a landed card waiting for the install is the green stripes (waits rel); a release or product wait is yellow (waits proc); a paused card is neither", () => {
  const boardCard = { ...base, phase: "ship", repo: "Flight-Board" };
  const landedRow = board(boardCard, { reading: { phase: "install", state: "waiting", wait: "install", with: "Owner" } });
  const landed = tile(landedRow, "Install"); // #C1308: the green stripes sit on the Install tile, and Land stands done
  assert.match(landed.cls, /\bwaits\b/);
  assert.match(landed.cls, /\brel\b/, "only the install is green");
  assert.doesNotMatch(landed.cls, /\bproc\b/);
  assert.match(tile(landedRow, "Land").cls, /\bdone\b/, "Land is done");
  const rel = tile(board(boardCard, { reading: { phase: "ship", state: "waiting", wait: "land", with: "Release" } }), "Land");
  assert.match(rel.cls, /\bproc\b/, "queued to land by Release: yellow");
  assert.doesNotMatch(rel.cls, /\brel\b/, "a release wait is no longer green");
  const product = tile(board({ ...base, phase: "ship", repo: "Platform" }, { reading: { phase: "ship", state: "waiting", wait: "deploy", with: "Release" } }), "Ship");
  assert.match(product.cls, /\bproc\b/, "a product ship: yellow");
  assert.doesNotMatch(product.cls, /\brel\b/, "a product card is never green");
  const paused = tile(board({ ...base, status: "paused", phase: "checker" }, { reading: { phase: "checker", state: "waiting", wait: "turn", with: "Checker" }, steps: [] }), "Checker");
  assert.match(paused.cls, /^step here$/, "a paused card keeps the plain ring");
  assert.doesNotMatch(paused.cls, /\b(rel|proc|waits)\b/, "paused is not a release or install wait");
});
