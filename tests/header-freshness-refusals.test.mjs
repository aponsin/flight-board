// #C880 (audit group G; ask 1701's "Manager stuck on"): the header says when its data is old, that a newer board is live, and which writes were refused.
// (1) "Data N min" stays, and past 2 minutes reads "Data N min old" in the warning colour (the store page's own polling counts: a 304 is the data being
// current now); (2) "A newer board is live: reload" once the Worker's build, named on every poll answer, differs from the one the page loaded with;
// (3) the refusals the view carries are the page's "<who> stuck on <card>: <rule>" line, until a write for that card passes.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";
import { compatView, stuckDoc, STUCK_WINDOW_MS } from "../worker/compat-view.mjs";

const NOW = Date.now(), MIN = 60e3;
// A store page: a root element that holds what the shim writes (data-fetched-at, data-live-build) and says data-host="store".
function storePage(names, attrs = {}) {
  const attr = { "data-host": "store", ...attrs };
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", value: "", hidden: true, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 0 }) });
  const document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}),
    documentElement: { getAttribute: (k) => (k in attr ? attr[k] : null), setAttribute: (k, v) => { attr[k] = String(v); }, style: { setProperty() {} } } };
  const b = loadNames(names, { document });
  return { ...b, attr, els };
}
const reading = () => ({ v: 1, board: { boardId: "TestBoard42xyz", at: NOW - 30e3, probe: null, pageVersion: null, lastWriteAt: null }, cards: {}, agents: {} });

test("data age: fresh stays 'Data N s', past 2 minutes it says old, and a good poll (even a 304) makes it fresh", () => {
  const p = storePage(["probeEvent", "stampText", "received", "dataOld"], { "data-fetched-at": String(NOW - 20e3) });
  p.probeEvent({ type: "data", result: { payload: reading() } }, {});
  assert.equal(p.stampText(NOW), "Studio checked 30 s ago · Data 20 s", "the poll 20 s ago is the data's age");
  assert.equal(p.dataOld(NOW), false);
  p.attr["data-fetched-at"] = String(NOW - 2 * MIN - 1000);
  assert.equal(p.stampText(NOW), "Studio checked 30 s ago · Data 2 min old");
  assert.equal(p.dataOld(NOW), true);
  p.attr["data-fetched-at"] = String(NOW - 2 * MIN);
  assert.equal(p.dataOld(NOW), false, "exactly 2 minutes is not past it");
  p.attr["data-fetched-at"] = String(NOW - 1000);
  assert.equal(p.stampText(NOW), "Studio checked 30 s ago · Data 1 s", "a new poll answer resets it");
  const none = storePage(["probeEvent", "stampText", "dataOld"]);
  none.probeEvent({ type: "data", result: { payload: reading() } }, {});
  assert.equal(none.stampText(NOW), "Studio checked 30 s ago · no data yet", "no poll and no data: as before");
  assert.equal(none.dataOld(NOW), false);
});

test("a page that is not the store's reads its age from the data it holds alone, as before", () => {
  const p = storePage(["probeEvent", "stampText", "received", "dataOld"], { "data-host": "", "data-fetched-at": String(NOW) });
  p.received([{ id: "s1", at: NOW - 3 * MIN }], NOW - 3 * MIN);
  p.probeEvent({ type: "data", result: { payload: reading() } }, {});
  assert.equal(p.stampText(NOW), "Studio checked 30 s ago · Data 3 min old", "the db's age, whatever data-fetched-at says");
});

test("a newer board: the first build the page sees is its own; a different one later says so; no build says nothing", () => {
  const p = storePage(["newBoard", "liveBuild"], {});
  assert.equal(p.newBoard(), false, "no build yet");
  p.attr["data-live-build"] = "abcdef012345";
  assert.equal(p.newBoard(), false, "the first reading is the board it loaded");
  assert.equal(p.newBoard(), false, "and stays quiet while it is the same");
  p.attr["data-live-build"] = "abcdef012345";
  assert.equal(p.newBoard(), false);
  p.attr["data-live-build"] = "9a8b7c6d5e4f";
  assert.equal(p.newBoard(), true, "a different build: a deploy since");
  p.attr["data-live-build"] = "";
  assert.equal(p.newBoard(), false, "an empty header (no build set) says nothing");
  p.attr["data-live-build"] = "not-a-build";
  assert.equal(p.newBoard(), false, "a build the page cannot read says nothing");
});

