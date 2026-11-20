// #C1050 (the owner, 11-12, after pc53: "why is every initiative blinking on build?"): a group row's step pulses only while a member is worked (an
// agent on it now); a group of queued or paused cards, or built ones nobody is on, stands still. A group whose cards have all
// landed shows Land done and stands, still, at Pack (then Install), as a single landed card does.
// #C1382: each member's tile is drawn from its reading (the Worker's), and the group draws the member tiles' first state in TILE_ORDER; so each card here is given a reading.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, readingDoc, setReadings } from "./harness.mjs";

const NAMES = ["groupRow", "gates", "enrich", "state"];
// `readings` maps a card id to the reading's own fields.
function board(initRaw, readings = {}) {
  const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(NAMES, { document });
  Object.assign(b.state, { initRaw, initiatives: initRaw.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [] });
  setReadings(b, ...Object.entries(readings).map(([id, over]) => readingDoc(id, over)));
  return { b, row: () => b.groupRow("g5-thing", b.state.initiatives) };
}
const card = (id, num, fields = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", who: "Boardsmith", repo: "flight-board", batch: "g5-thing", createdAt: 1_800_000_000_000 + num * 60e3, ...fields });
// The readings a member can have here.
const queued = { phase: "build", state: "queued", wait: null, with: "Boardsmith" };
const builtWaiting = { phase: "build", state: "waiting", wait: "turn", with: "Boardsmith", working: false };
const onIt = { phase: "build", state: "working", wait: null, with: "Boardsmith", working: true };
const packWait = { phase: "pack", state: "waiting", wait: "pack", with: null };
const installWait = { phase: "install", state: "waiting", wait: "install", with: null, pack: "pc115" };
const live = { phase: "live", state: "done", wait: null, with: null };
// The group row's own track only: the rail under it holds each card's own row with its own steps.
const steps = (html) => [...html.split('<div class="g-rail">')[0].matchAll(/<div class="(step[^"]*)" title="([^":]+)/g)].map((m) => [m[2], m[1]]);
const cls = (html, label) => steps(html).find(([l]) => l === label)?.[1];

test("a group of queued and paused cards, and a built one nobody is on, does not pulse: its step stands still", () => {
  const { row } = board([card("built", 1, { branch: "build/built" }), card("q1", 2), card("q2", 3), card("p", 4, { status: "paused", branch: "build/p" })], { built: builtWaiting, q1: queued, q2: queued, p: onIt });
  // #C1343: the group's tile is made from its cards' tiles; the built card's yellow wait outranks the paused ring and the queued tiles (TILE_ORDER), and a yellow wait never pulses.
  assert.equal(cls(row(), "Build"), "step waits proc");
  assert.ok(!steps(row()).some(([, c]) => /\bnow\b/.test(c) && !c.includes("queued")), "no tile of the group pulses");
});

// #C1102 (11-16: G6 read "building" while neither open card had a branch or a step): a group whose cards are all untouched has no tile lit and its Build tile says queued;
// one card the Worker has started (waiting for its turn) makes it read as started again.
test("#C1102: a group whose cards are all untouched reads queued, nothing lit; one card that is started lights Build", () => {
  const { row } = board([card("q1", 1), card("q2", 2)], { q1: queued, q2: queued });
  const html = row();
  assert.equal(cls(html, "Build"), "step now queued", "#C1343: the card's own queued tile (yellow stripes, still), not a plain one");
  assert.ok(!steps(html).some(([, c]) => c.includes("here") || (/\bnow\b/.test(c) && !c.includes("queued"))), "no ring, no pulse");
  assert.match(html.split('<div class="g-rail">')[0], /Build<small>queued<\/small>/);
  const started = board([card("q1", 1), card("b", 2, { branch: "build/b" })], { q1: queued, b: builtWaiting }).row();
  assert.equal(cls(started, "Build"), "step waits proc", "a started card: the group is no longer queued");
  assert.doesNotMatch(started.split('<div class="g-rail">')[0], /queued/);
});

test("one member with an agent on it now makes the group's step pulse", () => {
  const { row } = board([card("built", 1, { branch: "build/built" }), card("q1", 2)], { built: onIt, q1: queued });
  assert.equal(cls(row(), "Build"), "step now");
  // A paused card is not worked, whoever the reading says is on it: the card draws its still ring.
  const pausedOn = board([card("p", 4, { status: "paused", branch: "build/p" }), card("q1", 2)], { p: onIt, q1: queued });
  assert.equal(cls(pausedOn.row(), "Build"), "step here");
});

test("every card landed: Land is done and the group stands still at Pack; once the pair holds them, at Install", () => {
  const ids = ["a", "b"], raw = ids.map((id, k) => card(id, k + 1, { phase: "ship", branch: `build/${id}` }));
  const both = (r) => Object.fromEntries(ids.map((id) => [id, r]));
  const one = board(raw, both(packWait)).row();
  assert.equal(cls(one, "Land"), "step done", "every card is landed: Land stands done");
  assert.equal(cls(one, "Pack"), "step waits proc", "and Queued for pack is the cards' own yellow tile on Pack");
  assert.equal(cls(one, "Install"), "step unlit");
  const packed = board(raw, both(installWait)).row();
  assert.equal(cls(packed, "Pack"), "step done");
  assert.equal(cls(packed, "Install"), "step waits rel", "#C1343: a board group waiting on the owner's install wears the card's green-stripe tile, still, not pulsing");
});

test("#C1051: a member already read live counts as past Land; with a landed member beside it the group stands at Pack, all live at Live", () => {
  const raw = [card("a", 1, { phase: "ship", branch: "build/a" }), card("b", 2, { phase: "live", branch: "build/b" })];
  const mixed = board(raw, { a: packWait, b: live }).row();
  assert.equal(cls(mixed, "Land"), "step done", "both are past Land");
  assert.equal(cls(mixed, "Pack"), "step waits proc", "one card is Queued for pack, one is past it: the yellow wait comes first");
  assert.equal(cls(mixed, "Install"), "step unlit", "one card has no pack yet");
  const allLive = board(raw.map((c) => ({ ...c, phase: "live" })), { a: live, b: live }).row();
  assert.equal(cls(allLive, "Land"), "step done");
  assert.equal(cls(allLive, "Pack"), "step done");
  assert.equal(cls(allLive, "Install"), "step done");
  assert.equal(cls(allLive, "Live"), "step done", "a card the reading calls done: every tile stands done");
});

// #C1102 (d) (the owner, 11-16 ~1:35 pm:#C1093 and #C1100 showed in build though they were built and held until g13's turn): a card held for its group reads waiting, and a group with only such
// cards is not being built: no tile pulses. A card the reading says is worked reads as building again.
test("#C1102 (d): a built card held for its group reads waiting for the group, and its group does not pulse; when worked it reads Building and pulses", () => {
  const raw = [card("held", 1, { branch: "build/held" })];
  const held = { phase: "build", state: "waiting", wait: "group", with: null, working: false };
  const waiting = board(raw, { held }).row();
  assert.match(waiting, /<span class="state queued">Waits for group<\/span>/);
  assert.equal(cls(waiting, "Build"), "step waits proc", "stands still: nothing in the group is being built");
  const wip = board(raw, { held: onIt }).row();
  assert.match(wip, /<span class="state active">Building<\/span>/);
  assert.equal(cls(wip, "Build"), "step now");
  const mixed = board([...raw, card("other", 2, { branch: "build/other" })], { held, other: onIt }).row();
  assert.equal(cls(mixed, "Build"), "step now", "one card still being built: the group pulses");
  assert.equal([...mixed.matchAll(/Waits for group/g)].length, 1, "only the waiting card says so");
});

test("a group with one card still unlanded is not landed: it stays at Land, and Pack is unlit", () => {
  const raw = [card("a", 1, { phase: "ship", branch: "build/a" }), card("b", 2, { phase: "ship", branch: "build/b" })];
  const html = board(raw, { a: packWait, b: { phase: "ship", state: "waiting", wait: "land", with: null } }).row();
  assert.equal(cls(html, "Land"), "step waits proc", "the unlanded card's own Queued to land wait comes first");
  assert.equal(cls(html, "Pack"), "step unlit", "a card that has not got to Pack comes before one waiting on it");
});
