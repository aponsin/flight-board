// #C1379: a closed card of a product repository that never read live (it closed at "ship" under #C1104 part 2) is read again until a run reads it live, so its stored
// reading carries its live state and version. A board card, a dropped card, one already read live, one closed long ago and one with no repository word are not read.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cardStates, rereadClosed, REREAD_DONE_MS, closedLiveFrom, closedLiveNext, openStates } from "../collector/state.mjs";
import { boardTruth } from "../collector/readings.mjs";

const NOW = 1_800_000_000_000;
const cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
const done = (id, repo, extra = {}) => ({ id, num: 1, status: "done", repo, doneAt: NOW - 86_400_000, ...extra });

test("the rule: a done, named, non-board card inside its window that has not read live", () => {
  assert.equal(rereadClosed(done("a", "widgets"), new Set(), NOW), true);
  assert.equal(rereadClosed(done("a", "acme/widgets.git"), new Set(), NOW), true);
  assert.equal(rereadClosed(done("a", "widgets"), new Set(["a"]), NOW), false, "it read live: done");
  assert.equal(rereadClosed(done("a", "widgets"), ["a"], NOW), false, "a list works as a set");
  assert.equal(rereadClosed(done("a", "flight-board"), new Set(), NOW), false, "a board card's install and live stay as they were");
  assert.equal(rereadClosed(done("a", "board"), new Set(), NOW), false);
  assert.equal(rereadClosed(done("a", undefined), new Set(), NOW), false, "no repository word: not a named product card");
  assert.equal(rereadClosed(done("a", "  "), new Set(), NOW), false);
  assert.equal(rereadClosed({ ...done("a", "widgets"), status: "dropped" }, new Set(), NOW), false);
  assert.equal(rereadClosed({ ...done("a", "widgets"), status: "active" }, new Set(), NOW), false, "an open card is read as always");
  // The bound (Manager): stop after it reads live, or 14 days after done_at, whichever comes first. Both ends.
  assert.equal(REREAD_DONE_MS, 14 * 86_400_000);
  assert.equal(rereadClosed(done("a", "widgets", { doneAt: NOW - REREAD_DONE_MS }), new Set(), NOW), true, "on the last day it is still read");
  assert.equal(rereadClosed(done("a", "widgets", { doneAt: NOW - REREAD_DONE_MS - 1 }), new Set(), NOW), false, "closed past the window: never read forever");
  assert.equal(rereadClosed(done("a", "widgets", { doneAt: NOW - 1000 }), new Set(["a"]), NOW), false, "read live inside the window: stops at once");
  assert.equal(rereadClosed(done("a", "widgets", { doneAt: undefined }), new Set(), NOW), false);
});

test("cardStates reads the open cards and the closed product cards that have not read live, and no others", () => {
  const cards = [
    { id: "open", num: 1, status: "active", repo: "widgets" },
    done("early", "widgets"), done("lived", "widgets"), done("boardc", "flight-board"), done("bare", undefined),
    { ...done("gone", "widgets"), status: "dropped" }, done("old", "widgets", { doneAt: NOW - REREAD_DONE_MS - 1000 }),
  ];
  const out = cardStates({ cards, config: cfg, repos: {}, now: NOW, closedLive: new Set(["lived"]) });
  assert.deepEqual(Object.keys(out).sort(), ["early", "open"]);
  assert.deepEqual(Object.keys(cardStates({ cards, config: cfg, repos: {}, now: NOW })).sort(), ["early", "lived", "open"], "with no memory every closed product card in its window is read once");
});

// Checker 2's F2 on 653321f5: the run loop's closed-live.json read and write are pure functions now, each held by a test that fails when it is dropped.
const sha12 = "a1b2c3d4e5f6";
const reading = (phase, onMain = true) => ({ phase, onMain, headSha12: sha12 });

