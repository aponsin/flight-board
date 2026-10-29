// ↻ Check reads the live state now; one ETA per card; one source on the status line (#C450, check-live-now: the owner
// pressed Check on #C448 and watched "checking… next Collector run ~04:15 PM" for 5+ min, the Collector now hourly; the
// card showed "Live in 18 min · around 04:32 PM" against "expected L 6 h, due ~09:05 PM", and its status line had three
// sources arguing: "IN FLIGHT · typed: phase build · Repository: Linguist · steps say Build · as of 2 min ago · checking…").
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames, step } from "./harness.mjs";

const NOW = Date.now(), MIN = 60e3, H = 36e5, ID = "rev-card";
const reading = (at) => ({
  v: 1, board: { boardId: "TestBoard42xyz", at, probe: null, pageVersion: null },
  cards: { [ID]: { num: 448, phase: "language", headSha12: "a1b2c3d4e5f6", signed: [], onMain: false, ci: "passed", ciMin: 4, liveVersion: null, at } },
  agents: { Linguist: { state: "working", lastActivityAt: at, tool: "Read", card: ID, since: at - 5 * MIN } },
});
// #C448 as the owner saw it: typed phase build, steps at build, an L card, a Check pressed, the Collector's run 50 min ago.
const card = { id: ID, num: 448, name: "Our work editor", status: "active", phase: "build", size: "L", level: "Full", who: "Builder", createdAt: NOW - 2 * H, etaLive: NOW + 18 * MIN };
function board() {
  const b = loadNames(["enrich", "gates", "initRow", "probeEvent", "pressCheck", "checkLine", "renderAll", "CONFIG"]);
  b.CONFIG.collector = { notes: { language: "refs/notes/linguist", checker: "refs/notes/checker", security: "refs/notes/security" } };
  Object.assign(b.state, {
    initRaw: [card], steps: [step(ID, "build", "Builder", "start", NOW - 2 * H)], waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [],
    checkRequests: [], derived: [{ id: "all", at: NOW - 50 * MIN, cards: { [ID]: { phase: "build", at: NOW - 50 * MIN, evidence: "READY on a1b2c3d4" } } }],
  });
  return b;
}
const row = (b) => b.initRow(b.gates(b.enrich(b.state.initRaw[0])));
// What a person reads: the hover (title) and class names aside.
const words = (html) => html.replace(/ title="[^"]*"/g, "").replace(/ class="[^"]*"/g, "");

