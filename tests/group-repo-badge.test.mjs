// #C1293 (the owner): a group row carries the same repo badge its cards carry, so a group reads as the platform repo or flight-board at a glance, folded or open.
// A group is cut per repo, so the badge is its first card's repo, drawn by the one repoBadge a card row uses.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const NAMES = ["groupRow", "gates", "enrich", "probeEvent", "state", "repoBadge"];
function board(initRaw) {
  const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(NAMES, { document });
  Object.assign(b.state, { initRaw, initiatives: initRaw.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [] });
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 20e3 }, cards: {}, agents: {} } } }, {});
  return () => b.groupRow("g5-thing", b.state.initiatives);
}
const card = (id, num, repo) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", who: "Boardsmith", repo, batch: "g5-thing", createdAt: 1_800_000_000_000 + num * 60e3 });
const head = (html) => html.split('<div class="g-rail">')[0];

test("a group of flight-board cards carries the flight-board badge beside its Group tag", () => {
  const html = board([card("a", 1, "flight-board"), card("b", 2, "flight-board")])();
  assert.match(head(html), /<span class="g-tag">Group<\/span><span class="c-repo fb"[^>]*>[^<]*<\/span> <strong>/);
});

test("a group of the other repo's cards carries that repo's badge, not the board's", () => {
  const html = board([card("a", 1, "platform"), card("b", 2, "platform")])();
  const m = head(html).match(/<span class="g-tag">Group<\/span><span class="(c-repo[^"]*)"/);
  assert.ok(m, "a repo badge follows the Group tag");
  assert.ok(!m[1].includes("fb"), "not the flight-board look");
});
