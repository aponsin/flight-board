// #C1068 (the owner, 11-12: "let's build that"): a review lane is woken for a group's READY cards, once, with the whole range; and cards reviewed together pulse in unison,
// at card and group level, with a "together" label, while a card reviewed alone pulses by itself.
// (The card said it builds after #C1061; no such card or commit exists on the board or on main, so by Manager's word on 11-17 that dependency is dropped.)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun } from "../collector/store-dispatch.mjs";
import { dispatchItems, dispatchLine } from "../gate/reset.mjs";
import { loadNames, readingDoc, setReadings } from "./harness.mjs";

const NOW = 1_800_000_000_000, MIN = 60_000;
const ROSTER = ["Manager", "Boardsmith", "Checker", "Security", "Release"], LEAD = "Manager";
const idle = { state: "idle", lastActivityAt: NOW - 20 * MIN, since: NOW - 20 * MIN };
const busy = { state: "working", lastActivityAt: NOW - MIN, since: NOW - 30 * MIN };
const card = (id, num, extra = {}) => ({ id, num, owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", batch: "g14-x", ...extra });
const pushed = (sha, extra = {}) => ({ readAt: NOW - 5_000, value: { lit: ["checker"], phase: "checker", headSha12: sha.repeat(12).slice(0, 12), signed: [], onMain: false, ...extra } });
const world = ({ cards, ev = {}, agents = {} }) => ({
  cards, asks: [], threads: { messages: [], threads: [] }, stackSwitch: [{ repo: "board", stack: false, set_by: "default", set_at: 0 }],
  evidence: { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, agents[r] ?? idle])) }, ...Object.fromEntries(Object.entries(ev).map(([id, v]) => [`cards.${id}`, v])) },
});
const run = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "tog-")), roster: ROSTER, lead: LEAD, now: NOW });
const reviews = (v, role) => run(v).items.filter((i) => i.role === role && i.step === "review");

const three = () => world({ cards: [card("a", 1101), card("b", 1102), card("c", 1103)], ev: { a: pushed("a"), b: pushed("b"), c: pushed("c") } });

