// #C1331 (the owner's design, t-1795159050363): "Who is on what" is one column per agent. Each lists every open card the agent is on or has queued, as a badge with its order number
// in front (1 = on it now, then its queue in order); a badge takes the card's tile state (blinking blue working, yellow stripes queued, dark stuck); no icon inside a badge; work with
// no card is a "work" badge; the busiest agent is on the left and idle agents on the right with "idle since". The page is loaded the way the other page tests load it (no browser).
// #C1384: the page no longer decides which card is in which column; it draws state.crew, the Worker's fold of the card readings (worker/reading.mjs crewColumns).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const NAMES = ["derivedOf", "liveCard", "liveAgent", "liveSubstep", "agentOn", "agentsOn", "probeEvent", "crewRoster", "crewDoc", "crewColumns", "crewColumnsHtml", "crewBadgeTitle", "renderCrew", "queueOf", "isQueued", "notStarted", "openOrder"];
// columns: { role: [entry, ...] } in the order the Worker gave; the page draws it as it is.
function page(cards, agents = {}, columns = {}) {
  const b = loadNames(NAMES, { Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(NOW); } static now() { return NOW; } } });
  Object.assign(b.state, { initRaw: [], steps: [], waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [], derived: [] });
  b.state.initiatives = cards.map((c, k) => ({ phase: "build", status: "active", nowPhases: {}, createdAt: NOW - (cards.length - k) * MIN, ...c }));
  b.state.crew = [{ id: "crew", columns }];
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { boardId: "TestBoard42xyz", at: NOW - 20e3, probe: null, pageVersion: null }, cards: {}, agents } } }, {});
  return b;
}
const card = (id, num, extra = {}) => ({ id, num, name: `Card ${num}`, ...extra });
const ent = (n, id, num, extra = {}) => ({ n, id, num, state: "build", wait: null, working: false, ...extra });
const work = (cardId, since = NOW - 5 * MIN) => ({ state: "working", card: cardId, since, lastActivityAt: NOW - 20e3, tool: "Read" });
const cols = (b) => b.crewColumns(NOW).map((c) => ({ name: c.name, items: c.items.map((i) => (i.work ? "work" : `${i.card.num}:${i.state}`)) }));

test("a column lists the entries of state.crew in the Worker's order, numbered 1, 2, 3, the working one as now", () => {
  const b = page([card("on", 1), card("q1", 2), card("q2", 3)], { Boardsmith: work("on") }, { Boardsmith: [ent(1, "on", 1, { working: true }), ent(2, "q1", 2, { state: "queued" }), ent(3, "q2", 3, { state: "queued" })] });
  assert.deepEqual([...cols(b).find((x) => x.name === "Boardsmith").items], ["1:now", "2:queued", "3:queued"]);
  const out = b.crewColumnsHtml(NOW);
  assert.match(out, /<span class="cn">1<\/span><span class="cb now"[^>]*>#C1<\/span>/);
  assert.match(out, /<span class="cn">2<\/span><span class="cb queued"[^>]*>#C2<\/span>/);
  assert.match(out, /<span class="cn">3<\/span><span class="cb queued"[^>]*>#C3<\/span>/);
});

test("a card is listed in the column its entry is in, whoever the card's own agent is (a review), the working one first", () => {
  const b = page([card("mine", 2, { who: "Builder" }), card("rev", 9, { who: "Builder" })], { Checker: work("rev") }, { Checker: [ent(1, "rev", 9, { working: true }), ent(2, "mine", 2)] });
  assert.deepEqual([...cols(b).find((c) => c.name === "Checker").items], ["9:now", "2:here"]);
});

test("a badge carries only the card id: no icon, the same text shape for every state", () => {
  const b = page([card("on", 1), card("q", 2), card("st", 3)], { Boardsmith: work("on") }, { Boardsmith: [ent(1, "on", 1, { working: true }), ent(2, "q", 2, { state: "queued" })], Admin: [ent(1, "st", 3, { state: "stuck" })] });
  const out = b.crewColumnsHtml(NOW);
  for (const id of ["#C1", "#C2", "#C3"]) assert.match(out, new RegExp(`>${id}</span>`));
  assert.doesNotMatch(out, /[⧗⏸]/);
  assert.match(out, /<span class="cb stuck"[^>]*>#C3<\/span>/);
  assert.doesNotMatch(html.match(/\.cb\.queued[^}]*}/)[0] + html.match(/\.cb\.stuck[^}]*}/)[0], /content:/, "no ::before icon in the CSS either");
});

test("work with no card is a work badge numbered first; its hover says what the agent is doing and since when", () => {
  const b = page([card("q", 2)], { Steward: { state: "working", card: null, since: NOW - 7 * MIN, lastActivityAt: NOW - 10e3, tool: "Bash" } }, { Steward: [ent(1, "q", 2, { state: "queued" })] });
  assert.deepEqual([...cols(b).find((x) => x.name === "Steward").items], ["work", "2:queued"]);
  const out = b.crewColumnsHtml(NOW);
  assert.match(out, /<span class="cn">1<\/span><span class="cb work" tabindex="0" data-ctip="Working on something that has no card since [^"]*\(using Bash\)">work<\/span>/);
  assert.doesNotMatch(out, /no card</, "it reads work, not no card");
});

