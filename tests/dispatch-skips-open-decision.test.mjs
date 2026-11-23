// #C1073 (11-12 ~10:45 pm: Builder's watch fired "DISPATCH #C1071 ... build it" again on every re-arm, though the card had an open decision on its thread, the owner's A or B): a Decision the
// lead posts in a thread (kind "decision", options as buttons, no ask row: #C920) is a question to the owner like an open ask, so the dispatch builds nothing for its card while it is open,
// and dispatches the card again once the owner has written in the thread (or the thread's later message is marked resolved).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun, openDecisionCards } from "../collector/store-dispatch.mjs";
import { openDecisionCards as workerOpenDecisionCards, openDecisionHolds as workerOpenDecisionHolds } from "../worker/board-rules.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, wakeAsk, takeInbox } from "../worker/board-store.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Checker", "Security", "Release"], LEAD = "Manager";
const idle = { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN };
const card = (id, num, extra = {}) => ({ id, num, owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", ...extra });
const world = ({ cards, messages = [], asks = [] }) => ({
  cards, asks, threads: { messages, threads: [] }, stackSwitch: [{ repo: "board", stack: false, set_by: "default", set_at: 0 }],
  evidence: { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle])) } },
});
const who = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "dec-")), roster: ROSTER, lead: LEAD, now: NOW }).items.map((i) => `${i.card}:${i.role}:${i.step}`).sort();
const decision = (thread, body, over = {}) => ({ id: `m-${thread}-${body.length}`, thread_id: thread, author: LEAD, body, created_at: NOW - 60 * MIN, kind: "decision", resolved: 0, options: "[]", ...over });
const owner = (thread, at, over = {}) => ({ id: `o-${thread}-${at}`, thread_id: thread, author: "owner", body: "A", created_at: at, kind: null, resolved: 0, ...over });
const c1071 = card("pick-card", 1071);
const TITLE = "#C1071: which way?\n\nA or B?\n\nRecommended: A";

test("a card with a decision open on a thread is built for nobody; with the decision answered it is dispatched again", () => {
  const open = world({ cards: [c1071], messages: [decision("owner-thread", `${TITLE}\n\nCard: pick-card`)] });
  assert.deepEqual(who(open), [], "open decision: no build turn");
  const answered = world({ cards: [c1071], messages: [decision("owner-thread", `${TITLE}\n\nCard: pick-card`), owner("owner-thread", NOW - 30 * MIN)] });
  assert.deepEqual(who(answered), ["pick-card:Boardsmith:build"], "the owner wrote after it: the card is built");
  assert.deepEqual(who(world({ cards: [c1071] })), ["pick-card:Boardsmith:build"], "the control: no decision at all");
});

test("the held card does not take the owner's one build turn: the next queued card is dispatched instead", () => {
  const next = card("next-card", 1075);
  const v = world({ cards: [c1071, next], messages: [decision("t", `${TITLE}\n\nCard: pick-card`)] });
  assert.deepEqual(who(v), ["next-card:Boardsmith:build"], "the owner has an open decision on #C1071: it is woken for #C1075, not for nothing");
  v.threads.messages.push(owner("t", NOW - 10 * MIN));
  assert.deepEqual(who(v), ["pick-card:Boardsmith:build"], "answered: #C1071 is first again");
});

test("the decision names its card by the Card line, or by the one #C<n> in its first line; a decision about another card holds nothing here", () => {
  const byLine = world({ cards: [c1071], messages: [decision("t", "#C1071: which way?\n\nA or B?")] });
  assert.deepEqual(who(byLine), [], "named by #C1071 in its first line");
  const byCardLine = world({ cards: [c1071], messages: [decision("t", "Which way?\n\nA or B?\n\nCard: pick-card")] });
  assert.deepEqual(who(byCardLine), [], "named by its Card line");
  assert.deepEqual(who(world({ cards: [c1071], messages: [decision("t", "#C9999: elsewhere\n\nCard: other-card")] })), ["pick-card:Boardsmith:build"], "another card's decision");
  assert.deepEqual(who(world({ cards: [c1071], messages: [decision("t", "Which way?\n\nA or B?")] })), ["pick-card:Boardsmith:build"], "a decision that names no card holds none");
  assert.deepEqual([...openDecisionCards({ threads: { messages: [decision("t", "#C1071 and #C1072: both?")] } }, new Map([[1071, "pick-card"], [1072, "two"]]))], [], "a first line naming two cards names none (askCardId's rule)");
});