test("a free lane with three READY cards of one group is woken once, for the first, with the other two as one range", () => {
  const got = reviews(three(), "Checker");
  assert.equal(got.length, 1, "one wake, not one per card");
  assert.equal(got[0].num, 1101, "the first card in the queue's order");
  assert.deepEqual(got[0].together, [{ num: 1102, sha: "bbbbbbbbbbbb" }, { num: 1103, sha: "cccccccccccc" }]);
  assert.equal(got[0].group, "g14-x");
  const line = dispatchLine(got[0]);
  assert.match(line, /; review together with #C1102 \(bbbbbbbbbbbb\), #C1103 \(cccccccccccc\) of group g14-x as one range/);
  assert.match(line, /your queue: #C1101, #C1102, #C1103/, "the queue line is as before");
});

test("a lane that was busy is woken once with every READY card when it frees up; a card READY later joins the range", () => {
  const v = three();
  v.evidence.agents.value.Checker = busy;
  assert.deepEqual(reviews(v, "Checker"), [], "a busy lane is not woken, and nothing is queued for it");
  v.evidence.agents.value.Checker = idle;
  assert.equal(reviews(v, "Checker").length, 1);
  assert.equal(reviews(v, "Checker")[0].together.length, 2);
});

test("a lone READY card, or cards of different groups, are woken one by one, as before", () => {
  const alone = world({ cards: [card("a", 1101)], ev: { a: pushed("a") } });
  const one = reviews(alone, "Checker");
  assert.equal(one.length, 1);
  assert.equal(one[0].together, undefined);
  assert.doesNotMatch(dispatchLine(one[0]), /together/);
  const split = world({ cards: [card("a", 1101), card("b", 1102, { batch: "g15-y" })], ev: { a: pushed("a"), b: pushed("b") } });
  const got = reviews(split, "Checker");
  assert.equal(got.length, 2, "each card keeps its own review turn (the queue line names both)");
  assert.ok(got.every((i) => i.together === undefined), "cards of two groups are not one range");
});

test("a signed card, or one with no tip yet, is not in the range; Security's own turn is not touched", () => {
  const v = world({ cards: [card("a", 1101, { review_level: "Full" }), card("b", 1102, { review_level: "Full" }), card("c", 1103)], ev: { a: pushed("a"), b: pushed("b", { signed: ["checker"] }), c: { readAt: NOW - 5_000, value: { lit: ["checker"], phase: "checker", signed: [], onMain: false } } } });
  const checker = reviews(v, "Checker");
  assert.deepEqual(checker.map((i) => i.num).sort(), [1101, 1103], "a and c keep their own turns; b is signed by Checker");
  assert.ok(checker.every((i) => i.together === undefined), "b is signed by Checker, c has no tip: nothing to read together with a");
  const security = reviews(v, "Security");
  assert.equal(security.length, 1, "Security still has its turn");
  assert.deepEqual(security[0].together?.map((x) => x.num), [1102], "a and b are both Full cards waiting for Security: one range for it");
});

// Checker 2's LOW on 04b8dfcc: a card the dispatch will drop for this lane (an open ask on it, or a waiting_on that names someone else) must not lead the range: dispatchItems would drop
// its turn and the group's other cards, which lost theirs to the fold, would get no wake at all.
test("a card with an open ask does not lead the range: the next card does, and the group still gets its one wake", () => {
  const v = three();
  v.asks = [{ card_id: "a", closed_at: null, answered_at: null }];
  const got = reviews(v, "Checker");
  assert.equal(got.length, 1, "the lane is woken once");
  assert.equal(got[0].num, 1102, "b leads: a waits for the owner and is dropped");
  assert.deepEqual(got[0].together, [{ num: 1103, sha: "cccccccccccc" }], "a is not in the range either");
});

test("a card waiting on another role does not lead the range: the next card does", () => {
  const v = world({ cards: [card("a", 1101, { waiting_on: "Release: lands first" }), card("b", 1102), card("c", 1103)], ev: { a: pushed("a"), b: pushed("b"), c: pushed("c") } });
  const got = reviews(v, "Checker");
  assert.equal(got.length, 1);
  assert.equal(got[0].num, 1102, "a waits on Release, not on Checker: it is dropped for Checker");
  assert.deepEqual(got[0].together, [{ num: 1103, sha: "cccccccccccc" }]);
  const own = world({ cards: [card("a", 1101, { waiting_on: "Checker: review" }), card("b", 1102), card("c", 1103)], ev: { a: pushed("a"), b: pushed("b"), c: pushed("c") } });
  assert.equal(reviews(own, "Checker")[0].num, 1101, "a waiting_on that names the lane itself keeps the card in the range");
  assert.equal(reviews(own, "Checker")[0].together.length, 2);
});

test("dispatchLine checks the range again: a bad number, tip or group word never reaches the line", () => {
  const base = { card: "a", role: "Checker", level: 1, since: NOW, phase: "checker", step: "review", num: 1101, sha: "a".repeat(12) };
  const line = dispatchLine({ ...base, group: "g14-x", together: [{ num: 1102, sha: "b".repeat(12) }, { num: "1; rm", sha: "c".repeat(12) }, { num: 1103, sha: "not-a-sha" }, null] });
  assert.match(line, /together with #C1102 \(b{12}\) of group g14-x as one range/);
  assert.doesNotMatch(line, /rm|not-a-sha|1103/);
  assert.doesNotMatch(dispatchLine({ ...base, group: "bad group!", together: [{ num: 1102, sha: "b".repeat(12) }] }), /together/);
  const items = dispatchItems({ cards: [{ id: "a", num: 1101, status: "active", who: "Boardsmith", turns: [{ role: "Checker", phase: "checker", step: "review", sha: "a".repeat(12), group: "g14 x", together: [{ num: 1102, sha: "b".repeat(12) }] }] }], agents: { Checker: idle }, roster: ROSTER, lead: LEAD, now: NOW }).items;
  assert.equal(items[0].together, undefined, "a group that is no plain word is dropped at the write");
});

// ---- the page: cards reviewed together pulse in unison ----
const NAMES = ["groupRow", "initRow", "gates", "enrich", "state", "isTogether", "pulseSync", "pulseOffset"];
// #C1382: a card row draws the Worker's reading; `readings` maps a card id to the reading's own fields.
function board(raw, readings, tiles = []) {
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} }), querySelectorAll: (q) => (q === ".step.now" ? tiles : []), querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(NAMES, { document });
  Object.assign(b.state, { initRaw: raw, initiatives: raw.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [] });
  setReadings(b, ...Object.entries(readings).map(([id, over]) => readingDoc(id, over)));
  return b;
}
const pcard = (id, num, extra = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "checker", who: "Checker", repo: "flight-board", batch: "g5-thing", branch: `build/${id}`, createdAt: 1_800_000_000_000 + num * 60e3, ...extra });
const on = (phase, who) => ({ phase, state: "working", wait: null, with: who, working: true });
const nowTile = (html) => [...html.matchAll(/<div class="(step now[^"]*)" title="Checker[^"]*">(.*?)<\/div>/g)].map((m) => ({ cls: m[1], inner: m[2] }));
// A pulsing tile as the page's DOM holds it: its classes and its row (a card's data-card, or a group's data-group).
// The page's own shape (Designer F1 on 04b8dfcc): a card's .i-row holds a [data-card] div that closes before the track, so the tile's closest .i-row has no dataset of its own and finds its card inside; a group's .i-row carries data-group.
const tile = (row, cls) => ({ classList: { contains: (c) => cls.split(" ").includes(c) }, closest: (q) => (q === ".i-row" ? (row.group ? { dataset: { group: row.group }, querySelector: () => null } : { dataset: {}, querySelector: (s) => (s === "[data-card]" ? { dataset: { card: row.card } } : null) }) : null), style: {} });
const delay = (t) => Number(/^-(\d+)ms$/.exec(t.style.animationDelay)?.[1]);
const near = (x, y) => Math.abs(x - y) <= 50 || Math.abs(Math.abs(x - y) - 2400) <= 50; // the same phase of a 2.4 s pulse, the clock moving a few ms between two reads

