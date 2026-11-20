// #C1331 (the owner's design, t-1795159050363): "Who is on what" is one column per agent. Each lists every open card the agent is on or has queued, as a badge with its order number
// in front (1 = on it now, then its queue in order); a badge takes the card's tile state (blinking blue working, yellow stripes queued, dark stuck); no icon inside a badge; work with
// no card is a "work" badge; the busiest agent is on the left and idle agents on the right with "idle since". The page is loaded the way the other page tests load it (no browser).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const NAMES = ["derivedOf", "liveCard", "liveAgent", "liveSubstep", "agentOn", "agentsOn", "probeEvent", "crewBy", "crewColumns", "crewColumnsHtml", "crewBadgeState", "crewBadgeTitle", "renderCrew", "queueOf", "isQueued", "notStarted", "openOrder"];
function page(cards, agents = {}) {
  const b = loadNames(NAMES, { Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(NOW); } static now() { return NOW; } } });
  Object.assign(b.state, { initRaw: [], steps: [], waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [], derived: [] });
  b.state.initiatives = cards.map((c, k) => ({ phase: "build", status: "active", nowPhases: {}, createdAt: NOW - (cards.length - k) * MIN, ...c }));
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { boardId: "TestBoard42xyz", at: NOW - 20e3, probe: null, pageVersion: null }, cards: {}, agents } } }, {});
  return b;
}
const card = (id, num, who, extra = {}) => ({ id, num, name: `Card ${num}`, who, ...extra });
const work = (cardId, since = NOW - 5 * MIN) => ({ state: "working", card: cardId, since, lastActivityAt: NOW - 20e3, tool: "Read" });
const cols = (b) => b.crewColumns(NOW).map((c) => ({ name: c.name, items: c.items.map((i) => (i.work ? "work" : `${i.card.num}:${i.state}`)) }));

test("a column lists every open card of the agent, the one it is on first, then its queue in order, numbered 1, 2, 3", () => {
  const b = page([card("on", 1, "Boardsmith"), card("q2", 3, "Boardsmith", { status: "queued", queuePos: 2 }), card("q1", 2, "Boardsmith", { status: "queued", queuePos: 1 })], { Boardsmith: work("on") });
  const c = cols(b).find((x) => x.name === "Boardsmith");
  assert.deepEqual([...c.items], ["1:now", "2:queued", "3:queued"]);
  const out = b.crewColumnsHtml(NOW);
  assert.match(out, /<span class="cn">1<\/span><span class="cb now"[^>]*>#C1<\/span>/);
  assert.match(out, /<span class="cn">2<\/span><span class="cb queued"[^>]*>#C2<\/span>/);
  assert.match(out, /<span class="cn">3<\/span><span class="cb queued"[^>]*>#C3<\/span>/);
});

test("what the agent is working on is 1 even when the card is another agent's (a review), ahead of its own cards", () => {
  const b = page([card("mine", 2, "Checker", { branch: "build/mine" }), card("rev", 9, "Builder", { branch: "build/rev", nowPhases: { checker: ["Checker"] } })], { Checker: work("rev") });
  assert.deepEqual([...cols(b).find((c) => c.name === "Checker").items], ["9:now", "2:here"]);
});

test("a badge carries only the card id: no icon, the same text shape for every state", () => {
  const b = page([card("on", 1, "Boardsmith"), card("q", 2, "Boardsmith", { status: "queued", queuePos: 1 }), card("st", 3, "Admin", { status: "stuck", branch: "build/st" })], { Boardsmith: work("on") });
  const out = b.crewColumnsHtml(NOW);
  for (const id of ["#C1", "#C2", "#C3"]) assert.match(out, new RegExp(`>${id}</span>`));
  assert.doesNotMatch(out, /[⧗⏸]/);
  assert.match(out, /<span class="cb stuck"[^>]*>#C3<\/span>/);
  assert.doesNotMatch(html.match(/\.cb\.queued[^}]*}/)[0] + html.match(/\.cb\.stuck[^}]*}/)[0], /content:/, "no ::before icon in the CSS either");
});

test("work with no card is a work badge numbered first; its hover says what the agent is doing and since when", () => {
  const b = page([card("q", 2, "Steward", { status: "queued", queuePos: 1 })], { Steward: { state: "working", card: null, since: NOW - 7 * MIN, lastActivityAt: NOW - 10e3, tool: "Bash" } });
  const c = cols(b).find((x) => x.name === "Steward");
  assert.deepEqual([...c.items], ["work", "2:queued"]);
  const out = b.crewColumnsHtml(NOW);
  assert.match(out, /<span class="cn">1<\/span><span class="cb work" tabindex="0" title="Working on something that has no card since [^"]*\(using Bash\)">work<\/span>/);
  assert.doesNotMatch(out, /no card</, "it reads work, not no card");
});

