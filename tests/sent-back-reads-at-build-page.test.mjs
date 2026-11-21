// #C1406 (Designer's F1, F2, F3 on 261814e7): a card sent back by a review is lit at Build with its owner. (F1) the card's Build tile says only the owner (the name was cut at 1280 and 390 px behind "Sent back ·"; the
// pill and the hover already say sent back); (F2) the group's Build tile takes the same small words when every card in it agrees, and its hover says "sent back"; (F3) the crew badge's hover says
// "Build (sent back by Checker)", not the card row's older phase. The page is loaded the way the other page tests load it (no browser).
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, readingDoc, setReadings } from "./harness.mjs";

const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
const document = { documentElement: { getAttribute: () => "store" }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
const raw = (id, num, phase = "checker") => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase, who: "Boardsmith", repo: "flight-board", batch: "g5-thing", branch: `build/${id}`, createdAt: 1_800_000_000_000 + num * 60e3 });
const SENT = (lane = "checker", over = {}) => ({ phase: "build", state: "rework", wait: null, with: "Boardsmith", working: false, reviewPhase: lane, reason: lane === "security" ? "security finding" : "review findings", why: `sent back by ${lane}: ${lane === "security" ? "security finding" : "review findings"}`, ...over });
const GROUPED = { phase: "build", state: "waiting", wait: "group", with: null };
const QUEUED = { phase: "build", state: "queued", wait: null, with: "Boardsmith" };

function page(initRaw, readings) {
  const b = loadNames(["groupRow", "initRow", "gates", "enrich", "state", "crewBadgeTitle", "readingOf", "notStarted", "phaseStart"], { document });
  Object.assign(b.state, { initRaw, initiatives: initRaw.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [] });
  setReadings(b, ...Object.entries(readings).map(([id, over]) => readingDoc(id, over)));
  return b;
}
const tileOf = (html, label) => { const m = html.match(new RegExp(`<div class="(step[^"]*)" title="(${label}[^"]*)">(.*?)</div>`)); return m && { cls: m[1], title: m[2], inner: m[3] }; };

test("F1: the card's Build tile says only who has it, a working one the same; with no owner in the reading it says Sent back", () => {
  const cards = [raw("a", 1)];
  const idle = tileOf(page(cards, { a: SENT() }).initRow(page(cards, { a: SENT() }).state.initiatives[0]), "Build");
  assert.match(idle.inner, /<small>Boardsmith<\/small>/);
  assert.doesNotMatch(idle.inner, /Sent back/, "the owner is not cut behind a longer word");
  assert.match(idle.title, /sent back by checker: review findings/, "the hover keeps the why");
  const none = page(cards, { a: SENT("checker", { with: null }) });
  assert.match(tileOf(none.initRow(none.state.initiatives[0]), "Build").inner, /<small>Sent back<\/small>/);
});

test("F2: the group's Build tile takes the cards' own words when they agree, and says 'sent back' in its hover; with one card waiting for the group it names the sent-back one", () => {
  const cards = [raw("a", 1), raw("b", 2)];
  const both = page(cards, { a: SENT(), b: SENT("security") });
  const t = tileOf(both.groupRow("g5-thing", both.state.initiatives).split('<div class="g-rail">')[0], "Build");
  assert.match(t.inner, /<small>Boardsmith<\/small>/, "every card in the tile is back with the same owner");
  const mixed = page(cards, { a: SENT(), b: QUEUED });
  const m = tileOf(mixed.groupRow("g5-thing", mixed.state.initiatives).split('<div class="g-rail">')[0], "Build");
  assert.match(m.title, /1 of 2 cards sent back/, "the hover words the sent-back card, not 'waiting'");
});

test("F3: the crew badge's hover says Build and the review that sent the card back, not the card row's phase; a card not sent back keeps its phase", () => {
  const cards = [raw("a", 1), raw("b", 2)];
  const b = page(cards, { a: SENT("checker"), b: { phase: "checker", state: "waiting", wait: "turn", with: "Checker" } });
  const title = (id) => b.crewBadgeTitle({ card: b.state.initiatives.find((i) => i.id === id), state: "here" }, 1_800_000_000_000);
  assert.match(title("a"), /Phase: Build \(sent back by Checker\)/);
  assert.match(title("b"), /Phase: Checker/);
  assert.doesNotMatch(title("b"), /sent back/);
  const sec = page(cards, { a: SENT("security"), b: GROUPED });
  assert.match(sec.crewBadgeTitle({ card: sec.state.initiatives[0], state: "here" }, 1_800_000_000_000), /Phase: Build \(sent back by Security\)/);
});