test("page: two cards of a group read at the same review phase say together on their tiles and the group's", () => {
  const b = board([pcard("alpha-card", 1, {}), pcard("bravo-card", 2, { who: "Checker 2" })], { "alpha-card": on("checker", "Checker"), "bravo-card": on("checker", "Checker 2") });
  const [ta] = nowTile(b.initRow(b.state.initiatives[0])), [tb] = nowTile(b.initRow(b.state.initiatives[1]));
  assert.match(ta.cls, /together/);
  assert.match(ta.inner, /<small class="tog">together<\/small>/);
  assert.match(tb.cls, /together/);
  const gt = b.groupRow("g5-thing", b.state.initiatives).split('<div class="g-rail">')[0].match(/<div class="(step now[^"]*)" title="Checker">(.*?)<\/div>/);
  assert.match(gt[1], /together/);
  assert.match(gt[2], /<small class="tog">together<\/small>/);
});

test("page: the pulsing tiles of one batch get the same delay, at card and group level; a lone card's differs", () => {
  const tiles = [tile({ card: "alpha-card" }, "step now together"), tile({ card: "bravo-card" }, "step now together"), tile({ group: "g5-thing" }, "step now together"), tile({ card: "solo-card" }, "step now"), tile({ card: "other-solo" }, "step now")];
  const b = board([pcard("alpha-card", 1)], {}, tiles);
  b.pulseSync();
  const [a, c, g, s1, s2] = tiles.map(delay);
  assert.ok([a, c, g, s1, s2].every(Number.isFinite), "every pulsing tile has a delay");
  assert.ok(near(a, c) && near(a, g), "the batch beats as one, cards and group");
  assert.ok(!near(s1, s2), "two lone cards do not beat together");
  assert.ok(!near(s1, a) && !near(s2, a), "a lone card is out of step with the batch");
});

