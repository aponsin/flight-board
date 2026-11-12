// #C1008 (look A, the owner's pick 11-12): the board shows each group as one row (label, card count, phase strip, ETA, started), its cards
// on a rail under it, each with its own state and a Pull out button on the store page. A pulled-out card is a normal row tagged with where
// it came from, when and by whom. The group's number and name are in its batch id (Manager: "g3-probe-and-watchdog" → "G3 · Probe and watchdog").
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const NAMES = ["groupLabel", "groupShort", "groupList", "groupFacts", "groupRow", "pulledTag", "railState", "renderBoard", "initRow", "gates", "enrich", "PHASES"];
function board(initRaw, host = "store") {
  const els = {}, listeners = {}, calls = [];
  const el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", value: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }) });
  const document = { documentElement: { getAttribute: () => host }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener(t, f) { (listeners[t] ||= []).push(f); }, activeElement: null, createRange: () => ({}) };
  const fetch = async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return { ok: true }; };
  const timers = [];
  const b = loadNames(NAMES, { document, fetch, setTimeout: (f, ms) => timers.push([f, ms]) });
  Object.assign(b.state, { initRaw, initiatives: initRaw.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [] });
  return { ...b, els, listeners, calls, timers };
}
const card = (id, num, fields = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", who: "Boardsmith", createdAt: 1_800_000_000_000 + num * 60e3, ...fields });

test("a numbered batch id reads as its group: number and words; two digits too; any other id as it is", () => {
  const b = board([]);
  assert.equal(b.groupLabel("g3-probe-and-watchdog"), "G3 · Probe and watchdog");
  assert.equal(b.groupLabel("g10-small-rules"), "G10 · Small rules");
  assert.equal(b.groupLabel("g2-group-view"), "G2 · Group view");
  assert.equal(b.groupShort("g11-tests"), "G11");
  for (const odd of ["g-probe", "release-batch", "G3-Probe", "g3-", "g3_probe"]) assert.equal(b.groupLabel(odd), odd, odd);
  assert.equal(b.groupShort("g-probe"), "g-probe");
});

test("the open list keeps its order: a group sits where its first card would, with its cards in order; a card in no group stays a row", () => {
  const b = board([]);
  const list = b.groupList([card("a", 1, { batch: "g3-x" }), card("b", 2), card("c", 3, { batch: "g1-y" }), card("d", 4, { batch: "g3-x" })]);
  assert.deepEqual([...list.map((x) => x.group ?? x.card.id)], ["g3-x", "b", "g1-y"]);
  assert.deepEqual([...list[0].cards.map((c) => c.id)], ["a", "d"]);
});

test("the group row's phase is its earliest card's, its ETA the latest, its start the earliest (Manager on #C1008)", () => {
  const b = board([]);
  const P = b.PHASES.map(([k]) => k);
  const cards = [card("a", 1, { phase: P[4], etaLive: 2_000_000_000_000 }), card("b", 2, { phase: P[2], etaLive: 2_000_000_900_000 }), card("c", 3, { phase: P[5] })];
  const f = b.groupFacts(cards);
  assert.equal(f.phase, P[2]);
  assert.equal(f.eta, 2_000_000_900_000);
  assert.equal(f.started, 1_800_000_000_000 + 60e3);
  assert.deepEqual([...f.who], ["Boardsmith"]);
});

test("the board draws one group row with its cards on the rail, each with its state and Pull out; an ungrouped card stays a normal row", () => {
  const skip = ["test", "security"];
  const b = board([card("one", 977, { batch: "g3-board-look-fixes", phase: "checker", skip }), card("two", 983, { batch: "g3-board-look-fixes", skip }), card("solo", 981)]);
  b.renderBoard();
  const h = b.els.board.innerHTML;
  assert.equal((h.match(/class="i-row g-row"/g) || []).length, 1);
  assert.match(h, /G3 · Board look fixes/);
  assert.match(h, /2 cards/);
  assert.match(h, /class="g-rail"/);
  assert.match(h, /#C977<\/span><strong>Card 977<\/strong><span class="state done">Built/);
  assert.equal((h.match(/data-pull="(one|two)"/g) || []).length, 2, "a Pull out per grouped card");
  assert.doesNotMatch(h, /data-pull="solo"/);
  assert.match(h, /Card 981/);
  const gr = h.slice(h.indexOf('g-row'), h.indexOf('g-rail'));
  assert.doesNotMatch(gr, /title="Test"/i, "Test, when every card skips it, is not on the group strip");
  assert.match(gr, /title="Security">Security<small>not needed/, "another skipped phase says not needed");
});

const button = (id, num) => {
  const cls = new Set();
  const btn = { dataset: { pull: id, num: String(num) }, disabled: false, textContent: "Pull out", classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), has: (c) => cls.has(c) }, closest: (s) => (s === "[data-pull]" ? btn : null) };
  return btn;
};
const tap = async (b, btn) => { for (const f of b.listeners.click) await f({ target: btn }); };

