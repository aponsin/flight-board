// #C927 (the owner, 11-11: a card paused until he answered showed its Checker tile solid blue, beside "repository copy 47 h 56 min old").
// Two defects: (1) the store opens a phase row from the repository's reading, and an open step made a paused card "active" with its phase
// lit; (2) a copy of a repository days old was shown on the card and told nobody: past an hour, Manager gets one stall per spell.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, readView, wakeAsk } from "../worker/board-store.mjs";
import { compatView } from "../worker/compat-view.mjs";
import { staleCopies, COPY_STALE_MS, COPY_CARD } from "../worker/board-rules.mjs";
import { evidenceJob } from "../collector/probe-evidence.mjs";
import { render } from "../scripts/fixtures.mjs";

const T = Date.now(), MIN = 60_000, HOUR = 60 * MIN;
const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const tile = (html, label) => { const m = html.match(new RegExp(`<div class="(step[^"]*)" title="(${label}[^"]*)"`)); return m && { cls: m[1], title: m[2] }; };
// The page's board for card c1 only (the card it waits for, c0, is drawn first).
const board = async (db) => { const h = render(page, compatView(await readView(db, Date.now())).collections).board, at = h.indexOf('data-card="c1"'); return at < 0 ? h : h.slice(at); };
const checker = { lit: ["checker"], phase: "checker" };
// A card paused until another card closes (a hold needs an end and a note).
const seed = async (extra = {}) => {
  const db = makeDb();
  await createCard(db, T - 5 * MIN, "Manager", { id: "c0", title: "The card the hold waits for" });
  assert.equal((await createCard(db, T - 5 * MIN, "Manager", { id: "c1", title: "A card", owner_role: "Builder", ...extra })).ok, true);
  return db;
};
const paused = { paused: 1, hold_end: "c0", next_note: "waiting on the owner" };

