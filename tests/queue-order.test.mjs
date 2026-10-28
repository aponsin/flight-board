// A queued card says whose queue it waits in and its place (#C370, the owner in #T983: 'BUILD queued' said neither).
// Its phase box reads "queued · Boardsmith · 3rd", and the card has a line "Boardsmith's queue: #C364 (in review) →
// #C367 → this → #C368", each number a link. The order is the card field queuePos (1 = next, kept by Manager), ties by
// createdAt; a card without one comes last and says "queued · <who>". Only a positive whole number counts.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const T = Date.now();
// Today's Boardsmith cards, as the queue stood when the owner asked.
const card = (num, id, extra) => ({ id, num, name: id, size: "S", status: "active", phase: "plan", who: "Boardsmith", createdAt: T - num * 1e3, ...extra });
const cards = () => [
  card(364, "board-thread-card-link", { phase: "checker", branch: "board-thread-card-link", queuePos: 1 }),
  card(367, "board-card-refs", { phase: "build", branch: "board-card-refs", queuePos: 2 }),
  card(370, "board-queue-order", { queuePos: 3 }),
  card(368, "board-reply-compact", { queuePos: 4 }),
  card(350, "ctx-tokens", {}),
  card(371, "bad-pos", { queuePos: "2" }),
  card(300, "other-lane", { who: "Checker", queuePos: 1 }),
  card(299, "done-one", { status: "done", queuePos: 1 }),
];
function board() {
  const b = loadNames(["queueOf", "queueLabel", "queueLine", "ordinal", "initRow", "cardEta", "derivedEta", "gaps"]);
  Object.assign(b.state, { steps: [], derived: [], waiting: [], ideas: [], messages: [], threads: [], initRaw: cards(), initiatives: cards() });
  return b;
}
const of = (b, id) => b.state.initiatives.find((i) => i.id === id);

