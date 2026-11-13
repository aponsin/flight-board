// #C1050 (the owner, 11-12, after pc53: "why is every initiative blinking on build?"): a group row's step pulses only while a member is worked (an
// agent on it now); a group of queued or paused cards, or built ones nobody is on, stands still with the "here" ring. A group whose cards have all
// landed shows Land done and stands, still, at Pack (then Install), as a single landed card does.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const NAMES = ["groupRow", "gates", "enrich", "probeEvent", "state"];
function board(initRaw, { cards = {}, agents = {} } = {}) {
  const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(NAMES, { document });
  Object.assign(b.state, { initRaw, initiatives: initRaw.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [] });
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 20e3 }, cards, agents } } }, {});
  return { b, row: () => b.groupRow("g5-thing", b.state.initiatives) };
}
const card = (id, num, fields = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", who: "Boardsmith", repo: "flight-board", batch: "g5-thing", createdAt: 1_800_000_000_000 + num * 60e3, ...fields });
const working = (id) => ({ state: "working", card: id, lastActivityAt: Date.now(), since: Date.now() - 60e3 });
const idle = { state: "idle", lastActivityAt: Date.now() - 600e3, since: Date.now() - 600e3 };
// The group row's own track only: the rail under it holds each card's own row with its own steps.
const steps = (html) => [...html.split('<div class="g-rail">')[0].matchAll(/<div class="(step[^"]*)" title="([^":]+)/g)].map((m) => [m[2], m[1]]);
const cls = (html, label) => steps(html).find(([l]) => l === label)?.[1];

test("a group of queued and paused cards, and a built one nobody is on, does not pulse: its step stands still", () => {
  const { row } = board([card("built", 1, { branch: "build/built" }), card("q1", 2), card("q2", 3), card("p", 4, { status: "paused", branch: "build/p" })], { agents: { Boardsmith: idle } });
  assert.equal(cls(row(), "Build"), "step here");
  assert.ok(!steps(row()).some(([, c]) => c.includes("now")), "no tile of the group pulses");
});

test("one member with an agent on it now makes the group's step pulse", () => {
  const { row } = board([card("built", 1, { branch: "build/built" }), card("q1", 2)], { agents: { Boardsmith: working("built") } });
  assert.equal(cls(row(), "Build"), "step now");
  const pausedOn = board([card("p", 4, { status: "paused", branch: "build/p" }), card("q1", 2)], { agents: { Boardsmith: working("p") } });
  assert.equal(cls(pausedOn.row(), "Build"), "step here", "a paused card is not worked, whoever is on it");
});

test("every card landed: Land is done and the group stands still at Pack; once the pair holds them, at Install", () => {
  const ids = ["a", "b"], raw = ids.map((id, k) => card(id, k + 1, { phase: "ship", branch: `build/${id}` }));
  const landed = (more = {}) => Object.fromEntries(ids.map((id) => [id, { phase: "ship", headSha12: "4079cdbd8c9e", onMain: true, seen: ["build", "checker", "ship"], ...more }]));
  const one = board(raw, { cards: landed(), agents: { Release: idle } }).row();
  assert.equal(cls(one, "Land"), "step done");
  assert.equal(cls(one, "Pack"), "step here");
  assert.equal(cls(one, "Install"), "step unlit");
  const packed = board(raw, { cards: landed({ packed: true }), agents: { Release: idle } }).row();
  assert.equal(cls(packed, "Pack"), "step done seen");
  assert.equal(cls(packed, "Install"), "step here");
});

test("#C1051: a member already read live counts as past Land; with a landed member beside it the group stands at Pack, all live at Live", () => {
  const raw = [card("a", 1, { phase: "ship", branch: "build/a" }), card("b", 2, { phase: "live", branch: "build/b" })];
  const read = (aPhase) => ({ a: { phase: aPhase, headSha12: "4079cdbd8c9e", onMain: true, seen: aPhase === "live" ? ["ship", "live"] : ["ship"] }, b: { phase: "live", headSha12: "9fb55ad574ac", onMain: true, seen: ["ship", "live"] } });
  const mixed = board(raw, { cards: read("ship"), agents: { Release: idle } }).row();
  assert.equal(cls(mixed, "Land"), "step done");
  assert.equal(cls(mixed, "Pack"), "step here");
  const allLive = board(raw.map((c) => ({ ...c, phase: "live" })), { cards: read("live"), agents: { Release: idle } }).row();
  assert.equal(cls(allLive, "Land"), "step done");
  assert.equal(cls(allLive, "Pack"), "step done seen");
  assert.equal(cls(allLive, "Install"), "step done seen");
  assert.equal(cls(allLive, "Live"), "step here");
});

test("a group with one card still unlanded is not landed: it stays at Land, and Pack is unlit", () => {
  const raw = [card("a", 1, { phase: "ship", branch: "build/a" }), card("b", 2, { phase: "ship", branch: "build/b" })];
  const html = board(raw, { cards: { a: { phase: "ship", headSha12: "4079cdbd8c9e", onMain: true, seen: ["ship"] }, b: { phase: "ship", headSha12: "522a8532aaaa", onMain: false, seen: ["ship"] } }, agents: { Release: idle } }).row();
  assert.equal(cls(html, "Land"), "step here");
  assert.equal(cls(html, "Pack"), "step unlit");
});
