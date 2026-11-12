// #C971 (check five board parts, part 3: queue place): an agent's queue on its cards must match the dispatch order. The
// dispatch (collector/store-dispatch.mjs) skips a card held by an open card it depends on, and the Crew tile (queueTile)
// puts it after the cards that can start; the card's own line and its "queued · Boardsmith · 1st" still put it first.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const T = Date.now();
const card = (num, id, extra) => ({ id, num, name: id, size: "S", status: "active", phase: "plan", who: "Boardsmith", createdAt: T - num * 1e3, ...extra });
const cards = (depPhase) => [
  card(500, "held-first", { queuePos: 1, dependsOn: ["the-dependency"] }),
  card(501, "free-second", { queuePos: 2 }),
  card(502, "free-third", { queuePos: 3 }),
  card(400, "the-dependency", { who: "Builder", phase: depPhase, branch: "the-dependency" }),
];
function board(depPhase) {
  const b = loadNames(["queueOf", "queueLabel", "queueLine", "queueTile", "heldByDeps"]);
  Object.assign(b.state, { steps: [], derived: [], waiting: [], ideas: [], messages: [], threads: [], initRaw: cards(depPhase), initiatives: cards(depPhase) });
  return b;
}
const of = (b, id) => b.state.initiatives.find((i) => i.id === id);

test("a card held by an open dependency is placed after the cards that can start, on its line and its label, as the dispatch does", () => {
  const b = board("build");
  assert.equal(b.heldByDeps(of(b, "held-first")), true);
  assert.deepEqual([...b.queueOf("Boardsmith")].map((i) => i.num), [501, 502, 500]);
  assert.equal(b.queueLabel(of(b, "free-second")), "queued · Boardsmith · 1st", "the dispatch wakes Boardsmith for #C501 first");
  assert.equal(b.queueLabel(of(b, "held-first")), "queued · Boardsmith · 3rd");
  assert.match(b.queueLine(of(b, "held-first")), /#C501<\/a> → <a[^>]*>#C502<\/a> → <b>this<\/b><\/span>$/);
});

test("once the dependency is live it holds nothing: the owner's order stands again", () => {
  const b = board("live");
  assert.equal(b.heldByDeps(of(b, "held-first")), false);
  assert.deepEqual([...b.queueOf("Boardsmith")].map((i) => i.num), [500, 501, 502]);
  assert.equal(b.queueLabel(of(b, "held-first")), "queued · Boardsmith · 1st");
});