test("Pull out is the store page's only; the first tap asks, only the second posts {id} to the store's route (Designer F1)", async () => {
  const off = board([card("one", 1, { batch: "g2-group-view" })], "artifact");
  off.renderBoard();
  assert.doesNotMatch(off.els.board.innerHTML, /data-pull=/, "no button where there is no store to write to");
  const b = board([card("one", 977, { batch: "g2-group-view" })]);
  b.renderBoard();
  assert.match(b.els.board.innerHTML, /data-pull="one" data-num="977">Pull out</);
  const btn = button("one", 977);
  await tap(b, btn);
  assert.deepEqual(b.calls, [], "one tap posts nothing");
  assert.equal(btn.textContent, "Pull #C977 out? Yes");
  assert.ok(btn.classList.has("armed"));
  await tap(b, btn);
  assert.deepEqual(b.calls, [["/api/pull-out", { id: "one" }]]);
  assert.equal(btn.textContent, "Pulled out");
});

test("an unanswered ask goes back to Pull out after its 4 s, and the next tap asks again", async () => {
  const b = board([card("one", 977, { batch: "g2-group-view" })]);
  const btn = button("one", 977);
  await tap(b, btn);
  const [f, ms] = b.timers.at(-1);
  assert.equal(ms, 4000);
  f();
  assert.equal(btn.textContent, "Pull out");
  assert.equal(btn.classList.has("armed"), false);
  await tap(b, btn);
  assert.deepEqual(b.calls, [], "after the ask lapsed, a tap asks again and posts nothing");
});

test("an issue chip at exactly one is singular (Designer on #C1008): 1 design fix, 1 bug, 2 design fixes", () => {
  const b = board([card("one", 977, { batch: "g2-group-view", issues: { design: 1, bugs: 1, security: 2, owner: 1, language: 1 } })]);
  b.renderBoard();
  const h = b.els.board.innerHTML;
  for (const w of ["1 design fix<", "1 bug<", "2 security fixes<", "1 owner change<", "1 wording fix<"]) assert.ok(h.includes(w), w);
  assert.equal(h.includes("1 design fixes"), false);
});

test("a pulled-out card's row says where it came from, when and by whom; a card put back in a group, or never pulled, says nothing", () => {
  const at = new Date(2026, 10, 12, 10, 5).getTime();
  const b = board([card("urgent", 981, { pulledFrom: "g3-board-look-fixes", pulledBy: "owner", pulledAt: at })]);
  const tag = b.pulledTag(b.state.initiatives[0]);
  assert.match(tag, /↰ pulled out of G3 · .*10:05.* by /);
  assert.doesNotMatch(tag, /by owner/, "the owner shows by name");
  assert.match(b.initRow(b.state.initiatives[0]), /pulled out of G3/);
  assert.equal(b.pulledTag({ ...b.state.initiatives[0], batch: "g4-review-lanes" }), "", "back in a group");
  assert.equal(b.pulledTag(card("x", 1)), "");
  assert.equal(b.pulledTag({ pulledFrom: "<b>x</b>" }).includes("<b>"), false, "escaped");
});