test("the Worker names its build on every poll answer, the 304 included; empty when none is set", async () => {
  // The route needs the owner's identity; the header logic is read from the source so the test does not stand up Access.
  const src = (await import("node:fs")).readFileSync(new URL("../worker/board-worker.mjs", import.meta.url), "utf8");
  assert.match(src, /env\.BUILD_SHA\.slice\(0, 12\)/);
  assert.match(src, /bare\(304, \{ etag, "x-board-build": build \}\)/);
  assert.match(src, /json\(200, c, \{ etag, "cache-control": "no-store", "x-board-build": build \}\)/);
  const shim = (await import("../worker/compat-shim.mjs"));
  const text = Object.values(shim).filter((v) => typeof v === "string").join("\n");
  assert.match(text, /x-board-build/);
  assert.match(text, /data-fetched-at/);
  assert.match(text, /data-live-build/);
});

// A refusal row as the view carries it (newest first), and a card row.
const refusal = (over = {}) => ({ at: NOW - 5 * MIN, rule: "look-needs-screenshots", card_id: "c1", who: "Manager", detail: "x", ...over });
const view = (over = {}) => ({ now: NOW, cards: [{ id: "c1", title: "A card", updated_at: NOW - 60 * MIN, owner_role: "Builder" }], refusals: [], ...over });

test("a refusal naming an open card is a stuck line: the role, the card, the rule", () => {
  const d = stuckDoc(view({ refusals: [refusal()] }));
  assert.deepEqual(d, { id: "stuck", "initiatives:c1": { reason: "look-needs-screenshots", at: NOW - 5 * MIN, who: "Manager", owner: "Manager" } });
});

test("one line per role and rule, the newest; a second role on the same card keeps the card's newest line", () => {
  const rs = [refusal({ at: NOW - MIN }), refusal({ at: NOW - 9 * MIN }), refusal({ at: NOW - 3 * MIN, rule: "card-id", who: "Boardsmith", card_id: "c2" })];
  const d = stuckDoc(view({ cards: [{ id: "c1", updated_at: 0 }, { id: "c2", updated_at: 0 }], refusals: rs }));
  assert.deepEqual(Object.keys(d).sort(), ["id", "initiatives:c1", "initiatives:c2"]);
  assert.equal(d["initiatives:c1"].at, NOW - MIN, "the newest of the pair");
  const same = stuckDoc(view({ refusals: [refusal({ at: NOW - MIN, who: "Boardsmith", rule: "card-id" }), refusal({ at: NOW - 2 * MIN })] }));
  assert.equal(Object.keys(same).length, 2, "two roles refused on one card: one line, the newest");
  assert.equal(same["initiatives:c1"].who, "Boardsmith");
});

test("the line goes when a write for the card has passed since, and when the refusal is over a day old", () => {
  assert.equal(stuckDoc(view({ cards: [{ id: "c1", updated_at: NOW - 2 * MIN }], refusals: [refusal({ at: NOW - 5 * MIN })] })), null, "the card was written after the refusal");
  assert.notEqual(stuckDoc(view({ cards: [{ id: "c1", updated_at: NOW - 6 * MIN }], refusals: [refusal({ at: NOW - 5 * MIN })] })), null, "written before it: still stuck");
  const idle = [{ id: "c1", updated_at: 0 }];
  assert.equal(stuckDoc(view({ cards: idle, refusals: [refusal({ at: NOW - STUCK_WINDOW_MS - 1 })] })), null);
  assert.notEqual(stuckDoc(view({ cards: idle, refusals: [refusal({ at: NOW - STUCK_WINDOW_MS + 1000 })] })), null);
});

test("must still allow: nothing printed that the store has not checked: no card, an unknown or closed card, a name that is no role", () => {
  for (const r of [refusal({ card_id: null }), refusal({ card_id: "gone" }), refusal({ who: "<b>x" }), refusal({ who: null }), refusal({ rule: null })]) assert.equal(stuckDoc(view({ refusals: [r] })), null, JSON.stringify(r));
  for (const closed of [{ id: "c1", dropped: 1, updated_at: 0 }, { id: "c1", done_at: NOW - MIN, updated_at: 0 }]) assert.equal(stuckDoc(view({ cards: [closed], refusals: [refusal()] })), null);
  assert.equal(stuckDoc({ now: NOW }), null, "a view with neither");
});