test("busiest on the left, idle agents on the right with idle since, and an agent with nothing open is a column with no badge", () => {
  const idleAt = (m) => ({ state: "idle", since: NOW - m * MIN, lastActivityAt: NOW - m * MIN });
  const b = page([card("a1", 1), card("a2", 2), card("b1", 3)], { Checker: work("a1"), Builder: work("b1"), Designer: idleAt(30), Release: idleAt(5) },
    { Checker: [ent(1, "a1", 1, { working: true }), ent(2, "a2", 2, { state: "queued" })], Builder: [ent(1, "b1", 3, { working: true })] });
  const order = cols(b).map((c) => c.name);
  assert.deepEqual([...order].slice(0, 2), ["Checker", "Builder"], "two cards before one");
  assert.ok(order.indexOf("Release") < order.indexOf("Designer"), "the most recently idle first among the idle");
  assert.ok(order.indexOf("Builder") < order.indexOf("Release"), "every idle agent is after every busy one");
  // and the other way round, so the roster's own order cannot be what put them there
  const flip = page([card("a1", 1)], { Checker: work("a1"), Designer: idleAt(5), Release: idleAt(30) }, { Checker: [ent(1, "a1", 1, { working: true })] });
  const o2 = cols(flip).map((c) => c.name);
  assert.ok(o2.indexOf("Designer") < o2.indexOf("Release"), "Designer idle more recently now, so it comes first");
  const out = b.crewColumnsHtml(NOW);
  assert.match(out, /<div class="ccol idle" data-agent="Release"><h3>Release<\/h3><small>idle since [^<]+<\/small><\/div>/);
  assert.match(out, /^<div class="ccols">/);
});

test("a card is drawn only in the column of the doc it is in, not in any other", () => {
  const idle = { state: "idle", since: NOW - MIN, lastActivityAt: NOW - MIN };
  const b = page([card("c1", 1), card("c2", 2), card("c3", 4)], { Boardsmith: idle, Checker: idle }, { Boardsmith: [ent(1, "c1", 1, { state: "queued" }), ent(2, "c3", 4)], Checker: [ent(1, "c2", 2)] });
  const all = cols(b);
  assert.deepEqual([...all.find((c) => c.name === "Boardsmith").items], ["1:queued", "4:here"]);
  assert.deepEqual([...all.find((c) => c.name === "Checker").items], ["2:here"]);
  for (const n of ["1:", "2:", "4:"]) assert.equal(all.filter((c) => c.items.some((i) => i.startsWith(n))).length, 1);
});

test("a stale entry is drawn grey (read-stale) and its hover says since when", () => {
  const b = page([card("old", 5), card("new", 6)], {}, { Boardsmith: [ent(1, "old", 5, { stale: true, staleSince: NOW - 40 * MIN }), ent(2, "new", 6)] });
  const out = b.crewColumnsHtml(NOW);
  assert.match(out, /<span class="cb here read-stale"[^>]*data-ctip="[^"]*no fresh reading since \d\d:\d\d[^"]*">#C5<\/span>/);
  assert.match(out, /<span class="cb here" tabindex="0" data-ctip="((?!no fresh reading)[^"])*">#C6<\/span>/);
});

test("a badge blinks (class now) only for an entry with working:true", () => {
  const b = page([card("a", 1), card("b", 2), card("c", 3)], {}, { Boardsmith: [ent(1, "a", 1, { working: true }), ent(2, "b", 2, { state: "queued" }), ent(3, "c", 3)] });
  const out = b.crewColumnsHtml(NOW);
  assert.equal((out.match(/class="cb now/g) || []).length, 1);
  assert.match(out, /<span class="cb now"[^>]*>#C1<\/span>/);
  assert.doesNotMatch(out, /class="cb now"[^>]*>#C[23]</);
});

test("a card badge's hover gives its title, phase, since when and group", () => {
  const b = page([card("on", 1, { name: "The crew columns", batch: "board-polish-seven", phaseLog: [{ phase: "build", who: "Boardsmith", start: NOW - 3 * 60 * MIN }] })], { Boardsmith: work("on") }, { Boardsmith: [ent(1, "on", 1, { working: true })] });
  const title = /<span class="cb now" tabindex="0" data-ctip="([^"]*)">/.exec(b.crewColumnsHtml(NOW))[1];
  assert.match(title, /#C1 The crew columns/);
  assert.match(title, /Phase: [^·]*\(working now\)/);
  assert.match(title, /Since /);
  assert.match(title, /Group: [^·]*[Pp]olish/);
});

test("the markup is escaped: a hostile agent or card name shows as text", () => {
  const b = page([card("on", 1, { name: '"><img src=x onerror=alert(1)>' })], { Boardsmith: work("on") }, { Boardsmith: [ent(1, "on", 1, { working: true })] });
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

// #C1425 (the owner, t-1795565862060): the dashed "work" badge showed the browser's slow title tooltip. Every badge in the panel says its words in the board's own bubble (#cbub), with the
// words it had.
test("every badge in Who is on what carries its words as data-ctip for the board's own bubble, and none keeps a slow title", () => {
  const b = page([card("on", 1, { name: "The crew columns" }), card("q", 2)], { Boardsmith: work("on"), Steward: { state: "working", card: null, since: NOW - 7 * MIN, lastActivityAt: NOW - 10e3, tool: "Bash" } },
    { Boardsmith: [ent(1, "on", 1, { working: true }), ent(2, "q", 2, { state: "queued" })] });
  const badges = b.crewColumnsHtml(NOW).match(/<span class="cb [^>]*>/g);
  assert.equal(badges.length, 3, "two card badges and the work badge");
  for (const t of badges) { assert.match(t, / data-ctip="[^"]+"/); assert.doesNotMatch(t, / title=/); }
  assert.match(html, /const BUB_REFS="[^"]*\[data-ctip\]/, "the page's hover and focus bubble takes it");
  assert.match(html, /a\.dataset\.ctip!=null\)\{b\.textContent=a\.dataset\.ctip\}/, "its words go in as text, never markup");
});