test("a decision posted in a card's own thread (thread id = the card id) with no Card line and no single #C<n> holds that card; in another card's thread it holds nothing", () => {
  assert.deepEqual(who(world({ cards: [c1071], messages: [decision("pick-card", "Which way?\n\nA or B?")] })), [], "its own thread holds it");
  assert.deepEqual(who(world({ cards: [c1071], messages: [decision("some-other-thread", "Which way?\n\nA or B?")] })), ["pick-card:Boardsmith:build"], "a thread that is no card holds nothing");
});

test("only an owner message after the decision, or a resolved one, closes it: not an earlier one, another thread's, nor the lead's own", () => {
  const dec = decision("t", `${TITLE}\n\nCard: pick-card`);
  const held = (msgs) => who(world({ cards: [c1071], messages: [dec, ...msgs] })).length === 0;
  assert.equal(held([owner("t", NOW - 90 * MIN)]), true, "an owner message BEFORE the decision does not answer it");
  assert.equal(held([owner("other-thread", NOW - 30 * MIN)]), true, "the owner wrote in another thread");
  assert.equal(held([{ ...owner("t", NOW - 30 * MIN), author: LEAD }]), true, "the lead's own later message is not the owner's answer");
  assert.equal(held([owner("t", NOW - 30 * MIN)]), false, "the owner wrote after it");
  assert.equal(held([{ ...owner("t", NOW - 30 * MIN), author: LEAD, resolved: 1 }]), false, "a later message marked resolved closes the thread");
  assert.equal(who(world({ cards: [c1071], messages: [{ ...dec, resolved: 1 }] })).length, 1, "the decision itself marked resolved");
  assert.equal(who(world({ cards: [c1071], messages: [{ ...dec, kind: null }] })).length, 1, "a plain message of the lead (no kind decision) holds nothing");
  assert.equal(who(world({ cards: [c1071], messages: [{ ...dec, author: "owner" }] })).length, 1, "a message of the owner is never a decision to the owner");
});

test("Security's L1: only the lead's decision holds a card; a decision posted by any other role holds nothing", () => {
  for (const author of ["Boardsmith", "Checker", "Security", "Release", "someone-else"]) {
    const v = world({ cards: [c1071], messages: [decision("t", `${TITLE}\n\nCard: pick-card`, { author })] });
    assert.deepEqual(who(v), ["pick-card:Boardsmith:build"], `a decision from ${author} does not park the card`);
  }
  const idByNum = new Map([[1071, "pick-card"]]), msgs = [decision("t", "#C1071: x", { author: "Boardsmith" })];
  assert.deepEqual([...openDecisionCards({ threads: { messages: msgs } }, idByNum)], [], "default lead: Manager only");
  assert.deepEqual([...openDecisionCards({ threads: { messages: [decision("t", "#C1071: x", { author: "" })] } }, idByNum, "")], [], "no lead named: fails closed, even for a message with no author");
  assert.deepEqual([...openDecisionCards({ threads: { messages: [decision("t", "#C1071: x", { author: "Boss" })] } }, idByNum, "Boss")].length, 1, "the named lead's decision holds");
});

test("openDecisionCards: pure; the cards of the open decisions, malformed rows ignored", () => {
  const idByNum = new Map([[1071, "pick-card"], [1072, "two"]]);
  const view = { threads: { messages: [decision("a", "#C1071: x"), decision("b", "y\n\nCard: two"), decision("c", "z\n\nCard: unknown-card"), null, { thread_id: 7 }, { ...decision("d", "#C1071: q"), created_at: "now" }] } };
  assert.deepEqual([...openDecisionCards(view, idByNum)].sort(), ["pick-card", "two"]);
  assert.deepEqual([...openDecisionCards({}, idByNum)], []);
  assert.deepEqual([...openDecisionCards({ threads: { messages: "x" } }, idByNum)], []);
});

test("an open decision holds a card that is already pushed too, as an open ask does (dispatchItems drops every turn of a card with an open ask)", () => {
  const pushed = { lit: ["checker"], phase: "checker", headSha12: "1".repeat(12), signed: [], onMain: false };
  const v = world({ cards: [c1071], messages: [decision("t", `${TITLE}\n\nCard: pick-card`)] });
  v.evidence["cards.pick-card"] = { readAt: NOW - 5_000, value: pushed };
  assert.deepEqual(who(v), [], "no review turn while the owner's decision is open");
  v.threads.messages.push(owner("t", NOW - 10 * MIN));
  assert.deepEqual(who(v), ["pick-card:Checker:review"], "answered: the review turn is back");
});

