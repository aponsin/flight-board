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
import { loadNames } from "./harness.mjs";

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
const NAMES = ["groupRow", "initRow", "gates", "enrich", "probeEvent", "state", "isTogether", "pulseStyle"];
function board(raw, agents) {
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} }), querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(NAMES, { document });
  Object.assign(b.state, { initRaw: raw, initiatives: raw.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [] });
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 20e3 }, cards: {}, agents } } }, {});
  return b;
}
const pcard = (id, num, extra = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "checker", who: "Checker", repo: "flight-board", batch: "g5-thing", branch: `build/${id}`, createdAt: 1_800_000_000_000 + num * 60e3, ...extra });
const on = (id) => ({ state: "working", card: id, lastActivityAt: Date.now(), since: Date.now() - 60e3 });
const nowTile = (html) => [...html.matchAll(/<div class="(step now[^"]*)" title="Checker[^"]*"( style="[^"]*")?>(.*?)<\/div>/g)].map((m) => ({ cls: m[1], style: m[2] ?? "", inner: m[3] }));
const delay = (style) => Number(/animation-delay:-(\d+)ms/.exec(style)?.[1]);

test("page: two cards of a group read at the same review phase pulse in unison and say together, at card and group level", () => {
  const b = board([pcard("alpha-card", 1, {}), pcard("bravo-card", 2, { who: "Checker 2" })], { Checker: on("alpha-card"), "Checker 2": on("bravo-card") }); // ids whose own delays differ, so a shared one is the rule, not luck
  const [ta] = nowTile(b.initRow(b.state.initiatives[0])), [tb] = nowTile(b.initRow(b.state.initiatives[1]));
  assert.match(ta.cls, /together/);
  assert.match(ta.inner, /<small class="tog">together<\/small>/);
  assert.match(tb.cls, /together/);
  assert.ok(Math.abs(delay(ta.style) - delay(tb.style)) <= 50 || Math.abs(Math.abs(delay(ta.style) - delay(tb.style)) - 2400) <= 50, "the same phase of the pulse (the clock moved at most a few ms between the two)");
  const group = b.groupRow("g5-thing", b.state.initiatives);
  const gt = group.split('<div class="g-rail">')[0].match(/<div class="(step now[^"]*)" title="Checker"( style="[^"]*")?>(.*?)<\/div>/);
  assert.match(gt[1], /together/);
  assert.match(gt[3], /<small>together<\/small>/);
  assert.ok(Math.abs(delay(gt[2]) - delay(ta.style)) <= 50 || Math.abs(Math.abs(delay(gt[2]) - delay(ta.style)) - 2400) <= 50, "the group's tile beats with its cards");
});

test("page: a card reviewed alone pulses by itself: no together label, and its own delay", () => {
  const b = board([pcard("a", 1), pcard("b", 2, { phase: "build", who: "Boardsmith" })], { Checker: on("a"), Boardsmith: on("b") });
  const [ta] = nowTile(b.initRow(b.state.initiatives[0]));
  assert.ok(ta, "its review tile pulses");
  assert.doesNotMatch(ta.cls, /together/);
  assert.doesNotMatch(ta.inner, /together/);
  assert.match(ta.style, /animation-delay:-\d+ms/);
  assert.equal(b.isTogether("g5-thing", "checker"), false);
  assert.match(b.pulseStyle("a", false), /animation-delay/);
});

test("page: only open, started cards of ONE group at the same review phase count as together", () => {
  const b = board([pcard("a", 1), pcard("b", 2, { status: "paused" }), pcard("c", 3, { batch: "g6-other" }), pcard("d", 4, { phase: "security", who: "Security" }), pcard("e", 5, { phase: "build", who: "Boardsmith" }), pcard("f", 6, { phase: "build", who: "Boardsmith" })], { Checker: on("a") });
  assert.equal(b.isTogether("g5-thing", "checker"), false, "a paused card, a card of another group and one at another phase are not in the batch");
  assert.equal(b.isTogether("g5-thing", "build"), false, "build is no review phase");
  assert.equal(b.isTogether("", "checker"), false, "no group, no batch");
});
