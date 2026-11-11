// #C877 (estimates-from-queue): the "Live in" estimate from the queue order (#C871) and the medians by size, drawn on the store too.
// The page's own functions, called with a fixed clock: nothing here reads the time.
import test from "node:test";
import assert from "node:assert/strict";
import { drawPage } from "./helpers/draw-page.mjs";

const H = 3600e3, NOW = 1_800_000_000_000;
const EXPOSE = ["phaseMedians", "medFor", "queueEta", "derivedEta", "PHASES", "BUILD_PHASE"];
const page = (host = null) => drawPage({ initiatives: [] }, { host, expose: EXPOSE }).b; // the artifact page by default: measured medians only

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
  const board = drawPage({ initiatives: q }, { host: null, expose: EXPOSE }).b;
  const [a, bb, c] = ["a", "b", "c"].map((id) => board.state.initiatives.find((i) => i.id === id));
  const eta = (i) => board.queueEta(i, med, NOW);
  assert.ok(eta(a) != null && eta(bb) != null && eta(c) != null, "all three have an ETA");
  assert.equal(eta(bb) - eta(a), 1 * H, "b starts when a's build (1 h, S) is done");
  assert.equal(eta(c) - eta(bb), 1 * H + 5 * H, "c starts when b's build (1 h, S) is done, and its own build runs on the L median (6 h, not 1 h)");
  // c is L: its own phases run on the L build median (6 h), a's and b's on S (1 h).
  assert.equal(eta(a) - NOW, 1 * H + 4 * 0.5 * H, "a: now + its build median + the other phases ahead of live");
  assert.equal(eta(c) - (NOW + 2 * H), 6 * H + 4 * 0.5 * H);
});

// Manager on #C877: the store has no build rows of its own, so its build median is the owner's agreed table until 10 recorded builds per size.
test("on the store the build median is the agreed table by size (XS 1 h, S 1.5 h, M 3.5 h, L 6 h), whatever the thin history says", () => {
  const b = page("store"), cards = [];
  for (let n = 0; n < 4; n++) cards.push(done(b, `s${n}`, "S", hoursFor(b, 0.1, 0.5)), done(b, `l${n}`, "L", hoursFor(b, 0.5, 0.5)), done(b, `m${n}`, "M", hoursFor(b, 0.2, 0.5)), done(b, `x${n}`, "XS", hoursFor(b, 0, 0.5)));
  const med = b.phaseMedians(cards);
  const bd = (size) => b.medFor({ size }, med)[b.BUILD_PHASE];
  assert.deepEqual([bd("XS"), bd("S"), bd("M"), bd("L")], [1 * H, 1.5 * H, 3.5 * H, 6 * H]);
  assert.notEqual(bd("XL"), 6 * H, "a size not in the table keeps the measured median");
  assert.equal(page(null).phaseMedians(cards)[b.BUILD_PHASE] < H, true, "the artifact page is unchanged: measured medians only");
  // The other phases still come from the history.
  assert.equal(b.medFor({ size: "S" }, med)[phasesOf(b).find((k) => k !== b.BUILD_PHASE)], 0.5 * H);
});

test("on the store, 10 cards of a size with a recorded build (real:true) switch that size to the measured median; 9 do not", () => {
  const b = page("store");
  const recorded = (n, hours) => { const c = done(b, `r${n}`, "S", hoursFor(b, hours, 0.5)); c.phaseLog.forEach((e) => { if (e.phase === b.BUILD_PHASE) e.real = true; }); return c; };
  const nine = Array.from({ length: 9 }, (_, n) => recorded(n, 4));
  assert.equal(b.medFor({ size: "S" }, b.phaseMedians(nine))[b.BUILD_PHASE], 1.5 * H, "9 recorded builds: still the table");
  const ten = Array.from({ length: 10 }, (_, n) => recorded(n, 4));
  assert.equal(b.medFor({ size: "S" }, b.phaseMedians(ten))[b.BUILD_PHASE], 4 * H, "10 recorded builds: their median");
});