test("the queue: the who's open cards by queuePos, ties by createdAt; none or a non-number last", () => {
  const b = board();
  assert.deepEqual([...b.queueOf("Boardsmith")].map((i) => i.num), [364, 367, 370, 368, 371, 350]);
  assert.deepEqual([...b.queueOf("Checker")].map((i) => i.num), [300]);
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(b.ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st"]);
});

test("a queued card's box: 'queued · Boardsmith · 3rd'; without a place, 'queued · Boardsmith'", () => {
  const b = board();
  assert.equal(b.queueLabel(of(b, "board-queue-order")), "queued · Boardsmith · 3rd");
  assert.equal(b.queueLabel(of(b, "ctx-tokens")), "queued · Boardsmith");
  assert.equal(b.queueLabel(of(b, "bad-pos")), "queued · Boardsmith", "\"2\" is no place");
  assert.equal(b.queueLabel({ ...of(b, "ctx-tokens"), who: "" }), "queued");
  assert.match(b.initRow(of(b, "board-queue-order")), /<div class="step now queued"[^>]*>Build<small>queued · Boardsmith · 3rd<\/small>/);
});

test("the card's line: the whole queue, each number a link, this one as 'this', started ones say where they are", () => {
  const b = board();
  const link = (id, n) => `<a href="#" class="t-ref c-ref" data-cref="${id}">#C${n}</a>`;
  const line = b.queueLine(of(b, "board-queue-order"));
  assert.equal(line, `<span class="q-line">Boardsmith&#39;s queue: ${link("board-thread-card-link", 364)} (in review) → ${link("board-card-refs", 367)} (building) → <b>this</b> → ${link("board-reply-compact", 368)} → ${link("bad-pos", 371)} → ${link("ctx-tokens", 350)}</span>`);
  assert.ok(b.initRow(of(b, "board-queue-order")).includes(line), "on the card");
  assert.equal(b.queueLine(of(b, "board-card-refs")), "", "a started card has no queue line");
  assert.equal(b.queueLine({ ...of(b, "ctx-tokens"), who: "" }), "", "no who, no queue");
  assert.equal(b.queueLine({ ...of(b, "ctx-tokens") }), "", "a card the board's list doesn't hold: no empty line");
  assert.equal(b.queueLine({ ...of(b, "ctx-tokens"), who: "Solo" }), "", "alone in its queue: nothing to show");
});

// Designer on 6531fc5, Manager: #C370 (3rd) and #C368 (4th) both said "live in 3 h". A queued card with a place starts
// when the card ahead of it in its who's queue is expected to finish its build, then adds its own phases.
const MIN = 60e3;
const MED = { build: 60 * MIN, test: 10 * MIN, language: 10 * MIN, checker: 30 * MIN, security: 20 * MIN, ship: 10 * MIN };
const CHAIN = 140 * MIN; // build to ship, each phase's median
function queueBoard(list) {
  const b = board();
  b.state.initiatives = b.state.initRaw = list;
  b.state.phaseMed = MED;
  return b;
}
const near = (a, want, what) => assert.ok(Math.abs(a - want) < 5e3, `${what}: ${new Date(a).toISOString()} vs ${new Date(want).toISOString()}`);

test("queue-aware ETAs: each queued card starts when the one ahead finishes its build", () => {
  const now = Date.now();
  const a = card(1, "a", { phase: "build", branch: "a", queuePos: 1, phaseLog: [{ phase: "build", start: now - 20 * MIN }] });
  const q2 = card(2, "q2", { queuePos: 2 }), q3 = card(3, "q3", { queuePos: 3 }), loose = card(4, "loose", { etaLive: now + 9 * MIN });
  const b = queueBoard([a, q2, q3, loose]);
  near(b.cardEta(q2), now + 40 * MIN + CHAIN, "2nd: after a's 40 min of build left");
  near(b.cardEta(q3), now + 40 * MIN + 60 * MIN + CHAIN, "3rd: after 2nd's build too");
  assert.equal(b.cardEta(loose), b.derivedEta(loose) ?? loose.etaLive, "no queuePos: as before");
  const r = queueBoard([card(1, "r", { phase: "checker", branch: "r", queuePos: 1 }), card(2, "s", { queuePos: 2 })]);
  near(r.cardEta(r.state.initiatives[1]), now + CHAIN, "the card ahead is in review: its build is done, so now");
  const n = queueBoard([card(1, "x", { queuePos: 1 }), card(2, "y", { queuePos: 2, etaLive: now + 7 * MIN })]);
  n.state.phaseMed = { checker: 1 };
  assert.equal(n.cardEta(n.state.initiatives[1]), n.derivedEta(n.state.initiatives[1]) ?? now + 7 * MIN, "no build median: as before");
});

test("no red 'never started' on a card waiting its turn; the first in line, or one with no place, still says so", () => {
  const old = { createdAt: Date.now() - 60 * MIN };
  const b = queueBoard([card(1, "a", { phase: "build", branch: "a", queuePos: 1 }), card(2, "w", { queuePos: 2, ...old }), card(3, "loose", { ...old })]);
  const [, w, loose] = b.state.initiatives;
  assert.ok(!b.gaps(w).includes("never started"), "waiting behind a");
  assert.ok(b.gaps(loose).includes("never started"), "no place in line");
  const f = queueBoard([card(1, "first", { queuePos: 1, ...old })]);
  assert.ok(f.gaps(f.state.initiatives[0]).includes("never started"), "nothing ahead of it: it should have started");
});

test("Checker on 6531fc5: a started card sorts before the queued ones, place or not", () => {
  const b = queueBoard([card(1, "q", { queuePos: 1 }), card(2, "started", { phase: "build", branch: "s" }), card(3, "q2", { queuePos: 2 })]);
  assert.deepEqual([...b.queueOf("Boardsmith")].map((i) => i.id), ["started", "q", "q2"]);
  assert.equal(b.queueLabel(b.state.initiatives[0]), "queued · Boardsmith · 2nd");
});