test("a paused card whose repository phase is checker reads paused with the still ring, not blue", async () => {
  const db = await seed(paused);
  await writeEvidence(db, T - MIN, "probe", "cards.c1", checker);
  const html = await board(db), t = tile(html, "Checker");
  assert.ok(t, "the Checker tile is drawn");
  assert.doesNotMatch(t.cls, /\bnow\b/, "not blue");
  assert.match(t.cls, /\bwaits\b/, "the still ring");
  assert.doesNotMatch(html, /<div class="step[^"]*\bnow\b[^"]*" title="(?!Build)/, "no tile of the paused card is lit");
  assert.match(html, /<span class="state paused">Paused<\/span>/);
  assert.match(html, /Checker<small>Paused<\/small>/);
});

test("a paused card stays still even with a reviewer's agent on it in the live reading", async () => {
  const db = await seed(paused);
  await writeEvidence(db, T - MIN, "probe", "agents", { Checker: { state: "working", card: "c1" } });
  await writeEvidence(db, T, "probe", "cards.c1", checker);
  const html = await board(db);
  assert.doesNotMatch(tile(html, "Checker").cls, /\bnow\b/);
  assert.match(html, /<span class="state paused">Paused<\/span>/);
});

test("a card that is not paused, with a reviewer really on it, still lights", async () => {
  const db = await seed();
  await writeEvidence(db, T - MIN, "probe", "agents", { Checker: { state: "working", card: "c1" } });
  await writeEvidence(db, T, "probe", "cards.c1", checker);
  assert.match(tile(await board(db), "Checker").cls, /\bnow\b/);
});

test("a fresh copy shows no age warning on the card; an old one writes the age", async () => {
  const fresh = await seed();
  await writeEvidence(fresh, Date.now() - 2 * MIN, "probe", "cards.c1", checker);
  assert.doesNotMatch(await board(fresh), /repository copy/);
  const old = await seed();
  await writeEvidence(old, Date.now() - 47 * HOUR, "probe", "cards.c1", checker);
  assert.match(await board(old), /repository copy 47 h/);
});

const stalls = async (db) => (await db.prepare("SELECT card_id, reason, taken_at FROM stall_wakes WHERE card_id LIKE ?").bind(`${COPY_CARD}%`).all()).results;
const sync = (db, now) => wakeAsk(db, now);

test("a copy older than 1 h raises ONE stall to Manager, and the next sync does not raise a second", async () => {
  const db = await seed({ repo: "site-one" });
  await writeEvidence(db, T - 3 * HOUR, "probe", "cards.c1", checker);
  await sync(db, T);
  const first = await stalls(db);
  assert.equal(first.length, 1);
  assert.equal(first[0].card_id, `${COPY_CARD}site-one`);
  assert.match(first[0].reason, /the probe's copy of site-one is 3 h old: a fetch may be failing, or a card's reading has stopped being rewritten/);
  await sync(db, T + 5 * MIN);
  await sync(db, T + HOUR);
  const later = await stalls(db);
  assert.equal(later.length, 1, "still one row for the spell, not one per hour");
  assert.equal(later[0].reason, first[0].reason, "the reason does not change with the hours");
});

test("a fresh copy raises no stall, and a spell that ends can raise one again", async () => {
  const db = await seed({ repo: "site-one" });
  await writeEvidence(db, T - 30 * MIN, "probe", "cards.c1", checker);
  await sync(db, T);
  assert.equal((await stalls(db)).length, 0, "30 min is not stale");
  await writeEvidence(db, T - 2 * HOUR, "probe", "cards.c1", checker);
  await sync(db, T);
  assert.equal((await stalls(db)).length, 1);
  await writeEvidence(db, T, "probe", "cards.c1", checker);
  await sync(db, T + MIN);
  assert.equal((await stalls(db)).length, 0, "read again: the spell is over");
  await sync(db, T + 3 * HOUR);
  assert.equal((await stalls(db)).length, 1, "a new spell is a new stall");
});

test("staleCopies: the oldest open reading of a repository decides; dropped, live and unread cards do not count", () => {
  const cards = [{ id: "a", repo: "site-one" }, { id: "b", repo: "site-one" }, { id: "gone", repo: "site-one", dropped: 1 }, { id: "done", repo: "site-one" }, { id: "none", repo: "site-one" }, { id: "own" }];
  const evidence = { a: checker, b: checker, gone: checker, done: { lit: ["live"] }, own: checker };
  const readAt = { a: T - 10 * MIN, b: T - 2 * HOUR, gone: T - 90 * HOUR, done: T - 90 * HOUR, own: T - 5 * MIN };
  const out = staleCopies({ now: T, cards, evidence, readAt });
  assert.deepEqual(out.map((s) => s.card_id), [`${COPY_CARD}site-one`], "the board's own repository is fresh");
  assert.match(out[0].reason, /site-one is 2 h old/);
  assert.equal(staleCopies({ now: T, cards, evidence, readAt: { a: T - COPY_STALE_MS } }).length, 0, "exactly an hour is not over it");
  // #C902: a card closed as done (done_at) does not count, as a dropped one; Still allowed: the same card open (done_at null) does.
  const closed = { id: "closed", repo: "site-two", done_at: T - 80 * HOUR };
  assert.deepEqual(staleCopies({ now: T, cards: [closed], evidence: { closed: checker }, readAt: { closed: T - 80 * HOUR } }), [], "a done card's old reading is not a stale copy");
  assert.deepEqual(staleCopies({ now: T, cards: [{ ...closed, done_at: null }], evidence: { closed: checker }, readAt: { closed: T - 80 * HOUR } }).map((s) => s.card_id), [`${COPY_CARD}site-two`]);
});

test("the evidence job says so when the state child read a copy it could not fetch (the failed fetch was silent)", async () => {
  const lines = [];
  const state = (checked) => JSON.stringify({ v: 1, board: { boardId: "b", at: T, cardsCheckedAt: checked }, cards: {}, agents: {} });
  const run = (s) => evidenceJob({ job: "evidence", base: "https://x.example", headers: {}, configPath: "/c", stateFile: "/s/state.json", build: async () => {}, ghCheck: () => true,
    read: (p) => { if (p === "/c") return JSON.stringify({ collector: { repoPath: "/r" } }); if (p === "/s/state.json") return s; throw new Error("none"); },
    deployRead: async () => ({ worker: "", tree: "" }), liveFetch: async () => ({ ok: false, status: 500 }), fetchImpl: async () => ({ ok: true, status: 200 }), log: (l) => lines.push(l) });
  await run(state(T - 40 * MIN));
  assert.ok(lines.some((l) => /repository copy not fresh: a fetch failed.*40 min ago/.test(l)), lines.join(" | "));
  lines.length = 0;
  await run(state(T - 30_000));
  assert.ok(!lines.some((l) => /not fresh/.test(l)), "a fresh read says nothing");
});
