// #C1381 (one-reading-module step 2): the Worker serves each card's reading and the groups and crew folded from them, and the fold laws of the contract (section B) hold on a
// recorded live view (tests/fixtures/view-recorded.json: the open cards of the live board and 25 recently closed ones, evidence and agents as read, names made neutral) and on
// copies of it with readings made stale and sessions put on cards. The page does not read the new collections yet (step 3): nothing drawn changes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compatView } from "../worker/compat-view.mjs";
import { readingDocs, groupDocs, CLOSED_WINDOW_MS } from "../worker/compat-reading.mjs";
import { groupReading, crewColumns, tileAt, tileOf, TILE_ORDER, STRIP, STATES, WAITS, kindOf } from "../worker/reading.mjs";

const VIEW = JSON.parse(readFileSync(new URL("./fixtures/view-recorded.json", import.meta.url), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
const served = (v) => compatView(v).collections;
const isOpen = (d) => !d.closed && d.state !== "done";

// The laws, over one served view: returns nothing, throws on the first that fails.
function laws(view, label) {
  const c = served(view), docs = c.readings, byId = new Map(docs.map((d) => [d.id, d]));
  const rowOf = new Map(view.cards.map((k) => [k.id, k]));
  // Served: every open card and every card closed in the last 7 days, once each.
  const want = view.cards.filter((k) => !k.dropped && (!k.done_at || view.now - k.done_at <= CLOSED_WINDOW_MS)).map((k) => k.id).sort();
  assert.deepEqual(docs.map((d) => d.id).sort(), want, `${label}: the served set`);
  const agents = view.evidence.agents.value;
  for (const d of docs) {
    assert.ok(STATES.includes(d.state), `${label}: ${d.id} state ${d.state}`);
    assert.ok(d.wait === null || WAITS.includes(d.wait), `${label}: ${d.id} wait ${d.wait}`);
    const e = view.evidence[`cards.${d.id}`]?.value;
    if (d.state === "done") assert.ok(d.phase === "live" || !e?.headSha, `${label}: done implies live: ${d.id}`);
    if (kindOf(rowOf.get(d.id), {}) === "product") assert.ok(d.wait !== "pack" && d.wait !== "install", `${label}: a product card has no pack or install: ${d.id}`);
    assert.ok(!(d.stale === true && d.state === "unknown" && "staleSince" in d), `${label}: stale and unknown never both: ${d.id}`);
    if (d.stale === true) assert.equal(d.working, false, `${label}: a stale reading is not working: ${d.id}`);
    // A blinking badge has a working agent (a session on the card, or CI / a ship run going).
    if (d.working === true) assert.ok(agents[d.with]?.state === "working" && agents[d.with].card === d.id || e?.ci === "queued" || e?.shipping === true, `${label}: working has a worker: ${d.id}`);
  }
  // Crew: every open card in exactly one column, the one of the role it is with; no closed or done card in any.
  const columns = c.crew[0].columns, seen = new Map();
  for (const [role, list] of Object.entries(columns)) for (const it of list) { assert.ok(!seen.has(it.id), `${label}: ${it.id} is in two columns`); seen.set(it.id, role); assert.equal(it.working, byId.get(it.id).working, `${label}: badge ${it.id}`); }
  for (const d of docs) {
    if (isOpen(d)) assert.equal(seen.get(d.id), d.with, `${label}: ${d.id} sits under its role`);
    else assert.ok(!seen.has(d.id), `${label}: ${d.id} is done or closed and in a column`);
  }
  for (const list of Object.values(columns)) list.forEach((it, i) => assert.equal(it.n, i + 1, `${label}: numbers run 1..n`));
  // Groups: a group's tile at each phase is the fold of its members' tiles (all agree: that tile; else the first in TILE_ORDER), counted over the members' readings.
  for (const g of c.groups) {
    // #C1417: a closed member is a done member and holds no tile.
    const members = g.members.map((id) => byId.get(id)).map((m) => (m.closed === true && m.state !== "done" ? { ...m, state: "done" } : m));
    assert.equal(g.count, members.length); assert.equal(g.done, members.filter((m) => m.state === "done").length);
    for (const p of STRIP) {
      const tiles = members.map((m) => tileAt(m, p)), all = new Set(tiles);
      const expected = all.size === 1 ? tiles[0] : TILE_ORDER.find((t) => all.has(t));
      assert.equal(g.tiles[p], expected, `${label}: group ${g.id} at ${p}`);
    }
  }
}

test("the Worker serves readings, groups and crew, and the laws hold on the recorded view", () => {
  laws(VIEW, "recorded");
  const c = served(VIEW);
  assert.ok(c.readings.length >= 50 && c.groups.length >= 5, "a real view has real groups");
  assert.ok(c.readings.some((d) => d.state === "waiting") && c.readings.some((d) => d.state === "done"), "more than one state is served");
});

test("the laws hold when every reading is stale, stale with no earlier good one, or has a session on it", () => {
  const stale = clone(VIEW), never = clone(VIEW), busy = clone(VIEW);
  for (const [k, e] of Object.entries(stale.evidence)) if (k.startsWith("cards.")) e.value = { ...e.value, stale: true, staleSince: VIEW.now - 3600e3 };
  for (const [k, e] of Object.entries(never.evidence)) if (k.startsWith("cards.")) e.value = { ...e.value, stale: true };
  for (const k of busy.cards) busy.evidence.agents.value[k.owner_role] = { state: "working", card: k.id };
  laws(stale, "stale"); laws(never, "never read fresh"); laws(busy, "busy");
  assert.ok(served(stale).readings.every((d) => d.working === false), "a stale reading is never working");
  assert.ok(served(never).readings.filter((d) => d.state !== "queued" && d.state !== "done").every((d) => d.state === "unknown"), "a stale reading with no earlier good one is unknown");
});

test("a product repository's cards have no pack or install, and a closed card that has not read live is in no crew column but keeps its reading", () => {
  const c = served(VIEW), product = c.readings.filter((d) => d.repo && !/flight-board|board/.test(d.repo));
  assert.ok(product.length > 0);
  for (const d of product) assert.ok(d.wait !== "pack" && d.wait !== "install", d.id);
  const closedNotLive = c.readings.filter((d) => d.closed && d.state !== "done");
  assert.ok(closedNotLive.length > 0, "the recorded view holds closed cards that read ship (the audit's 71)");
  for (const d of closedNotLive) assert.ok(!Object.values(c.crew[0].columns).flat().some((it) => it.id === d.id), d.id);
});

test("the window: a card closed 6 days ago is served, one closed 8 days ago and a dropped card are not", () => {
  const v = clone(VIEW), base = v.cards.find((k) => !k.done_at && !k.dropped);
  const add = (id, over) => v.cards.push({ ...base, id, num: 9000 + v.cards.length, batch: null, ...over });
  add("closed-six", { done_at: v.now - 6 * 86_400_000 }); add("closed-eight", { done_at: v.now - 8 * 86_400_000 }); add("dropped-one", { dropped: 1 });
  const ids = served(v).readings.map((d) => d.id);
  assert.ok(ids.includes("closed-six")); assert.ok(!ids.includes("closed-eight")); assert.ok(!ids.includes("dropped-one"));
  assert.equal(CLOSED_WINDOW_MS, 7 * 86_400_000);
});

test("groupReading: cards that agree give that tile, cards that differ give the first in TILE_ORDER, the count is members done of members", () => {
  const r = (phase, state, wait = null, extra = {}) => ({ id: "x", phase, state, wait, working: false, ...extra });
  const g = groupReading([r("checker", "waiting", "turn"), r("checker", "waiting", "turn")]);
  assert.equal(g.tiles.checker, "wait"); assert.equal(g.tiles.build, "done"); assert.equal(g.tiles.ship, "future"); assert.equal(g.count, 2); assert.equal(g.done, 0);
  const mixed = groupReading([r("checker", "waiting", "turn"), r("checker", "working", null, { working: true }), r("live", "done")]);
  assert.equal(mixed.tiles.checker, "working", "working comes before a wait");
  assert.equal(mixed.tiles.ship, "future", "a group is as far along as its least-finished card: a card at checker has not reached ship, and future comes before done in TILE_ORDER");
  assert.equal(mixed.tiles.build, "done", "every card is past build");
  assert.equal(mixed.done, 1); assert.equal(mixed.phase, "checker", "a group is as far along as its least-finished card");
  const stuck = groupReading([r("build", "stuck"), r("build", "working", null, { working: true })]);
  assert.equal(stuck.tiles.build, "stuck", "stuck first");
  assert.deepEqual(groupReading([]).count, 0);
  assert.equal(groupReading([r("live", "done"), r("live", "done")]).phase, "live");
  assert.equal(tileOf(r("ship", "waiting", "pack")), "afterwork"); assert.equal(tileOf(r("ship", "waiting", "ask")), "ask"); assert.equal(tileOf(r("ship", "waiting", "land")), "wait");
});

test("groupReading: a closed member counts as done and never holds a tile, the phase or the lead (#C1417: board-roll-1's Checker tile held by a closed card still read sent back)", () => {
  const r = (phase, state, wait = null, extra = {}) => ({ id: "x", phase, state, wait, working: false, ...extra });
  const closedStuck = r("checker", "rework", null, { closed: true, closedAt: 1 });
  const g = groupReading([closedStuck, r("ship", "waiting", "pack")]);
  assert.equal(g.tiles.checker, "done", "the open card is past Checker; the closed card's old reading does not hold it");
  assert.equal(g.tiles.ship, "afterwork", "the open card's own tile at ship");
  assert.equal(g.phase, "ship", "the phase is the open card's");
  assert.equal(g.count, 2); assert.equal(g.done, 1, "the closed card is a done member");
  assert.equal(g.state, "waiting", "the lead is the open card");
  const same = groupReading([closedStuck, r("checker", "waiting", "turn")]);
  assert.equal(same.tiles.checker, "wait", "an open card at a wait still holds its tile");
  const allClosed = groupReading([closedStuck, r("build", "waiting", "turn", { closed: true })]);
  assert.ok(STRIP.every((p) => allClosed.tiles[p] === "done"), "a group of only closed cards is done at every phase");
  assert.equal(allClosed.done, 2); assert.equal(allClosed.phase, "live");
  assert.equal(groupReading([r("checker", "rework", null, { closed: false })]).tiles.checker, "wait", "closed: false is an open card");
  assert.equal(closedStuck.state, "rework", "the input reading is not changed");
});

test("crewColumns: one column per role, the card a session is on is number 1, a stale card never blinks, done and closed cards are in none", () => {
  const rows = [
    { id: "a", num: 2, state: "waiting", wait: "turn", with: "Checker", working: false },
    { id: "b", num: 3, state: "working", wait: null, with: "Checker", working: true },
    { id: "c", num: 1, state: "waiting", wait: "pack", with: "Release", working: false, stale: true, staleSince: 5 },
    { id: "d", num: 4, state: "done", wait: null, with: "Release", working: false },
    { id: "e", num: 5, state: "waiting", wait: "deploy", with: "Release", working: false, closed: true },
  ];
  const cols = crewColumns(rows);
  assert.deepEqual(cols.Checker.map((i) => `${i.n}:${i.id}:${i.working}`), ["1:b:true", "2:a:false"]);
  assert.deepEqual(cols.Release.map((i) => i.id), ["c"]);
  assert.equal(cols.Release[0].stale, true); assert.equal(cols.Release[0].staleSince, 5);
});

test("the served docs name the card, its group and its repository beside the reading, and the closed flag marks a store-closed card", () => {
  const docs = readingDocs(VIEW), d = docs.find((x) => x.batch) ?? docs[0];
  for (const k of ["id", "num", "phase", "state", "wait", "with", "working", "since", "asOf", "why"]) assert.ok(k in d, k);
  assert.ok(docs.some((x) => x.closed === true) && docs.some((x) => !x.closed));
  assert.deepEqual(groupDocs(docs).map((g) => g.id), [...new Set(docs.filter((x) => x.batch).map((x) => x.batch))].sort());
});

test("nothing else in the compat answer changes: the old collections are still there", () => {
  const c = served(VIEW);
  for (const k of ["initiatives", "waiting", "derived"]) assert.ok(Array.isArray(c[k]), k);
  assert.equal(c.initiatives.length >= VIEW.cards.length, true);
});
