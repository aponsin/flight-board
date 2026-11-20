// #C1267 (the owner, t-1795125576591): the step tiles show states a program sets, never a guess. Stuck is the dark tile with "slow · N× usual"
// and only when nobody is on the step; an agent working slowly keeps the blinking blue and a small "slow N×". A card that is done but not live yet
// (queued for a board release, waiting for the install) is the green and white stripes (class "waits rel"); a paused card keeps the plain ring.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, step } from "./harness.mjs";

const NOW = Date.now(), MIN = 60e3, H = 36e5, ID = "tile-card";
const reading = (agent, over = {}) => ({
  v: 1, board: { boardId: "TestBoard42xyz", at: NOW - 12e3, probe: null, pageVersion: null },
  cards: { [ID]: { num: 448, phase: "build", headSha12: "a1b2c3d4e5f6", signed: [], onMain: false, ci: "passed", ciMin: 4, liveVersion: null, at: NOW - 12e3, ...over } },
  agents: { Builder: { state: agent, lastActivityAt: NOW - 12e3, tool: "Read", card: ID, since: NOW - 5 * MIN } },
});
const base = { id: ID, num: 448, name: "Tile card", status: "active", phase: "build", size: "S", level: "Full", who: "Builder", createdAt: NOW - 9 * H, nextNote: "x", nextNoteAt: NOW };
const hist = ["d1", "d2", "d3"].map((id) => ({ id, status: "done", size: "S", doneAt: NOW - H, phaseLog: [{ phase: "build", start: NOW - 9 * H, end: NOW - 8 * H }] }));
function board(card, { probe = null, derived = {}, steps = [step(ID, "build", "Builder", "start", NOW - 2.5 * H)], done = hist } = {}) {
  const b = loadNames(["enrich", "gates", "initRow", "probeEvent", "phaseMedians", "CONFIG"]);
  b.CONFIG.collector = { notes: { language: "refs/notes/linguist", checker: "refs/notes/checker", security: "refs/notes/security" } };
  Object.assign(b.state, {
    initRaw: [card], steps, waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [], checkRequests: [],
    derived: [{ id: "all", at: NOW - 50 * MIN, cards: { [ID]: { phase: card.phase, at: NOW - 50 * MIN, ...derived } } }],
  });
  if (probe) b.probeEvent({ type: "data", result: { payload: probe } }, {});
  b.state.initiatives = [...done, b.gates(b.enrich(card))];
  b.state.phaseMed = b.phaseMedians(b.state.initiatives);
  return b.initRow(b.state.initiatives[b.state.initiatives.length - 1]);
}
const tile = (h, label) => { const m = h.match(new RegExp(`<div class="(step[^"]*)" title="(${label}[^"]*)">(.*?)</div>`)); return m && { cls: m[1], title: m[2], inner: m[3] }; };

test("slow with nobody on it is the stuck tile and says slow · N× usual", () => {
  const t = tile(board(base, { probe: reading("idle") }), "Build");
  assert.match(t.cls, /\bstuck\b/);
  assert.match(t.inner, /<small class="slow">slow<span class="sl"> ·<\/span> 2\.5×<span class="sl"> usual<\/span><\/small>/); // #C1279: the words shorten to "slow 2.5×" on a phone (CSS hides .sl)
});

test("slow with an agent working keeps the blue and says slow N×, never the stuck tile", () => {
  const t = tile(board(base, { probe: reading("working") }), "Build");
  assert.match(t.cls, /\bnow\b/);
  assert.doesNotMatch(t.cls, /\bstuck\b/, "an agent is on it: blue, not dark");
  assert.match(t.inner, /<small class="slow">slow 2\.5×<\/small>/);
});

test("not slow: no slow word", () => {
  const t = tile(board(base, { probe: reading("working"), steps: [step(ID, "build", "Builder", "start", NOW - 1.5 * H)] }), "Build");
  assert.doesNotMatch(t.inner, /class="slow"/);
});

// #C1300: red is the owner's open ask, except the install's own ask, which reads green: an open gate wait at the phase of an install wait draws no red box; any other open gate keeps it.
test("an open ask at the phase holding an install wait is green, not red; an open ask at another phase stays red", () => {
  const gate = (phase) => step(ID, phase, "Owner", "start", NOW - 20 * MIN, { wait: "gate" });
  const p = reading("idle", { phase: "ship", onMain: true });
  const boardCard = { ...base, phase: "ship", repo: "Flight-Board" };
  const install = board(boardCard, { probe: p, derived: { wait: "install", waitAsk: 77 }, steps: [step(ID, "build", "Builder", "start", NOW - 2.5 * H), gate("ship")] });
  assert.doesNotMatch(install, /class="wait gate/, "the install's ask is not a red box");
  assert.match(tile(install, "Install").cls, /\brel\b/); // #C1308: the install's wait is the Install tile's; a board card's Ship tile is called Land
  assert.doesNotMatch(tile(install, "Land").cls, /\brel\b/, "Land does not carry the green");
  const other = board({ ...base, phase: "checker", repo: "Flight-Board" }, { probe: { ...reading("idle"), cards: {} }, derived: { phase: "checker" }, steps: [step(ID, "build", "Builder", "start", NOW - 2.5 * H), gate("checker")] });
  assert.match(other, /class="wait gate/, "an ask that is not the install's is still red");
});

// #C1300 (the owner's pick A): green stripes mean one thing, the owner's install; yellow stripes are the normal process (a board release by Release, a product ship, a pack not cut yet).
test("a landed card waiting for the install is the green stripes (waits rel); a release or product wait is yellow (waits proc); a paused card is neither", () => {
  const p = reading("idle", { phase: "ship", onMain: true });
  const boardCard = { ...base, phase: "ship", repo: "Flight-Board" };
  const landedRow = board(boardCard, { probe: p, derived: { wait: "install", waitAsk: 77 } });
  const landed = tile(landedRow, "Install"); // #C1308: the green stripes sit on the Install tile, and Land stands done
  assert.match(landed.cls, /\bwaits\b/);
  assert.match(landed.cls, /\brel\b/, "only the install is green");
  assert.doesNotMatch(landed.cls, /\bproc\b/);
  assert.match(tile(landedRow, "Land").cls, /\bdone\b/, "Land is done");
  const rel = tile(board(boardCard, { probe: p, derived: { wait: "release" } }), "Land");
  assert.match(rel.cls, /\bproc\b/, "queued for a board release by Release: yellow");
  assert.doesNotMatch(rel.cls, /\brel\b/, "a release wait is no longer green");
  const product = tile(board({ ...base, phase: "ship", repo: "Platform" }, { probe: p, derived: { wait: "release" } }), "Ship");
  assert.match(product.cls, /\bproc\b/, "a product ship: yellow");
  const productInstall = tile(board({ ...base, phase: "ship", repo: "Platform" }, { probe: p, derived: { wait: "install" } }), "Ship");
  assert.doesNotMatch(productInstall.cls, /\brel\b/, "a product card is never green");
  const paused = tile(board({ ...base, status: "paused", phase: "checker" }, { probe: { ...reading("idle"), cards: {} }, steps: [], derived: { phase: "checker", wait: "release" } }), "Checker");
  assert.match(paused.cls, /\bwaits\b/);
  assert.doesNotMatch(paused.cls, /\brel\b/, "paused is not a release or install wait");
});