// ---- the Worker's copy (worker/board-rules.mjs): the same rule, so the idle-agent line never counts or names a card the dispatch holds ----
test("the Worker's copy of openDecisionCards reads the same cards as the collector's on every case above", () => {
  const cards = [{ id: "pick-card", num: 1071 }, { id: "two", num: 1072 }, { id: "three", num: 1073 }, { id: "four", num: 1074 }];
  const idByNum = new Map(cards.map((c) => [c.num, c.id]));
  const messages = [
    decision("a", "#C1071: x"), decision("b", "y\n\nCard: two"), decision("c", "z\n\nCard: unknown-card"), decision("d", "#C1071 and #C1072: both?"),
    decision("e", "#C1073: answered"), owner("e", NOW - 5 * MIN), { ...decision("f", "#C1071: resolved"), resolved: 1 }, { ...decision("g", "#C1071: not a decision"), kind: null },
    { ...decision("h", "#C1071: owner's own"), author: "owner" }, { ...decision("j", "#C1074: another role's"), author: "Checker" }, decision("four", "A plain question that names no card"), null, { thread_id: 7 }, { ...decision("i", "#C1071: bad time"), created_at: "now" },
  ];
  const mine = [...workerOpenDecisionCards(messages, cards)].sort(), theirs = [...openDecisionCards({ threads: { messages } }, idByNum)].sort();
  assert.deepEqual(mine, theirs);
  assert.deepEqual(mine, ["four", "pick-card", "two"], "four: a decision posted in the card's own thread (thread id = the card's id) that names no card holds that card");
  assert.equal(workerOpenDecisionHolds(messages, cards).get("four"), decision("four", "A plain question that names no card").id, "the holds map names the decision's message id");
  assert.deepEqual([...workerOpenDecisionCards(undefined, undefined)], []);
});

