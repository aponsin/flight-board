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
  const b = loadNames(["queueOf", "queueLabel", "queueLine", "ordinal", "initRow"]);
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
  assert.equal(line, `<span class="q-line">Boardsmith&#39;s queue: ${link("board-thread-card-link", 364)} (in review) → ${link("board-card-refs", 367)} (building) → this → ${link("board-reply-compact", 368)} → ${link("bad-pos", 371)} → ${link("ctx-tokens", 350)}</span>`);
  assert.ok(b.initRow(of(b, "board-queue-order")).includes(line), "on the card");
  assert.equal(b.queueLine(of(b, "board-card-refs")), "", "a started card has no queue line");
  assert.equal(b.queueLine({ ...of(b, "ctx-tokens"), who: "" }), "", "no who, no queue");
});