test("the compat view carries the stuck document beside the other meta, and the page prints '<who> stuck on <card>: <rule>'", () => {
  const v = { ...view({ refusals: [refusal({ who: "Boardsmith" })] }), tag: "t", live: { state: "live", version: "1.2.3", age: 1000 }, asks: [], lists: [], evidence: {}, history: [], historyCards: [], files: [], ships: [], usage: [], threads: { messages: [], threads: [] }, stackSwitch: [], reworkHistory: [], wake: {}, probe: { state: "ok" } };
  const c = compatView({ ...v, cards: [{ id: "c1", num: 1, title: "A card", updated_at: 0, size: "S" }] });
  const stuck = (c.collections.meta ?? []).find((d) => d.id === "stuck");
  assert.ok(stuck, "meta/stuck is there");
  const p = storePage(["stuckLines", "itemOf"], {});
  p.state.meta = [stuck];
  p.state.waiting = [];
  p.state.initiatives = [{ id: "c1", name: "A card" }];
  const lines = p.stuckLines();
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^Boardsmith stuck on (A card|c1): look-needs-screenshots · Nothing for you · owner: Boardsmith$/, "the role, the card (its name, else its id), the rule");
  p.state.meta = [{ id: "stuck", "initiatives:c1": { reason: "refused three times", at: NOW } }];
  assert.match(p.stuckLines()[0].text, /^Manager stuck on (A card|c1): refused three times/, "the old gate's line, naming no role, stays the lead's");
  p.state.meta = [{ id: "stuck", "initiatives:c1": { reason: "r", at: NOW, who: "<script>" } }];
  assert.match(p.stuckLines()[0].text, /^Manager stuck on/, "a name that is no role is not printed");
});

// Checker F1 on 399fbb4 (MEDIUM): the shim counting a 304 as current data. On a quiet board most polls are 304s, so with `if (r.ok)` alone the header
// would warn "Data N min old" while the data is current. The shim's own text runs in a vm against a fake /api/compat that answers 304 to the etag.
test("the shim stamps data-fetched-at on a 304 and on a 200, names the build on both, and stamps nothing on a failed poll", async () => {
  const { default: vm } = await import("node:vm");
  const { COMPAT_SHIM } = await import("../worker/compat-shim.mjs");
  const attr = {}, calls = [];
  let status = 200;
  const headers = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
  const fetch = async (url, init = {}) => {
    calls.push(init);
    if (status === 304) return { status: 304, ok: false, headers: headers({ "x-board-build": "abc123def456" }) };
    if (status !== 200) return { status, ok: false, headers: headers({}) };
    return { status: 200, ok: true, headers: headers({ etag: '"c-1"', "x-board-build": "abc123def456" }), json: async () => ({ tag: "1", at: 1, collections: {}, probe: null }) };
  };
  const document = { hidden: false, addEventListener() {}, documentElement: { setAttribute: (k, v) => { attr[k] = String(v); } } };
  const timers = [];
  const window = {};
  vm.runInNewContext(COMPAT_SHIM, { window, fetch, document, setInterval: (f) => (timers.push(f), timers.length), JSON, Promise, Object, String, Error, Date });
  (await window.claude.use("db")).collection("waiting").onSnapshot(() => {});
  await new Promise((r) => setImmediate(r));
  assert.ok(Number(attr["data-fetched-at"]) > 0, "a 200 stamps the time");
  assert.equal(attr["data-live-build"], "abc123def456");
  // Later the poll answers 304 (nothing changed): the stamp must move and the build still be named.
  delete attr["data-fetched-at"]; delete attr["data-live-build"];
  status = 304;
  await timers[0](); await new Promise((r) => setImmediate(r));
  assert.equal(calls.at(-1).headers["if-none-match"], '"c-1"', "the poll was conditional");
  assert.ok(Number(attr["data-fetched-at"]) > 0, "a 304 is the data being current now: data-fetched-at is set");
  assert.equal(attr["data-live-build"], "abc123def456", "the 304 names the build too");
  // A failed poll is not fresh data.
  delete attr["data-fetched-at"];
  status = 500;
  await timers[0](); await new Promise((r) => setImmediate(r));
  assert.equal(attr["data-fetched-at"], undefined, "a 500 stamps nothing");
});

// Checker F2 (LOW): "one line per role and rule" is the newest refusal of that pair, on whatever card it was; an older one on another card is the same line.
test("the same role and rule refused on two cards is one line: the newest card's", () => {
  const rs = [refusal({ at: NOW - MIN, card_id: "c2" }), refusal({ at: NOW - 9 * MIN, card_id: "c1" })];
  const d = stuckDoc(view({ cards: [{ id: "c1", updated_at: 0 }, { id: "c2", updated_at: 0 }], refusals: rs }));
  assert.deepEqual(Object.keys(d).sort(), ["id", "initiatives:c2"], "the older refusal of the same role and rule adds no second line");
  const other = stuckDoc(view({ cards: [{ id: "c1", updated_at: 0 }, { id: "c2", updated_at: 0 }], refusals: [rs[0], { ...rs[1], rule: "another-rule" }] }));
  assert.deepEqual(Object.keys(other).sort(), ["id", "initiatives:c1", "initiatives:c2"], "a different rule is its own line");
});