test("closedLiveFrom reads the ids a closed-live.json names, and nothing from a file that is not ours", () => {
  assert.deepEqual([...closedLiveFrom('{"ids":["a","b"]}')].sort(), ["a", "b"]);
  assert.deepEqual([...closedLiveFrom('{"ids":["a",5,null,"b"]}')].sort(), ["a", "b"], "only strings");
  for (const bad of ["", "not json", "{}", '{"ids":"a"}', "null", "[]"]) assert.equal(closedLiveFrom(bad).size, 0, JSON.stringify(bad));
});

test("closedLiveNext: the ids to write after a run, or null when nothing changed", () => {
  const cards = [done("early", "widgets"), done("lived", "widgets"), done("boardc", "flight-board"), done("old", "widgets", { doneAt: NOW - REREAD_DONE_MS - 1000 }), { id: "open", num: 2, status: "active", repo: "widgets" }];
  const states = { early: reading("live"), lived: reading("live"), boardc: reading("live"), old: reading("live"), open: reading("live") };
  const next = (extra) => closedLiveNext({ cards, closedLive: new Set(["lived"]), states, livePhase: "live", now: NOW, ...extra });
  assert.deepEqual(next(), ["lived", "early"], "the one that read live this run joins the memory; a board card, an old card and an open card never do");
  assert.equal(next({ states: { ...states, early: reading("ship") } }), null, "a card not reading live adds nothing: no write");
  assert.equal(next({ states: { ...states, early: reading("build") } }), null, "only the live phase counts, not any phase");
  assert.equal(next({ states: {} }), null);
  assert.deepEqual(next({ closedLive: ["lived"] }), ["lived", "early"], "a list works as a set");
  assert.deepEqual(next({ closedLive: new Set() }).sort(), ["early", "lived"], "with no memory, both closed product cards that read live join it");
});

test("the run loop calls them: the memory is read and written through the pure functions, and the truth lines and the evidence clock get open states only", () => {
  const src = readFileSync(new URL("../collector/state.mjs", import.meta.url), "utf8");
  for (const wired of ["closedLive = closedLiveFrom(r.text)", "const next = closedLiveNext({ cards, closedLive, states: cardsNow, livePhase: c.livePhase, now });", "if (next) writeAtomic(closedLivePath, JSON.stringify({ ids: next }))", "boardTruth({ states: openStates(cards, cardsNow)", "evidenceAt(openStates(cards, cardsNow)", "stackCache, closedLive })"]) assert.ok(src.includes(wired), wired);
});

test("a re-read closed card that reads live is no CLOSE line for the lead's watch: boardTruth is given the open cards' states only (Checker 2's F1)", () => {
  const cards = [done("early", "widgets"), { id: "open1", num: 3, status: "active", repo: "widgets", who: "Builder", etaLive: 1 }];
  const states = { early: reading("live"), open1: reading("live") };
  const given = openStates(cards, states);
  assert.deepEqual(Object.keys(given), ["open1"], "the closed card's reading is not an open card's");
  const openCards = cards.filter((c) => c.status !== "done");
  const bad = boardTruth({ states, shipPhase: "ship", livePhase: "live", cards: openCards });
  assert.ok(bad.some((i) => i.card === "early"), "this is the failure: the closed card reads live and on main, so it would print CLOSE");
  assert.deepEqual(boardTruth({ states: given, shipPhase: "ship", livePhase: "live", cards: openCards }).map((i) => `${i.kind}:${i.card}`), ["close:open1"]);
  // 25 closed cards reading live must not push the real lines out of the limit of 20.
  const many = Array.from({ length: 25 }, (_, i) => done(`closed${String(i).padStart(2, "0")}`, "widgets"));
  const all = [...many, { id: "zship", num: 4, status: "active", repo: "widgets", who: "Builder", etaLive: 1 }];
  const st = { ...Object.fromEntries(many.map((c) => [c.id, reading("live")])), zship: reading("ship", false) };
  const kept = boardTruth({ states: openStates(all, st), shipPhase: "ship", livePhase: "live", cards: all.filter((c) => c.status !== "done") });
  assert.deepEqual(kept.map((i) => `${i.kind}:${i.card}`), ["ship:zship"], "the real SHIP line is kept");
});
