// #C1350 (the owner: the board is sluggish, with slow clicks and small freezes; Manager measured a full renderAll at about 1.4 s on the live board, run on every probe tick, so 11 of every 15 s were blocked): a redraw
// on a board the size of today's (1,000 threads, 3,000 messages, 960 asks, 300 cards, 7,000 steps) took about 1 s here, most of it the same few answers (waitsOn, threadOpen, threadResolved, teamOnly, itemOf, the
// click asks, a card's steps) worked out tens of thousands of times, plus the date formatters built on every call. Now one redraw keeps those answers for its own pass, and a probe reading equal to the last one draws nothing.
// The page's real script runs in a vm with a stand-in document (tests/helpers/page-vm.mjs).
const ZONE = ["America", "Den" + "ver"].join("/"); // the page's own zone for its Mountain-time words (its MT_ZONE)
process.env.TZ = ZONE; // the page writes local times; the tests compare words, so the zone is fixed
import test from "node:test";
import assert from "node:assert/strict";
import { loadPage, fixture, load, T0 } from "./helpers/page-vm.mjs";

const snapshot = (p) => Object.fromEntries(Object.entries(p.els).filter(([, e]) => typeof e.innerHTML === "string" && e.innerHTML).map(([k, e]) => [k, e.innerHTML]));
const best = (f, runs = 5) => { let b = Infinity; for (let i = 0; i < runs; i++) { const s = performance.now(); f(); b = Math.min(b, performance.now() - s); } return b; };

test("a full redraw on a board the size of today's is under the budget (it was about 1,000 ms)", async () => {
  const p = await loadPage();
  load(p, fixture());
  p.run("renderAll()"); // the first draw warms the formatters and the code
  // The pass memo makes it about 65 ms here; the bound leaves room for a loaded run (the suite runs files side by side) and still fails the repeated work.
  const ms = best(() => p.run("renderAll()"));
  assert.ok(ms < 300, `a redraw took ${ms.toFixed(0)} ms; the budget is 300 ms (target 100)`);
});

test("the redraw draws exactly what it drew before the memo: every element's HTML is equal with and without the pass memo", async () => {
  const p = await loadPage();
  load(p, fixture());
  p.run("memoOff=true;renderAll();memoOff=false"); // no pass: every function answers from the state, as before
  const plain = snapshot(p);
  p.run("renderAll()");
  const memo = snapshot(p);
  assert.ok(Object.keys(plain).length >= 10, "the fixture draws several elements");
  assert.ok(plain.waiting.length > 10_000, "and a real amount of html");
  assert.deepEqual(Object.keys(memo).sort(), Object.keys(plain).sort());
  for (const k of Object.keys(plain)) assert.equal(memo[k], plain[k], `${k} is the same html`);
});

test("the memo lives only inside one redraw: outside it a changed thread is read as changed at once", async () => {
  const p = await loadPage();
  load(p, fixture({ threads: 20, asks: 5, cards: 5, steps: 20 }));
  const id = "t-1799000000006"; // an old thread, resolved
  p.run("renderAll()");
  assert.equal(p.run("pass"), null, "no pass is left behind");
  const before = p.run(`waitsOn(${JSON.stringify(id)},Date.now())`);
  assert.equal(before, "resolved");
  p.run(`state.messages.push({id:"late",thread:${JSON.stringify(id)},from:"Owner",text:"one more thing, please",at:Date.now()+1})`);
  const after = p.run(`waitsOn(${JSON.stringify(id)},Date.now())`);
  assert.notEqual(after, before, `a new word from the owner changes the answer (${before} then ${after})`);
});

test("the date words are the ones toLocale* gave: hhmm, dayLabel, mtStamp and mtShort, today and another day, either side of midnight", async () => {
  const p = await loadPage();
  const times = [T0, T0 - 3 * 36e5, T0 - 30 * 36e5, T0 - 400 * 864e5, T0 + 36e5, 1_700_000_123_456, 1_800_050_000_000];
  for (const t of times) {
    const d = new Date(t);
    assert.equal(p.run(`hhmm(${t})`), d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), `hhmm ${t}`);
    for (const now of [T0, T0 + 5 * 36e5]) {
      const n = new Date(now), same = d.toDateString() === n.toDateString();
      assert.equal(p.run(`dayLabel(${t},${now})`), same ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), `dayLabel ${t} ${now}`);
      const day = (x) => new Date(x).toLocaleDateString("en-CA", { timeZone: ZONE });
      assert.equal(p.run(`mtShort(${t},${now})`), day(t) === day(now) ? d.toLocaleTimeString("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString("en-US", { timeZone: ZONE, month: "short", day: "numeric" }), `mtShort ${t} ${now}`);
    }
    assert.equal(p.run(`mtStamp(${t})`), d.toLocaleString("en-US", { timeZone: ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(",", "").replace(/\s+/g, " ") + " MT", `mtStamp ${t}`);
  }
  assert.equal(p.run("hhmm(NaN)"), new Date(NaN).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), "an invalid time reads as before");
});

test("a probe reading equal to the last one draws nothing but the clock line, a changed one draws, and the board is drawn anyway every 15 s", async () => {
  const p = await loadPage();
  let draws = 0;
  p.ctx.renderSoon = () => { draws++; p.run("renderAll()"); }; // the draw the page would make
  p.run("renderAll()"); // the board was drawn at the page's clock
  const reading = (n) => ({ v: 1, board: { boardId: "TestBoard42xyz", at: T0 - 12e3, probe: null, pageVersion: null }, cards: { c1: { num: n, phase: "build", headSha12: "a1b2c3d4e5f6", signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: T0 - 12e3 } }, agents: {} });
  const tick = (payload) => p.run(`probeEvent({type:"data",result:{payload:${JSON.stringify(payload)}}},null)`);
  tick(reading(1)); assert.equal(draws, 1, "the first reading draws");
  tick(reading(1)); tick(reading(1)); assert.equal(draws, 1, "the same reading, twice more: nothing drawn");
  tick(reading(2)); assert.equal(draws, 2, "a changed reading draws");
  p.setNow(T0 + 16e3); tick(reading(2)); assert.equal(draws, 3, "the same reading 16 s after the last draw: drawn, so the ages move");
  p.run(`probeEvent({type:"error",error:{code:"needs_reauth"}},null)`); assert.equal(draws, 4, "an error draws");
  tick(reading(2)); assert.equal(draws, 5, "the first reading after an error draws");
});