test("page (Designer F1): two lone cards get different delays, and a lone card inside a group does not pulse with its group", () => {
  const tiles = [tile({ card: "solo-card" }, "step now"), tile({ card: "other-solo" }, "step now"), tile({ group: "g5-thing" }, "step now"), tile({ card: "in-group-solo" }, "step now"), tile({ group: "g6-other" }, "step now")];
  board([pcard("solo-card", 1)], {}, tiles).pulseSync();
  const [s1, s2, g, c, g2] = tiles.map(delay);
  assert.ok([s1, s2, g, c, g2].every(Number.isFinite));
  assert.ok(!near(g, g2), "two groups that are not reviewed together beat by themselves");
  assert.ok(!near(s1, s2), "two lone cards: own delays");
  assert.ok(!near(g, c) && !near(g, s1), "a lone card in a group, and the group's own tile (not together), each beat by themselves");
});

test("page (Designer F1): a card row's markup is the shape pulseSync reads: [data-card] inside the .i-row, the track after it, no data-group", () => {
  const b = board([pcard("alpha-card", 1)], { "alpha-card": on("checker", "Checker") });
  const html = b.initRow(b.state.initiatives[0]);
  assert.match(html, /^<div class="i-row[^"]*"><div data-card="alpha-card">/);
  assert.ok(html.indexOf('data-card="alpha-card"') < html.indexOf('<div class="track"'), "the card's id comes before its track, inside the row");
  assert.doesNotMatch(html, /data-group=/);
  assert.match(b.groupRow("g5-thing", b.state.initiatives), /^<div class="i-row g-row" data-group="g5-thing">/);
});

test("page (Designer F2): the group tile's together label has the tog class, as the card's", () => {
  const b = board([pcard("alpha-card", 1), pcard("bravo-card", 2, { who: "Checker 2" })], { "alpha-card": on("checker", "Checker"), "bravo-card": on("checker", "Checker 2") });
  assert.match(b.groupRow("g5-thing", b.state.initiatives).split('<div class="g-rail">')[0], /<small class="tog">together<\/small>/);
});

test("page: a card reviewed alone pulses by itself: no together class or label", () => {
  const b = board([pcard("a", 1), pcard("b", 2, { phase: "build", who: "Boardsmith" })], { a: on("checker", "Checker"), b: on("build", "Boardsmith") });
  const [ta] = nowTile(b.initRow(b.state.initiatives[0]));
  assert.ok(ta, "its review tile pulses");
  assert.doesNotMatch(ta.cls, /together/);
  assert.doesNotMatch(ta.inner, /together/);
  assert.equal(b.isTogether("g5-thing", "checker"), false);
});

test("page: only open, started cards of ONE group at the same review phase count as together", () => {
  const b = board([pcard("a", 1), pcard("b", 2, { status: "paused" }), pcard("c", 3, { batch: "g6-other" }), pcard("d", 4, { phase: "security", who: "Security" }), pcard("e", 5, { phase: "build", who: "Boardsmith" }), pcard("f", 6, { phase: "build", who: "Boardsmith" })], { a: on("checker", "Checker") });
  assert.equal(b.isTogether("g5-thing", "checker"), false, "a paused card, a card of another group and one at another phase are not in the batch");
  assert.equal(b.isTogether("g5-thing", "build"), false, "build is no review phase");
  assert.equal(b.isTogether("", "checker"), false, "no group, no batch");
});
