// ↻ Check on every open card, whatever the live state reads (#C495, the owner: "the whole check thing is for me to have
// an easy to ask 'hey what's going with this initiative, anything stuck?'"). Since #C450 a card the live state drove
// lost it, so on the board only cards with no branch yet kept it (#C489 and #C490, with branches, had none).
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, step } from "./harness.mjs";

const NOW = Date.now(), MIN = 60e3, H = 36e5;
const at = NOW - 12e3;
const live = (cards) => ({ v: 1, board: { boardId: "TestBoard42xyz", at, probe: null, pageVersion: null }, cards, agents: {} });
const reading = (num, phase, headSha12) => ({ num, phase, headSha12, signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at });
// The board at 02:39Z: #C489 in ship with a branch (the live state reads it), #C485 in plan with none, #C493 done.
const cards = [
  { id: "work-category-row", num: 489, name: "Category row", status: "active", phase: "ship", size: "S", level: "Quick", who: "Release", createdAt: NOW - 2 * H },
  { id: "faster-ships-ci", num: 485, name: "Faster ships", status: "active", phase: "plan", size: "S", level: "Quick", who: "Builder", createdAt: NOW - 2 * H },
  { id: "owner-deploy-not-cancelled", num: 493, name: "Owner deploy", status: "done", phase: "live", size: "XS", level: "Full", who: "Release", createdAt: NOW - 2 * H, doneAt: NOW - 20 * MIN },
];
function board() {
  const b = loadNames(["enrich", "gates", "initRow", "probeEvent", "pressCheck", "renderAll", "CONFIG"]);
  b.CONFIG.collector = { notes: { checker: "refs/notes/checker" } };
  Object.assign(b.state, {
    initRaw: cards, steps: [step("work-category-row", "build", "Builder", "start", NOW - H)], waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [],
    checkRequests: [], derived: [{ id: "all", at: NOW - 30 * MIN, cards: {} }],
  });
  b.probeEvent({ type: "data", result: { payload: live({ "work-category-row": reading(489, "ship", "b6b06dfc352a"), "faster-ships-ci": reading(485, "plan", null) }) } }, {});
  return b;
}
const row = (b, id) => b.initRow(b.gates(b.enrich(b.state.initRaw.find((i) => i.id === id))));
const button = (num) => new RegExp(`<button type="button" class="c-num i-check" data-check="[^"]+"[^>]*>#C${num}<span class="i-ic" aria-hidden="true">↻</span></button>`);

test("#C495: a card the live state reads keeps its Check, as one with no branch does; its live line is unchanged", () => {
  const b = board();
  const read = row(b, "work-category-row");
  assert.match(read, button(489), "#C489, read live with its branch: the button");
  assert.match(read, />Live: Ship<\/(?:span|button)> <small class="asof"[^>]*>12 s ago</, "the live line as it was");
  assert.match(row(b, "faster-ships-ci"), button(485), "#C485, no branch: the button, as before");
});

test("#C495: pressing it on a card the live state reads asks the Collector and reads the live state again", async () => {
  const b = board(), calls = [];
  const mcp = { callTool: async (...a) => { calls.push(a); return { payload: live({ "work-category-row": reading(489, "ship", "b6b06dfc352a") }) }; } };
  b.probeEvent({ type: "data", result: { payload: live({ "work-category-row": reading(489, "ship", "b6b06dfc352a") }) } }, mcp);
  b.dbRef = {};
  const writes = [];
  b.applyWrites = async (ws) => { writes.push(...ws); };
  await b.pressCheck("work-category-row", NOW);
  assert.equal(calls.length, 1, "one fresh read");
  assert.match(row(b, "work-category-row"), button(489), "still there after the press");
});

test("#C495: a done card's number stays plain text", () => {
  const html = row(board(), "owner-deploy-not-cancelled");
  assert.doesNotMatch(html, /data-check=/);
  assert.match(html, /<span class="t-numtxt c-num" title="Card number">#C493<\/span>/);
});