test("on the store a queued XS card first in its queue reads about the table's hour, not minutes", () => {
  const b0 = page("store");
  const hist = [0, 1, 2].map((n) => done(b0, `h${n}`, "XS", hoursFor(b0, 0.05, 0.25)));
  const q1 = { id: "q1", size: "XS", who: "Boardsmith", status: "queued", phase: b0.BUILD_PHASE, queuePos: 1, phaseLog: [] };
  const board = drawPage({ initiatives: [...hist, q1] }, { host: "store", expose: EXPOSE }).b;
  const med = board.phaseMedians(board.state.initiatives);
  const eta = board.queueEta(board.state.initiatives.find((i) => i.id === "q1"), med, NOW);
  assert.equal(eta - NOW, 1 * H + 4 * 0.25 * H, "the table's hour for build, the measured quarter hours for the phases after it");
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

// Designer F1 on 1be0ac1: an ETA worked out from the queue is not "(declared)"; only one that came from the card's own etaLive is.
test("the ETA box says (declared) only when the ETA is the card's own etaLive, not when it is worked out from the queue", () => {
  const b0 = page();
  const hist = [0, 1, 2].map((n) => done(b0, `h${n}`, "S", hoursFor(b0, 1, 0.5), Date.now() - 24 * H));
  const queued = { id: "q1", name: "Queued card", size: "S", who: "Boardsmith", status: "queued", phase: b0.BUILD_PHASE, queuePos: 1, phaseLog: [] };
  const worked = drawPage({ initiatives: [...hist, queued] }, { host: "store", expose: EXPOSE }).html;
  assert.match(worked, /<div class="lbl">Live in<\/div>/);
  assert.doesNotMatch(worked, /\(declared\)/, "worked out from the queue and the medians");
  const typed = drawPage({ initiatives: [{ ...queued, queuePos: undefined, etaLive: Date.now() + 3 * H }] }, { host: "store", expose: EXPOSE }).html;
  assert.match(typed, /<div class="lbl">Live in<\/div>/);
  assert.match(typed, /\(declared\)/, "the card's own etaLive, with no queue place and no history");
});

// Security R1 on 1be0ac1: a card's size is a key of the page's medians; "__proto__" must not reach Object.prototype.
test("(a) the Worker refuses a size that is not one of the card words; the sizes in use and null pass", async () => {
  const { cardWriteRefusal } = await import("../worker/board-rules.mjs");
  for (const bad of ["__proto__", "constructor", "toString", "xs", "Huge", "", 5, {}, ["S"]]) assert.equal(cardWriteRefusal({ size: bad })?.rule, "card-size", JSON.stringify(bad));
  for (const ok of ["XS", "S", "M", "L", "XL", null]) assert.equal(cardWriteRefusal({ size: ok }), null, String(ok));
  assert.equal(cardWriteRefusal({ title: "no size given" }), null);
});

test("(b) the page: done cards of size __proto__, constructor or toString leave Object.prototype clean and give no size median", () => {
  const b = page();
  const bad = ["__proto__", "constructor", "toString", "hasOwnProperty"].flatMap((s) => [0, 1, 2].map((n) => done(b, `${s}-${n}`, s, hoursFor(b, 2, 0.5))));
  const med = b.phaseMedians([...bad, done(b, "ok", "S", hoursFor(b, 1, 0.5))]);
  assert.equal(({}).build, undefined, "Object.prototype has no build");
  for (const k of phasesOf(b)) assert.equal(({})[k], undefined, k);
  assert.equal(Object.keys(Object.prototype).length, 0);
  for (const s of ["__proto__", "constructor", "toString", "hasOwnProperty"]) assert.equal(b.medFor({ size: s }, med), med, `${s}: the overall medians, untouched`);
  assert.equal(b.medFor({ size: "S" }, med)[b.BUILD_PHASE] > 0, true);
});
