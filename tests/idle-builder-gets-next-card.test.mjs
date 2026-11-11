// #C910: an idle builder with nothing in review is woken with its next card (the first of its queue that can start), and the stall batch
// says it once per idle agent ("Boardsmith idle since 07:31Z, 22 queued, next #C901"), not once per queued card.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun } from "../collector/store-dispatch.mjs";
import { stalledWaits, STALL_AFTER_MS } from "../worker/board-rules.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard, writeEvidence, wakeAsk, takeInbox } from "../worker/board-store.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3, T = NOW;
const ROSTER = ["Manager", "Builder", "Checker"], LEAD = "Manager";
const hhmm = (ms) => `${new Date(ms).toISOString().slice(11, 16)}Z`;

// Builder idle 20 min with queued cards (nothing pushed); `cards` are overrides by number.
const view = (cards, asks = []) => ({
  cards: cards.map((o, i) => ({ id: `c${900 + i}-q`, num: 900 + i, owner_role: "Builder", waiting_on: null, paused: 0, dropped: 0, queue_pos: i + 1, ...o })),
  asks,
  evidence: { agents: { readAt: NOW - 10_000, value: { Builder: { state: "idle", lastActivityAt: NOW - 20 * MIN, since: NOW - 20 * MIN, card: null }, Manager: { state: "idle", lastActivityAt: NOW, since: NOW, card: null } } } },
});
const woken = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "ibg-")), roster: ROSTER, lead: LEAD, now: NOW }).items.map((i) => i.card);

test("the idle builder is woken with its lowest queue_pos card", () => {
  assert.deepEqual(woken(view([{ queue_pos: 3 }, { queue_pos: 1 }, { queue_pos: 2 }])), ["c901-q"]);
});

// The root cause: the single turn went to the first card of the queue before dispatchItems dropped a card with an open ask or one waiting
// on someone else, so the builder was woken for nothing and every other queued card had lost its turn.
test("a first card with an open ask, or waiting on someone else, does not take the builder's only turn", () => {
  const asked = [{ id: "a1", card_id: "c900-q", closed_at: null, answered_at: null }];
  assert.deepEqual(woken(view([{}, {}, {}], asked)), ["c901-q"], "open ask on the first card");
  assert.deepEqual(woken(view([{ waiting_on: "Security: a verdict" }, {}, {}])), ["c901-q"], "first card waits on someone else");
  assert.deepEqual(woken(view([{ waiting_on: "Builder: a decision" }, {}])), ["c900-q"], "waiting on the builder itself is startable");
});

test("a held card (hold_end, depends_on not live) is skipped; the next startable card is woken", () => {
  assert.deepEqual(woken(view([{ hold_end: "a9" }, { depends_on: JSON.stringify(["c902-q"]) }, {}])), ["c902-q"]);
});

test("22 queued cards wake the builder for exactly one", () => {
  assert.equal(woken(view(Array.from({ length: 22 }, () => ({})))).length, 1);
});

// The stall batch.
const idle = { Builder: { state: "idle", since: T } };
const queued = (n, o = () => ({})) => Array.from({ length: n }, (_, i) => ({ id: `q${i}`, num: 901 + i, owner_role: "Builder", updated_at: T, queue_pos: i + 1, ...o(i) }));
const stalls = (cards, agents = idle) => stalledWaits({ now: T + STALL_AFTER_MS, cards, evidence: {}, agents, openAskCards: new Set(), phaseStart: new Map() });

test("the stall batch has one line per idle agent: idle since, how many queued, the next card", () => {
  const r = stalls(queued(22));
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, `Builder idle since ${hhmm(T)}, 22 queued, next #C901`);
  assert.equal(r[0].card_id, "q0");
});

