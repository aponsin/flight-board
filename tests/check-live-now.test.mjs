// ↻ Check reads the live state now; one ETA per card; one source on the status line (#C450, check-live-now: the owner
// pressed Check on #C448 and watched "checking… next Collector run ~04:15 PM" for 5+ min, the Collector now hourly; the
// card showed "Live in 18 min · around 04:32 PM" against "expected L 6 h, due ~09:05 PM", and its status line had three
// sources arguing: "IN FLIGHT · typed: phase build · Repository: Linguist · steps say Build · as of 2 min ago · checking…").
import test from "node:test";
import assert from "node:assert/strict";
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
  const b = loadNames(["enrich", "gates", "initRow", "probeEvent", "pressCheck", "checkLine", "renderAll"]);
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
  assert.match(html, /<span class="evidence differs" title="typed: phase build[^"]*">Live: Language<\/span> <small class="asof"[^>]*>\d+ s ago<\/small>/, "the live state with its age; the typed phase in the hover");
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
  assert.match(html, />Live: Language<\/span> <small class="asof"[^>]*>12 s ago</);
});
