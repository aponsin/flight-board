// #C749: the old board's history for the switch-time rerun: usage days, the Shipped feed, the done cards' steps and the threads closed
// in the window. Run against the real migrations (SQLite), twice: a row the store holds is never changed.
import test from "node:test";
import assert from "node:assert/strict";
import { planHistory, historySql } from "../collector/import-history.mjs";
import { deltaSql } from "../collector/import-delta.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";

const NOW = 1_794_336_590_090, DAY = 86_400_000;
const empty = { insert: [], history: [], setRepo: [], counterC: 745 };
const have = (extra = {}) => ({ usageDays: new Set(), shipVersions: new Set(), historyCardIds: new Set(), cardIds: new Set(), messageIds: new Set(), threadIds: new Set(), cardsByNum: new Map(), ...extra });
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
const run = async (db, h) => { let changes = 0; for (const l of historySql(h, q)) changes += (await db.prepare(l).run()).meta.changes; return changes; };
const count = async (db, t) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n;

const docs = () => ({
  usage: { "2026-10-31": { day: "2026-10-31", runnerMin: 82, actionsMin: 14, actionsUsd: 0.11 }, "2026-11-09": { day: "2026-11-09", runnerMin: 1, actionsMin: 1, actionsUsd: 1 }, bad: { day: "x", runnerMin: -1 } },
  events: {
    "v1.206.3": { at: NOW - 2 * DAY, cards: ["form-draft", "ship-places"], version: "1.206.3" },
    "v1.60.1": { at: NOW - 5 * DAY, text: "Live: #C100 fixed, #C999 too", version: "v1.60.1" },
    "board-v3.51": { at: NOW - DAY, kind: "live", text: "Board v3.51 live" },
    "v1.209.1": { at: NOW - DAY, cards: ["other"], version: "1.209.1" },
    old: { at: NOW - 90 * DAY, cards: ["x"], version: "1.1.1" },
  },
  initiatives: {
    C547: { name: "Old numbered card", num: 547, status: "done", doneAt: NOW - 3 * DAY, createdAt: NOW - 9 * DAY, size: "S", level: "Quick" },
    "dropped-one": { name: "Dropped", status: "done", dropped: true, doneAt: NOW - DAY },
    "still-open": { name: "Open", status: "active" },
  },
  steps: {
    a: { init: "C547", phase: "build", kind: "start", at: NOW - 4 * DAY, who: "Builder" },
    b: { init: "C547", phase: "build", kind: "end", at: NOW - 4 * DAY + 60_000, who: "Builder", wait: "busy" },
    c: { init: "known-done", phase: "checker", kind: "start", at: NOW - DAY, who: "Designer" },
    d: { init: "running-card", phase: "build", kind: "start", at: NOW - DAY, who: "Builder" },
    e: { init: "no-such-card", phase: "build", kind: "start", at: NOW - DAY, who: "Builder" },
    f: { init: "C547", phase: "nonsense", kind: "start", at: NOW - DAY },
    g: { init: "C547", phase: "ship", kind: "start", at: NOW - DAY, wait: "odd" },
  },
  threads: { "t-res": { num: 900, title: "Closed" }, "t-open": { num: 901 } },
  messages: {
    m1: { thread: "t-res", from: "Manager", text: "hello", at: NOW - 2 * DAY },
    m2: { thread: "t-res", from: "Owner", text: "done", at: NOW - DAY, resolved: true },
    m3: { thread: "t-open", from: "Manager", text: "open", at: NOW - DAY },
    m4: { thread: "t-old", from: "Owner", text: "long ago", at: NOW - 90 * DAY, resolved: true },
    m5: { thread: "t-res2", from: "Owner", text: "bad\u0000text", at: NOW - DAY, resolved: true },
  },
});

test("usage: new days only, never over a day the store holds; ships: a version per event, the store's untouched; a bad row is refused", () => {
  const h = planHistory(docs(), { now: NOW, days: 30, have: have({ usageDays: new Set(["2026-11-09"]), shipVersions: new Set(["1.209.1"]), cardsByNum: new Map([[100, "card-100"]]) }) });
  assert.deepEqual(h.usage, [{ day: "2026-10-31", runner_minutes: 82, automation_minutes: 14, actions_usd: 0.11 }]);
  assert.equal(h.report.usage.held, 1);
  assert.equal(h.report.usage.refused.length, 1);
  assert.deepEqual(h.ships.map((s) => s.version), ["1.60.1", "1.206.3"]);
  assert.equal(h.ships.find((s) => s.version === "1.60.1").cards, JSON.stringify(["card-100"]), "a #C number the store knows becomes its card");
  assert.equal(h.report.ships.unmatchedNumbers, 1);
  assert.equal(h.report.ships.notAVersion, 1);
  assert.equal(h.report.ships.held, 1);
  assert.equal(h.report.ships.outsideWindow, 1);
});