test("the stall line: a card with a decision open on a thread is not an idle agent's queued card; answered, it is again", async () => {
  const T = 1_800_000_000_000, later = T + 20 * MIN;
  // a fresh store per case: a stall row, once raised, is kept (not re-told) while it lasts, so one store cannot show "held, then back"
  const wakes = async (messages, activeAt = T) => {
    const db = makeDb();
    await createCard(db, T, "Manager", { id: "pick-card", title: "A card", owner_role: "Boardsmith" });
    await db.prepare("UPDATE cards SET num = 1071").run();
    await writeEvidence(db, T, "probe", "agents", { Boardsmith: { state: "idle", lastActivityAt: activeAt, since: T, tool: null, card: null }, Manager: { state: "working", lastActivityAt: later, since: T, tool: "Bash", card: null } });
    await db.prepare("UPDATE evidence SET read_at = ?").bind(later).run();
    for (const [id, author, at, kind, body] of messages) await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at, kind) VALUES (?, 'owner-thread', ?, ?, ?, ?)").bind(id, author, body, at, kind).run();
    const n = (await wakeAsk(db, later)).count;
    return { n, line: n ? (await takeInbox(db, later + 1)).stalls.map((s) => s.reason).join("|") : "" };
  };
  const ask = ["m1", "Manager", T + MIN, "decision", "#C1071: which way?\n\nA or B?\n\nCard: pick-card"];
  const none = await wakes([]);
  assert.equal(none.n, 1, "the control: an idle owner with a queued card wakes Manager");
  assert.match(none.line, /^Boardsmith idle since .*, 1 queued, next #C1071$/);
  // Manager's second change: held out of the dispatch and the idle count, but one row names the card and the decision, so a decision settled elsewhere cannot freeze it silently.
  // #C1412: the row's words are the card, the owner and the decision id, with no idle time in them
  const held = await wakes([ask]);
  assert.equal(held.n, 1, "an open decision holds the card out of the queue, and its row still wakes Manager");
  assert.equal(held.line, "#C1071 held by open decision m1, Boardsmith idle");
  assert.doesNotMatch(held.line, /queued/, "the held card is not counted as queued");
  assert.equal((await wakes([ask], later - MIN)).n, 0, "an owner that was active a minute ago is not idle: the held card raises no row yet");
  const other = await wakes([["m9", "Builder", T + MIN, "decision", ask[4]]]);
  assert.match(other.line, /1 queued, next #C1071$/, "a decision from another role holds nothing: the card is queued as usual, with no held row");
  const answered = await wakes([ask, ["m2", "owner", T + 5 * MIN, null, "A"]]); // (the owner's own message also wakes Manager: the stall line is what is asked)
  assert.match(answered.line, /Boardsmith idle since .*, 1 queued, next #C1071/, "answered: the card is queued again");
});

// #C1412 (#C1411 woke Manager at 11:57 and again at 12:43 on the same decision, because the row said "idle since <time>" and the time moved each time the owner ran a turn):
// the held-by-decision row is told ONCE per (card, decision id), on one store, through owner turns and a new idle time.
test("the held-by-decision row: the same decision with a new idle time raises no second wake; a new decision on the card does; answered, the card stalls again", async () => {
  const T = 1_800_000_000_000, db = makeDb();
  await createCard(db, T, "Manager", { id: "pick-card", title: "A card", owner_role: "Boardsmith" });
  await db.prepare("UPDATE cards SET num = 1071").run();
  // the probe reads every 3 minutes (a longer silence is an outage, which stops the step clocks): Boardsmith as `boardsmith` says, from the last reading to `to`; Manager working
  let last = T;
  const say = async (to, boardsmith) => {
    for (let at = last + 3 * MIN; at <= to; at += 3 * MIN) {
      await writeEvidence(db, at, "probe", "agents", { Boardsmith: { card: null, tool: null, ...boardsmith, ...(boardsmith.state === "working" ? { lastActivityAt: at } : {}) }, Manager: { state: "working", lastActivityAt: at, since: T, tool: "Bash", card: null } });
      await db.prepare("UPDATE evidence SET read_at = ?").bind(at).run();
      last = at;
    }
  };
  const post = (id, author, at, kind, body) => db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at, kind) VALUES (?, 'owner-thread', ?, ?, ?, ?)").bind(id, author, body, at, kind).run();
  const told = async (at) => { await wakeAsk(db, at); return (await takeInbox(db, at + 1)).stalls.map((s) => s.reason); };
  const body = (n) => `#C1071: which way (${n})?\n\nA or B?\n\nCard: pick-card`;
  await post("m1", "Manager", T + MIN, "decision", body(1));
  await say(T + 20 * MIN, { state: "idle", since: T, lastActivityAt: T });
  assert.deepEqual(await told(T + 20 * MIN), ["#C1071 held by open decision m1, Boardsmith idle"], "the first spell: Manager is told once");
  await say(T + 40 * MIN, { state: "working", since: T + 25 * MIN, lastActivityAt: T + 40 * MIN }); // the owner runs a turn
  assert.deepEqual(await told(T + 40 * MIN), [], "while it works nothing is told");
  await say(T + 80 * MIN, { state: "idle", since: T + 45 * MIN, lastActivityAt: T + 45 * MIN }); // idle again, a new idle time
  assert.deepEqual(await told(T + 80 * MIN), [], "the same decision with a new idle time raises no second wake");
  await say(T + 85 * MIN, { state: "idle", since: T + 45 * MIN, lastActivityAt: T + 45 * MIN });
  assert.deepEqual(await told(T + 85 * MIN), [], "nor when asked again");
  await post("m2", "Manager", T + 81 * MIN, "decision", body(2));
  await say(T + 90 * MIN, { state: "idle", since: T + 45 * MIN, lastActivityAt: T + 45 * MIN });
  assert.deepEqual(await told(T + 90 * MIN), ["#C1071 held by open decision m2, Boardsmith idle"], "a new decision on the same card tells him again");
  await post("m3", "owner", T + 95 * MIN, null, "A");
  await say(T + 100 * MIN, { state: "idle", since: T + 45 * MIN, lastActivityAt: T + 45 * MIN });
  const after = await told(T + 100 * MIN);
  assert.equal(after.length, 1, "answered: the card is no longer held");
  assert.match(after[0], /^Boardsmith idle since .*, 1 queued, next #C1071$/, "answered and the agent still idle: it stalls again as a queued card");
  await post("m4", "Manager", T + 101 * MIN, "decision", body(4));
  await say(T + 120 * MIN, { state: "idle", since: T + 45 * MIN, lastActivityAt: T + 45 * MIN });
  assert.deepEqual(await told(T + 120 * MIN), ["#C1071 held by open decision m4, Boardsmith idle"], "the hold ended and starts again: told again");
});