test("the next card is the first of the queue, the owner's placement first at one place; held cards are not counted", () => {
  assert.match(stalls(queued(3, (i) => ({ queue_pos: 3 - i })))[0].reason, /3 queued, next #C903$/);
  assert.match(stalls(queued(2, () => ({ queue_pos: 1 })).map((c, i) => (i === 1 ? { ...c, queue_set_by: "owner" } : c)))[0].reason, /next #C902$/);
  assert.match(stalls(queued(3, (i) => (i === 0 ? { waiting_on: "Security: x" } : {})))[0].reason, /2 queued, next #C902$/);
});

test("two idle agents are two lines", () => {
  const cards = [...queued(2), { id: "k", num: 950, owner_role: "Linguist", updated_at: T }];
  const r = stalls(cards, { ...idle, Linguist: { state: "idle", since: T } });
  assert.deepEqual(r.map((s) => s.role).sort(), ["Builder", "Linguist"]);
});

test("end to end: 22 queued cards of an idle builder reach Manager's inbox as one line, once", async () => {
  const db = makeDb();
  for (let i = 0; i < 22; i++) await createCard(db, T, "Manager", { id: `card-${i}`, title: `Queued ${i}`, owner_role: "Boardsmith", queue_pos: i + 1 });
  await writeEvidence(db, T, "probe", "agents", { Boardsmith: { state: "idle", tool: null, card: null, since: T } });
  assert.equal((await wakeAsk(db, T + 15 * MIN)).count, 1, "one pending line, not 22");
  const got = (await takeInbox(db, T + 16 * MIN)).stalls;
  assert.equal(got.length, 1);
  assert.match(got[0].reason, new RegExp(`^Boardsmith idle since ${hhmm(T)}, 22 queued, next #C\\d+$`));
  assert.equal((await wakeAsk(db, T + 60 * MIN)).count, 0, "sent once");
});

// Checker F1 on f0798e6: the store wiring. If queue_pos or queue_set_by left syncStalls' SELECT, the line would name the next card by number.
const numOf = async (db, id) => (await db.prepare("SELECT num FROM cards WHERE id = ?").bind(id).first()).num;
const lineOf = async (db) => { await writeEvidence(db, T, "probe", "agents", { Boardsmith: { state: "idle", tool: null, card: null, since: T } }); await wakeAsk(db, T + 15 * MIN); return (await takeInbox(db, T + 16 * MIN)).stalls[0].reason; };

test("end to end: the next card is the lowest queue_pos, not the lowest number", async () => {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "low-num-late", title: "A", owner_role: "Boardsmith", queue_pos: 5 });
  await createCard(db, T, "Manager", { id: "high-num-first", title: "B", owner_role: "Boardsmith", queue_pos: 1 });
  await createCard(db, T, "Manager", { id: "high-num-second", title: "C", owner_role: "Boardsmith", queue_pos: 2 });
  assert.ok((await numOf(db, "low-num-late")) < (await numOf(db, "high-num-first")), "the setup: the late card has the lower number");
  assert.equal(await lineOf(db), `Boardsmith idle since ${hhmm(T)}, 3 queued, next #C${await numOf(db, "high-num-first")}`);
});

test("end to end: at one place the owner's own placement is the next card, whatever the numbers", async () => {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "agent-placed", title: "A", owner_role: "Boardsmith", queue_pos: 1 });
  await createCard(db, T, "Manager", { id: "owner-placed", title: "B", owner_role: "Boardsmith", queue_pos: 2 });
  const placed = await updateCard(db, T, "owner", { id: "owner-placed", queue_pos: 1 });
  assert.ok(!placed?.refused, "the owner places the card at the same place as the agent's");
  assert.equal((await db.prepare("SELECT queue_set_by FROM cards WHERE id = 'owner-placed'").first()).queue_set_by, "owner");
  assert.ok((await numOf(db, "agent-placed")) < (await numOf(db, "owner-placed")), "the setup: the agent's card has the lower number");
  assert.equal(await lineOf(db), `Boardsmith idle since ${hhmm(T)}, 2 queued, next #C${await numOf(db, "owner-placed")}`);
});
