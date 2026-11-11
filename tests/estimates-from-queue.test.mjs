// #C877 (estimates-from-queue): the "Live in" estimate from the queue order (#C871) and the medians by size, drawn on the store too.
// The page's own functions, called with a fixed clock: nothing here reads the time.
import test from "node:test";
import assert from "node:assert/strict";
import { drawPage } from "./helpers/draw-page.mjs";

const H = 3600e3, NOW = 1_800_000_000_000;
const EXPOSE = ["phaseMedians", "medFor", "queueEta", "derivedEta", "PHASES", "BUILD_PHASE"];
const page = () => drawPage({ initiatives: [] }, { host: "store", expose: EXPOSE }).b;

// A card that went live: each phase of the list took the hours given (a log of back-to-back phases), done at the end.
function done(b, id, size, hours, doneEnd = NOW - 24 * H) {
  const log = []; let t = doneEnd - Object.values(hours).reduce((a, h) => a + h, 0) * H;
  for (const [phase, h] of Object.entries(hours)) { log.push({ phase, who: "x", start: t, end: t + h * H }); t += h * H; }
  return { id, size, status: "done", doneAt: t, phaseLog: log };
}
const phasesOf = (b) => b.PHASES.map((p) => p[0]).filter((k) => k !== "live");
const hoursFor = (b, build, rest) => Object.fromEntries(phasesOf(b).map((k) => [k, k === b.BUILD_PHASE ? build : rest]));

test("medians by size: a size with 3 finished cards has its own median, one with fewer falls back to the overall", () => {
  const b = page(), cards = [];
  for (let n = 0; n < 3; n++) cards.push(done(b, `s${n}`, "S", hoursFor(b, 1, 0.5)));
  for (let n = 0; n < 3; n++) cards.push(done(b, `l${n}`, "L", hoursFor(b, 6, 0.5)));
  for (let n = 0; n < 2; n++) cards.push(done(b, `m${n}`, "M", hoursFor(b, 3, 0.5)));
  const med = b.phaseMedians(cards);
  assert.equal(med[b.BUILD_PHASE], 3 * H, "the overall median of build: 1,1,1,3,3,6,6,6 h is 3 h");
  assert.equal(b.medFor({ size: "S" }, med)[b.BUILD_PHASE], 1 * H);
  assert.equal(b.medFor({ size: "L" }, med)[b.BUILD_PHASE], 6 * H);
  assert.equal(b.medFor({ size: "M" }, med)[b.BUILD_PHASE], 3 * H, "two M cards are too few: the overall median stands");
  assert.equal(b.medFor({ size: "XS" }, med)[b.BUILD_PHASE], 3 * H, "a size with none falls back too");
  assert.equal(JSON.stringify(Object.keys(med).sort()), JSON.stringify(phasesOf(b).sort()), "the medians' own keys are the phases, the by-size part is hidden");
});

test("the replay window: phaseMedians(cards, upTo) uses only cards done by then", () => {
  const b = page();
  const old = done(b, "old", "S", hoursFor(b, 2, 1), NOW - 10 * 24 * H), recent = done(b, "new", "S", hoursFor(b, 8, 1), NOW - 1 * H);
  assert.equal(b.phaseMedians([old, recent])[b.BUILD_PHASE], 5 * H);
  assert.equal(b.phaseMedians([old, recent], NOW - 5 * 24 * H)[b.BUILD_PHASE], 2 * H, "the newer card was not done yet");
});

test("queue order: the 2nd card's ETA is the 1st card's build median after the 1st's, and a bigger card the later", () => {
  const b = page(), cards = [];
  for (let n = 0; n < 3; n++) cards.push(done(b, `s${n}`, "S", hoursFor(b, 1, 0.5)));
  for (let n = 0; n < 3; n++) cards.push(done(b, `l${n}`, "L", hoursFor(b, 6, 0.5)));
  const med = b.phaseMedians(cards);
  const queued = (id, size, pos) => ({ id, size, who: "Boardsmith", status: "queued", phase: b.BUILD_PHASE, queuePos: pos, phaseLog: [] });
  const q = [queued("a", "S", 1), queued("b", "S", 2), queued("c", "L", 3)];
  const board = drawPage({ initiatives: q }, { host: "store", expose: EXPOSE }).b;
  const [a, bb, c] = ["a", "b", "c"].map((id) => board.state.initiatives.find((i) => i.id === id));
  const eta = (i) => board.queueEta(i, med, NOW);
  assert.ok(eta(a) != null && eta(bb) != null && eta(c) != null, "all three have an ETA");
  assert.equal(eta(bb) - eta(a), 1 * H, "b starts when a's build (1 h, S) is done");
  assert.equal(eta(c) - eta(bb), 1 * H + 5 * H, "c starts when b's build (1 h, S) is done, and its own build runs on the L median (6 h, not 1 h)");
  // c is L: its own phases run on the L build median (6 h), a's and b's on S (1 h).
  assert.equal(eta(a) - NOW, 1 * H + 4 * 0.5 * H, "a: now + its build median + the other phases ahead of live");
  assert.equal(eta(c) - (NOW + 2 * H), 6 * H + 4 * 0.5 * H);
});

test("no ETA for a card without a place in a queue, or while a phase ahead has no median yet", () => {
  const b = page();
  const med = b.phaseMedians([done(b, "s0", "S", hoursFor(b, 1, 0.5))]);
  const solo = { id: "z", size: "S", who: "Boardsmith", status: "queued", phase: b.BUILD_PHASE, phaseLog: [] };
  const board = drawPage({ initiatives: [solo] }, { host: "store", expose: EXPOSE }).b;
  assert.equal(board.queueEta(board.state.initiatives[0], med, NOW), null, "no queue place");
  const placed = { ...solo, queuePos: 1 };
  const board2 = drawPage({ initiatives: [placed] }, { host: "store", expose: EXPOSE }).b;
  assert.notEqual(board2.queueEta(board2.state.initiatives[0], med, NOW), null);
  assert.equal(board2.queueEta(board2.state.initiatives[0], {}, NOW), null, "no history at all: no estimate");
});