test("steps: only a done card's, with its wait column, an uppercase old id lower-cased; a running card, an unknown card, an unknown phase or wait are counted not written", () => {
  const h = planHistory(docs(), { now: NOW, days: 30, have: have({ historyCardIds: new Set(["known-done"]), cardIds: new Set(["running-card"]) }) });
  assert.deepEqual(h.historyCards.map((c) => [c.id, c.num, c.title, c.size, c.review_level]), [["c547", 547, "Old numbered card", "S", "Quick"]]);
  assert.deepEqual(h.report.historyCards, { new: 1, held: 0, notDone: 2, refused: 0 });
  assert.deepEqual(h.steps.map((s) => [s.card_id, s.phase, s.kind, s.who, s.wait]).sort(), [["c547", "build", "end", "Builder", "busy"], ["c547", "build", "start", "Builder", null], ["known-done", "checker", "start", "Designer", null]]);
  assert.equal(h.report.steps.notDoneCard, 1);
  assert.equal(h.report.steps.noCardOnTheStore, 1);
  assert.equal(h.report.steps.refused, 2);
  assert.equal(h.report.steps.waits, 1);
});

test("resolved: a thread closed in the window brings all its messages and its #T row; one outside the window or with a control character does not; an existing message is only flagged", () => {
  const h = planHistory(docs(), { now: NOW, days: 30, have: have({ messageIds: new Set(["m2"]) }) });
  assert.deepEqual(h.messages.map((m) => [m.id, m.resolved]), [["m1", 0]]);
  assert.deepEqual(h.resolve, ["m2"], "m2 is in the store already: its resolved flag is set");
  assert.deepEqual(h.threads.map((t) => [t.id, t.num]), [["t-res", 900]]);
  assert.equal(h.report.resolved.threads, 1);
  assert.equal(h.report.resolved.refused, 1, "the message with a control character");
});

test("the SQL runs on the real migrations, adds what is missing, and a second run changes nothing", async () => {
  const db = makeDb();
  await db.prepare("INSERT INTO usage_days (day, runner_minutes, automation_minutes, actions_usd) VALUES ('2026-11-09', 55, 10, 0.08)").run();
  await db.prepare("INSERT INTO ships (version, cards, shipped_at) VALUES ('1.209.1', '[\"c722\"]', 5)").run();
  await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES ('m2', 't-res', 'Owner', 'done', 1)").run();
  await db.prepare("INSERT INTO history_cards (id, title, done_at) VALUES ('known-done', 'K', 1)").run();
  const mk = () => planHistory(docs(), { now: NOW, days: 30, have: have({ usageDays: new Set(["2026-11-09"]), shipVersions: new Set(["1.209.1"]), historyCardIds: new Set(["known-done"]), cardIds: new Set(["running-card"]), messageIds: new Set(["m2"]) }) });
  const first = await run(db, mk());
  assert.ok(first > 0);
  assert.equal(await count(db, "usage_days"), 2);
  assert.deepEqual((await db.prepare("SELECT runner_minutes FROM usage_days WHERE day = '2026-11-09'").first()).runner_minutes, 55, "the probe's day is untouched");
  assert.deepEqual((await db.prepare("SELECT cards FROM ships WHERE version = '1.209.1'").first()).cards, '["c722"]');
  assert.equal(await count(db, "ships"), 3);
  assert.equal(await count(db, "phase_history"), 3);
  assert.equal((await db.prepare("SELECT wait FROM phase_history WHERE wait IS NOT NULL").first()).wait, "busy");
  assert.equal((await db.prepare("SELECT resolved FROM messages WHERE id = 'm2'").first()).resolved, 1);
  assert.equal(await count(db, "history_cards"), 2);
  assert.equal(await count(db, "threads"), 1);
  assert.equal(await run(db, mk()), 0, "a second run changes nothing");
});

test("through deltaSql: the history lines come after the asks and before the appended lines", () => {
  const h = planHistory(docs(), { now: NOW, days: 30, have: have() });
  const lines = deltaSql(empty, null, "UPDATE cards SET repo = 'x' WHERE id = 'y';", h).split("\n");
  const firstUsage = lines.findIndex((l) => l.startsWith("INSERT OR IGNORE INTO usage_days"));
  assert.ok(firstUsage > 0);
  assert.equal(lines.at(-1), "UPDATE cards SET repo = 'x' WHERE id = 'y';");
});
