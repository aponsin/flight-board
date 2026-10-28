// A Check is answered by code, and a card waiting on the owner isn't "stalled" (#C376, Director for the owner: #C350
// said "checking…" for minutes; "let's fix this for good").
// 1. The Collector works out every card afresh each run (derived/all cards.<id>.at), so a Check request older than
//    that run is answered: "checked by the Collector HH:MM". Until then the card says when the next run is due (hourly),
//    never a bare "checking…" that hangs. No ping to the lead.
// 2. A card with an open ask to the owner tied to it: no stall, no "never started", no stale next step or passed ETA;
//    the card says "Waiting on you" and names the ask, a link to it.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, step } from "./harness.mjs";

const MIN = 60e3;
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const NAMES = ["initRow", "enrich", "gates", "checkLine", "stalled", "ownerWait"];
const derived = (runAt, ids = ["ctx-tokens"]) => [{ id: "all", at: runAt, cards: Object.fromEntries(ids.map((id) => [id, { at: runAt, phase: "build" }])) }];

test("#C350's state: asked at :12, the Collector ran at :21, no lead stamp → checked by the Collector", () => {
  const now = Date.now(), b = loadNames(NAMES);
  const card = { id: "ctx-tokens", num: 350, status: "active" }, req = { at: now - 12 * MIN };
  b.state.derived = derived(now - 3 * MIN);
  assert.equal(b.checkLine(card, req, now), `checked by the Collector ${hhmm(now - 3 * MIN)}`);
});

test("before the next run: checking…, with when that run is due; past it, the run is late", () => {
  const now = Date.now(), b = loadNames(NAMES);
  const card = { id: "ctx-tokens", status: "active" };
  b.state.derived = derived(now - 20 * MIN);
  assert.equal(b.checkLine(card, { at: now - 5 * MIN }, now), `checking… next Collector run ~${hhmm(now + 40 * MIN)}`);
  b.state.derived = derived(now - 70 * MIN);
  assert.equal(b.checkLine(card, { at: now - 5 * MIN }, now), `checking… Collector run late (due ${hhmm(now - 10 * MIN)})`);
  b.state.derived = [];
  assert.equal(b.checkLine(card, { at: now - 5 * MIN }, now), "checking… until the Collector's next run", "no run seen yet");
});

test("a run that didn't cover the card (not in derived/all) doesn't answer it", () => {
  const now = Date.now(), b = loadNames(NAMES);
  b.state.derived = derived(now - 3 * MIN, ["other"]);
  assert.match(b.checkLine({ id: "ctx-tokens" }, { at: now - 12 * MIN }, now), /^checking…/);
});

test("the late state is marked on the card; the Check button waits while checking", () => {
  const now = Date.now(), b = loadNames(NAMES);
  b.state.steps = [step("x", "build", "Admin", "start", now - 20 * MIN)];
  b.state.waiting = [];
  b.state.checkRequests = [{ id: "x", at: now - 5 * MIN }];
  b.state.derived = derived(now - 70 * MIN, ["x"]);
  const html = b.initRow(b.gates(b.enrich({ id: "x", num: 351, name: "X", size: "S", level: "Quick", skip: ["plan"], status: "active", createdAt: now - 30 * MIN })));
  // Its own class, not the global .late (nowrap, margin, 600 weight): at 390 px that widened the card (Designer on 091cd53).
  assert.match(html, /<span class="i-checked is-late">checking… Collector run late \(due /);
  assert.doesNotMatch(html, /class="(?:[^"]*\s)?late[\s"]/);
  assert.doesNotMatch(html, /data-check=/);
});

// 2. Waiting on the owner.
function owned(b, { ask = true, answered = false } = {}) {
  const now = Date.now();
  b.state.steps = [step("x", "build", "Admin", "start", now - 90 * MIN)];
  b.state.derived = [];
  b.state.checkRequests = [];
  b.state.messages = [];
  // No "since": gates() holds only an ask with one (its Gated box), so before #C376 this card read "Stalled".
  b.state.waiting = ask ? [{ id: "w1", initiative: "x", kind: "decision", title: "Which look?", text: "A or B?", ...(answered ? { response: { status: "A", at: now - 10 * MIN } } : {}) }] : [];
  return b.gates(b.enrich({ id: "x", num: 351, name: "X", size: "S", level: "Quick", skip: ["plan"], status: "active", createdAt: now - 120 * MIN, nextNote: "Build", nextNoteAt: now - 2 * 36e5, etaLive: now - 30 * MIN }));
}

test("a card with an open ask to the owner: not stalled, no stale next step, no passed ETA; it says what it waits on", () => {
  const b = loadNames(NAMES), i = owned(b);
  assert.equal(b.ownerWait(i).id, "w1");
  assert.equal(b.stalled(i), 0);
  const html = b.initRow(i);
  assert.match(html, /<span class="state active">Waiting on you<\/span>/);
  assert.match(html, /<span class="ow-line">waiting on you: <a href="#" class="t-ref" data-tref="w1">/);
  assert.doesNotMatch(html, /No step logged|next step over 1 h old|ETA passed|Stalled/);
});

test("once the owner has answered, or with no ask, the timers run again", () => {
  for (const opts of [{ answered: true }, { ask: false }]) {
    const b = loadNames(NAMES), i = owned(b, opts);
    assert.equal(b.ownerWait(i), null);
    assert.ok(b.stalled(i) >= 30, "stalled again");
    const html = b.initRow(i);
    assert.match(html, />Stalled</);
    assert.match(html, /ETA passed/);
    assert.match(html, /next step over 1 h old/);
  }
});