test("a card in review, its live reading stale: ↻ Check reads it now, then one ETA, one source, never 'checking…'", async () => {
  const b = board(), calls = [];
  const mcp = { callTool: async (...a) => { calls.push(a); return { payload: reading(Date.now() - 2e3) }; } };
  b.probeEvent({ type: "data", result: { payload: reading(NOW - 5 * MIN) } }, mcp);
  const before = row(b);
  assert.match(before, /data-check="rev-card"/, "a stale reading: the button is there");
  await b.pressCheck(ID);
  assert.deepEqual(calls.map((c) => c.join()), ["Flight Board State,board_state,"], "the press read the live state, once");
  const html = row(b);
  assert.doesNotMatch(html, /checking/i);
  assert.equal(html.match(/<div class="lbl">Live in<\/div>/g)?.length, 1, "one ETA: the box");
  assert.doesNotMatch(html, /due ~|expected/, "no second due time");
  assert.match(html, /\(usually 6 h for L\)/, "the size's median, as a hint");
  assert.equal(html.match(/class="evidence/g).length, 1, "one source");
  assert.match(html, /<button type="button" class="evidence differs" data-evdiff="rev-card" aria-expanded="false" title="typed: phase build[^"]*">Live: Language<\/button> <small class="asof"[^>]*>\d+ s ago<\/small>/, "the live state with its age; the typed phase in the hover");
  assert.doesNotMatch(words(html), /typed|steps say|Repository/, "the disagreements in the hover only");
  assert.doesNotMatch(html, /data-check=/, "the live state drives the card now: no button");
});

test("without the connector, a press says what each source is: no live state, the Collector's next run", async () => {
  const b = board();
  b.state.checkRequests = [];
  await b.pressCheck(ID, NOW);
  const html = row(b);
  assert.match(html, new RegExp(`<span class="i-checked">No live state · Collector next ${new Date(NOW + 10 * MIN).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>`));
  assert.doesNotMatch(html, /checking/i);
  assert.match(html, /data-check="rev-card"/, "the button stays, to read again");
  assert.match(html, /<span class="evidence"[^>]*>Repository: Build<\/span> <small class="asof/, "the repository, as of its run (agreeing with the steps: no hover mark)");
});

test("a fresh reading already drives the card: no button and no check line, its age on the source", () => {
  const b = board();
  b.state.checkRequests = [{ id: ID, at: NOW - 3 * MIN }];
  b.probeEvent({ type: "data", result: { payload: reading(NOW - 12e3) } }, {});
  const html = row(b);
  assert.doesNotMatch(html, /data-check=|i-checked|checking/);
  assert.match(html, />Live: Language<\/button> <small class="asof"[^>]*>12 s ago</);
});

// Designer: no hover on a phone or a keyboard, so a disagreement's flag is a button that shows the hover's words in a
// muted line under the name row, and hides them again; its dashed border in --muted, not --line (1.3:1).
test("the disagreement opens and closes under the name row by a press; nothing to press without one", () => {
  const b = board();
  b.probeEvent({ type: "data", result: { payload: reading(NOW - 12e3) } }, {});
  const press = () => b.listeners.click.forEach((fn) => fn({ target: { closest: (s) => (s === "[data-evdiff]" ? { dataset: { evdiff: ID } } : null) } }));
  assert.doesNotMatch(row(b), /class="ev-diff"/, "closed at first");
  press();
  const open = row(b);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /<\/div><div class="ev-diff" id="evd-rev-card">typed: phase build · READY on a1b2c3d4<\/div>/, "under the name row, the hover's words");
  press();
  assert.doesNotMatch(row(b), /class="ev-diff"/, "a second press hides it");
  const agree = board();
  agree.state.initRaw = [{ ...card, phase: "build" }];
  assert.doesNotMatch(row(agree), /<button[^>]*class="evidence/, "no disagreement: a plain flag, nothing to press");
  assert.match(readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8"), /\.evidence\.differs\{border-style:dashed;border-color:var\(--muted\)/);
});

// (d) Manager, from Checker on this card's own render: the source said "Live: Language" while the track lit Build
// ("Builder · 2 h", the steps' open start) and Language "up next".
test("the owner's #C448 case: the track lights Language with Linguist, the reviewer the live state shows; Build isn't current", () => {
  const b = board();
  b.probeEvent({ type: "data", result: { payload: reading(NOW - 12e3) } }, {});
  const html = row(b);
  assert.match(html, /<div class="step now"[^>]*>Language<small>Linguist/, "Language lit, named");
  assert.doesNotMatch(html, /class="step[^"]*\bnow\b[^"]*"[^>]*>Build</, "Build not current");
  assert.doesNotMatch(html, /up next|Builder · /, "no 'up next', no builder's clock");
  const two = board(), later = reading(NOW - 12e3);
  later.cards[ID].phase = "checker";
  two.probeEvent({ type: "data", result: { payload: later } }, {});
  assert.match(row(two), /<div class="step now"[^>]*>Language<small>Linguist/, "the card on Checker, Linguist still on it: Linguist lights Language (its notes ref), not Checker");
  const gone = board();
  gone.probeEvent({ type: "data", result: { payload: { ...reading(NOW - 12e3), agents: {} } } }, {});
  assert.doesNotMatch(row(gone), /class="step[^"]*\bnow\b[^"]*"[^>]*>Build</, "nobody on it now: the steps' old build start still lights nothing");
});