test("busiest on the left, idle agents on the right with idle since, and an agent with nothing open is a column with no badge", () => {
  const b = page([card("a1", 1, "Checker"), card("a2", 2, "Checker", { status: "queued", queuePos: 1 }), card("b1", 3, "Builder")], { Checker: work("a1"), Builder: work("b1"), Designer: { state: "idle", since: NOW - 30 * MIN, lastActivityAt: NOW - 30 * MIN }, Release: { state: "idle", since: NOW - 5 * MIN, lastActivityAt: NOW - 5 * MIN } });
  const order = cols(b).map((c) => c.name);
  assert.deepEqual([...order].slice(0, 2), ["Checker", "Builder"], "two cards before one");
  assert.ok(order.indexOf("Release") < order.indexOf("Designer"), "the most recently idle first among the idle");
  assert.ok(order.indexOf("Builder") < order.indexOf("Release"), "every idle agent is after every busy one");
  // and the other way round, so the roster's own order cannot be what put them there
  const flip = page([card("a1", 1, "Checker")], { Checker: work("a1"), Designer: { state: "idle", since: NOW - 5 * MIN, lastActivityAt: NOW - 5 * MIN }, Release: { state: "idle", since: NOW - 30 * MIN, lastActivityAt: NOW - 30 * MIN } });
  const o2 = cols(flip).map((c) => c.name);
  assert.ok(o2.indexOf("Designer") < o2.indexOf("Release"), "Designer idle more recently now, so it comes first");
  const out = b.crewColumnsHtml(NOW);
  assert.match(out, /<div class="ccol idle" data-agent="Release"><h3>Release<\/h3><small>idle since [^<]+<\/small><\/div>/);
  assert.match(out, /^<div class="ccols">/);
});

test("a card sits only in the column of the agent on it or with it queued; one that only passes through another agent is not listed there", () => {
  const idle = { state: "idle", since: NOW - MIN, lastActivityAt: NOW - MIN };
  // c3 is Boardsmith's, and the card's review phase names Checker, but the live reading has Checker idle: it only passes through Checker, so it is not in Checker's column.
  const b = page([card("c1", 1, "Boardsmith", { status: "queued", queuePos: 1 }), card("c2", 2, "Checker", { branch: "build/c2" }), card("c3", 4, "Boardsmith", { branch: "build/c3", nowPhases: { checker: ["Checker"] } })], { Boardsmith: idle, Checker: idle });
  const all = cols(b);
  assert.deepEqual([...all.find((c) => c.name === "Boardsmith").items].sort(), ["1:queued", "4:here"]);
  assert.deepEqual([...all.find((c) => c.name === "Checker").items], ["2:here"], "its own card, nobody on it: the plain ring; not Boardsmith's card passing through");
  assert.equal(all.filter((c) => c.items.some((i) => i.startsWith("1:"))).length, 1);
  assert.equal(all.filter((c) => c.items.some((i) => i.startsWith("2:"))).length, 1);
});

test("a dropped or done card is on no column, whatever the live reading last named", () => {
  const b = page([card("gone", 1, "Boardsmith", { status: "dropped" }), card("closed", 2, "Boardsmith", { status: "done" }), card("flagged", 4, "Boardsmith", { dropped: 1, branch: "build/flagged" }), card("open", 3, "Boardsmith", { branch: "build/open" })], { Boardsmith: work("gone") });
  assert.deepEqual([...cols(b).find((c) => c.name === "Boardsmith").items], ["3:here"]);
});

test("a card badge's hover gives its title, phase, since when and group", () => {
  const b = page([card("on", 1, "Boardsmith", { name: "The crew columns", batch: "board-polish-seven", phaseLog: [{ phase: "build", who: "Boardsmith", start: NOW - 3 * 60 * MIN }] })], { Boardsmith: work("on") });
  const title = /<span class="cb now" tabindex="0" title="([^"]*)">/.exec(b.crewColumnsHtml(NOW))[1];
  assert.match(title, /#C1 The crew columns/);
  assert.match(title, /Phase: [^·]*\(working now\)/);
  assert.match(title, /Since /);
  assert.match(title, /Group: [^·]*[Pp]olish/);
});

test("the markup is escaped: a hostile agent or card name shows as text", () => {
  const b = page([card("on", 1, "Boardsmith", { name: '"><img src=x onerror=alert(1)>' })], { Boardsmith: work("on") });
  const out = b.crewColumnsHtml(NOW);
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img/);
});

test("the sideways scroll, a fixed badge width and the reduced-motion rule are in the page's CSS", () => {
  assert.match(html, /\.ccols\{[^}]*overflow-x:auto/);
  assert.match(html, /\.cb\{[^}]*min-width:5\.6em/);
  assert.match(html, /prefers-reduced-motion:reduce\)\{\.cb\.now,\.cb\.work\{animation:none\}/);
  assert.match(html, /\.cb\.work\{[^}]*dashed/);
});

test("every badge has the same border box, so the dashed work badge is no taller than the others", () => {
  assert.match(html, /\.cb\{[^}]*border:1\.5px solid transparent/);
});

test("the scrolling columns fade at the right edge, with padding so the last column is not dimmed at the end", () => {
  assert.match(html, /\.ccols\{[^}]*mask-image:linear-gradient\(to right,#000 calc\(100% - 20px\),transparent\)/);
  assert.match(html, /\.ccols\{[^}]*padding:0 20px 6px 12px/);
});
