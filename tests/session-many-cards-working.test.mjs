// #C1427 (11-24, #C1424's audit: a session names ONE card, the newest, so Release shipping a candidate that carries four cards read working on one of them): the probe also lists the cards the session
// names in its current turn, and the reading counts a session on each of them. Fictional ids.
import test from "node:test";
import assert from "node:assert/strict";
import { cardsIn, cardIn, activity, SESSION_CARDS } from "../collector/state.mjs";
import { stateErrors, pickState } from "../collector/state-schema.mjs";
import { reading } from "../worker/reading.mjs";

const T = Date.UTC(2026, 10, 24, 22, 0);
const names = ["card-a", "card-b", "card-c", "card-d", "card-e", "card-f", "card-g", "card-h"];
const ids = new Set(names), nums = new Map(names.map((n, k) => [100 + k, n]));
const entry = (type, content, at, extra = {}) => ({ type, timestamp: new Date(at).toISOString(), message: { role: type, content, ...extra } });
const say = (text, at) => entry("assistant", [{ type: "text", text }], at);

test("cardsIn: the cards the current turn names, newest first, the first being cardIn's; one card is none (the plain card)", () => {
  const e = [entry("user", "ship #C100 and card-b", T), say("also #C102", T + 1)];
  assert.deepEqual(cardsIn(e, ids, nums), ["card-c", "card-b", "card-a"], "the newest entry's names first, later names before earlier ones");
  assert.equal(cardsIn(e, ids, nums)[0], cardIn(e, ids, nums), "the first is the card");
  assert.deepEqual(cardsIn([entry("user", "only #C100", T), say("still card-a", T + 1)], ids, nums), [], "one card named twice is one card: no list");
  assert.deepEqual(cardsIn([entry("user", "nothing here", T)], ids, nums), []);
  assert.deepEqual(cardsIn([], ids, nums), []);
});

test("cardsIn: only the current turn, never a tool's printout, never a card the board does not list, and a task notice does not start a turn", () => {
  const old = [entry("user", "do card-a", T), say("on card-b", T + 1), entry("user", "now #C102", T + 2), say("and card-d", T + 3)];
  assert.deepEqual(cardsIn(old, ids, nums), ["card-d", "card-c"], "what the session named before the last prompt is another turn");
  const result = entry("user", [{ type: "tool_result", tool_use_id: "t1", content: "git log: card-e card-f #C105" }], T + 4);
  assert.deepEqual(cardsIn([...old, result], ids, nums), ["card-d", "card-c"], "a result names no card");
  assert.deepEqual(cardsIn([entry("user", "card-a card-zzz #C999 #C101", T)], ids, nums), ["card-b", "card-a"], "an unknown id and an unknown number are no card");
  const notice = entry("user", "<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n</task-notification>", T + 5);
  assert.deepEqual(cardsIn([entry("user", "ship card-a and card-b", T), say("running", T + 1), notice], ids, nums), ["card-b", "card-a"], "the notice wakes the same work");
});

test("cardsIn: at most SESSION_CARDS, so a session that lists the board names no crowd", () => {
  const e = [entry("user", names.join(" "), T)];
  assert.equal(SESSION_CARDS, 6);
  assert.equal(cardsIn(e, ids, nums).length, SESSION_CARDS);
});

test("activity: `cards` rides with the card only for two or more; the fields it had are as before", () => {
  const a = activity([entry("user", "ship #C100 #C101", T)], { mtimeMs: T, now: T + 1000, ids, nums });
  assert.equal(a.card, "card-b");
  assert.deepEqual(a.cards, ["card-b", "card-a"]);
  const one = activity([entry("user", "only #C100", T)], { mtimeMs: T, now: T + 1000, ids, nums });
  assert.equal(one.card, "card-a");
  assert.equal("cards" in one, false, "a session on one card has the card alone");
});

test("the schema: an agent's cards is two to six board ids, optional; nothing else fits", () => {
  const state = (cards) => ({ v: 1, board: { boardId: "TestBoard42xyz", at: T, probe: null, pageVersion: null }, cards: {}, agents: { Release: { state: "working", lastActivityAt: T, tool: "Bash", card: "card-a", ...(cards === undefined ? {} : { cards }), since: T } } });
  assert.deepEqual(stateErrors(state(undefined)), [], "a probe from before it still fits");
  assert.deepEqual(stateErrors(state(["card-a", "card-b"])), []);
  for (const bad of [["card-a"], [], "card-a", ["card-a", 7], ["a b", "card-b"], names.concat("card-i").slice(0, 7)]) assert.notDeepEqual(stateErrors(state(bad)), [], JSON.stringify(bad));
  assert.deepEqual(pickState(state(["card-a", "card-b"])).agents.Release.cards, ["card-a", "card-b"], "the pick keeps it");
});

test("the reading: a session on several cards is working on each; one on a card that is not among them leaves this one waiting its turn", () => {
  const sha = "a".repeat(40), card = { id: "card-b", num: 2, repo: "flight-board", owner_role: "Boardsmith" };
  const ev = { headSha: sha, headSha12: sha.slice(0, 12), phase: "checker", lit: ["checker"], onMain: false, at: T };
  const read = (agents) => reading(card, ev, [], agents, {}, T, {});
  const rel = (extra) => ({ Checker: { state: "working", card: "card-a", ...extra } });
  assert.equal(read(rel({ cards: ["card-a", "card-b"] })).working, true, "named in the turn: Checker is on it");
  assert.equal(read(rel({ cards: ["card-a", "card-b"] })).state, "working");
  assert.equal(read(rel({})).working, false, "one card, not this one");
  assert.equal(read(rel({})).wait, "turn", "busy on another card: it waits its turn");
  assert.equal(read(rel({ cards: ["card-a", "card-b"] })).wait, null, "on this one too: not a turn wait");
  assert.equal(read(rel({ cards: ["card-a", "card-c"] })).wait, "turn", "a list without this card is another's work");
  assert.equal(read({ Checker: { state: "idle", card: "card-a", cards: ["card-a", "card-b"] } }).working, false, "an idle session is on nothing");
});
