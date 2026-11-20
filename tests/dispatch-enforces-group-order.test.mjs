// #C1103 (the owner, 2026-11-16: Boardsmith worked g13 while g3, g10 and g6 waited, because Manager sent the work by hand): a role does not start a card of a lower group
// while a higher group has an open card of the same role that is the role's turn. The rule (worker/board-rules.mjs), the first-push check (scripts/group-order-check.mjs),
// the queue file it reads (collector/store-dispatch.mjs) and the store's line for work already under way.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { groupOrderBlock, ownerTurn, orderCards, outOfOrderWork, orderLine, ORDER_ROW_END } from "../worker/board-rules.mjs";
import { stackQueueFile } from "../collector/store-dispatch.mjs";
import { outOfOrderPushes } from "../scripts/group-order-check.mjs";
import { createCard, writeEvidence } from "../worker/board-store.mjs";
import { wakeAsk, takeInbox, beat } from "./helpers/beating-store.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const order = [{ batch: "g6", pos: 1 }, { batch: "g17", pos: 2 }, { batch: "g13", pos: 3 }];
const card = (id, num, group, o = {}) => ({ id, num, owner_role: "Boardsmith", group, held: false, turn: true, ...o });

test("allowed in order: a card of the first group starts whatever lower groups hold", () => {
  assert.equal(groupOrderBlock(card("a", 1, "g6"), [card("a", 1, "g6"), card("b", 2, "g17"), card("c", 3, "g13")], order), null);
});

test("refused out of order: the block names the higher card, the highest group first and the queue order inside it", () => {
  const cards = [card("x", 9, "g13"), card("b", 2, "g17"), card("a2", 6, "g6", { queue_pos: 5 }), card("a1", 7, "g6", { queue_pos: 2 })];
  assert.deepEqual(groupOrderBlock(cards[0], cards, order), { id: "a1", num: 7, group: "g6" });
  assert.deepEqual(groupOrderBlock(card("x", 9, "g17"), [card("b", 2, "g6"), card("x", 9, "g17")], order), { id: "b", num: 2, group: "g6" });
  assert.deepEqual(groupOrderBlock(card("x", 9, "g13"), [card("x", 9, "g13"), card("b", 4, "g17")], order), { id: "b", num: 4, group: "g17" }, "the next group up blocks too");
});

test("allowed when the higher group has nothing for that role: another role's card, a card not the role's turn, a held card, a card of the same group", () => {
  const x = card("x", 9, "g13");
  assert.equal(groupOrderBlock(x, [x, card("o", 1, "g6", { owner_role: "Builder" })], order), null, "another role");
  assert.equal(groupOrderBlock(x, [x, card("o", 1, "g6", { turn: false })], order), null, "at review: not the role's turn");
  assert.equal(groupOrderBlock(x, [x, card("o", 1, "g6", { held: true })], order), null, "held");
  assert.equal(groupOrderBlock(x, [x, card("o", 1, "g13")], order), null, "the same group");
  assert.equal(groupOrderBlock(x, [x, card("o", 1, "")], order), null, "a card in no group ranks after every group");
  assert.equal(groupOrderBlock(card("x", 9, ""), [card("x", 9, ""), card("o", 1, "g6")], order)?.id, "o", "a card in no group is below every group");
});

test("the owner's order is the order: moving a group up lets its card start, and the group that was first is now the blocked one", () => {
  const cards = [card("a", 1, "g6"), card("c", 3, "g13")];
  assert.equal(groupOrderBlock(cards[1], cards, order)?.id, "a");
  const moved = [{ batch: "g13", pos: 1 }, { batch: "g6", pos: 2 }];
  assert.equal(groupOrderBlock(cards[1], cards, moved), null);
  assert.equal(groupOrderBlock(cards[0], cards, moved)?.id, "c");
  assert.equal(groupOrderBlock(card("n", 8, "g20"), [card("n", 8, "g20"), card("c", 3, "g13")], moved)?.id, "c", "a group nobody placed sorts after every placed one");
});

test("ownerTurn: not pushed, in build or in rework is the owner's; review, ship and live are not", () => {
  const pushed = (phase, o = {}) => ({ lit: [phase], phase, headSha12: "a".repeat(12), ...o });
  assert.equal(ownerTurn({}, undefined), true);
  assert.equal(ownerTurn({}, pushed("build")), true);
  assert.equal(ownerTurn({}, pushed("checker")), false);
  assert.equal(ownerTurn({}, pushed("ship")), false);
  assert.equal(ownerTurn({}, pushed("live")), false);
  assert.equal(ownerTurn({}, pushed("checker", { findings: ["checker"] })), true, "findings: back with the owner");
  assert.equal(ownerTurn({}, pushed("ship", { rework: true })), true);
  assert.equal(ownerTurn({ rework_reason: "review findings" }, pushed("ship", { rework: true })), false, "the reason attached: rework is under way, not owed");
});

test("the queue file carries the number, whose turn it is and the owner's order, and the first push reads it", () => {
  const view = {
    cards: [{ id: "high", num: 1106, owner_role: "Boardsmith", batch: "g6", repo: "flight-board" }, { id: "low", num: 1063, owner_role: "Boardsmith", batch: "g13", repo: "flight-board" }],
    evidence: {}, groupOrder: [{ batch: "g6", pos: 1, set_by: "owner", set_at: 1 }, { batch: "g13", pos: 2, set_by: "owner", set_at: 1 }],
  };
  const q = stackQueueFile(view, T);
  assert.deepEqual(q.groups, [{ batch: "g6", pos: 1 }, { batch: "g13", pos: 2 }]);
  assert.deepEqual(q.cards.map((c) => [c.id, c.num, c.turn]), [["high", 1106, true], ["low", 1063, true]]);
  const git = (id) => () => `${id}\n`;
  const first = `refs/heads/build/low abc refs/heads/build/low ${"0".repeat(40)}`;
  const bad = outOfOrderPushes(first, git("low"), q, T + MIN);
  assert.equal(bad.length, 1);
  assert.deepEqual(bad[0].block, { id: "high", num: 1106, group: "g6" });
  assert.equal(bad[0].num, 1063);
  assert.deepEqual(outOfOrderPushes(`refs/heads/build/high abc refs/heads/build/high ${"0".repeat(40)}`, git("high"), q, T + MIN), [], "the higher card starts freely");
});

// #C1372: two groups nobody placed rank by their #G numbers in the queue file too, so the first-push check agrees with the dispatch and the page: the card of
// board-polish-thirteen (made first) may start, the card of board-polish-fourteen (made after, "fourteen" before "thirteen" by letters) waits for it.
test("the queue file carries an unplaced group's #G number, and the first push reads it: the newer group waits for the older whatever the letters say", () => {
  const view = {
    cards: [{ id: "old", num: 1, owner_role: "Boardsmith", batch: "board-polish-thirteen", repo: "flight-board" }, { id: "new", num: 2, owner_role: "Boardsmith", batch: "board-polish-fourteen", repo: "flight-board" }],
    evidence: {}, groupOrder: [], groupNames: [{ batch: "board-polish-thirteen", num: 112, name: null }, { batch: "board-polish-fourteen", num: 113, name: null }],
  };
  const q = stackQueueFile(view, T);
  assert.deepEqual(q.groups, [{ batch: "board-polish-thirteen", num: 112 }, { batch: "board-polish-fourteen", num: 113 }]);
  const git = (id) => () => `${id}\n`;
  const bad = outOfOrderPushes(`refs/heads/build/new abc refs/heads/build/new ${"0".repeat(40)}`, git("new"), q, T + MIN);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].block.id, "old");
  assert.deepEqual(outOfOrderPushes(`refs/heads/build/old abc refs/heads/build/old ${"0".repeat(40)}`, git("old"), q, T + MIN), []);
});

// Checker 2's M2: the pre-push check and the store's stall line read "held" the same way (orderCards: paused, waiting_on or a blocked_reason, a dependency not live).
test("a higher card held by waiting_on, a dependency not live, a pause or a block does not block the push, as in the store; an unheld one does", () => {
  const first = `refs/heads/build/low abc refs/heads/build/low ${"0".repeat(40)}`;
  const groups = [{ batch: "g6", pos: 1, set_by: "owner", set_at: 1 }, { batch: "g13", pos: 2, set_by: "owner", set_at: 1 }];
  const blocked = (high, extraCards = []) => {
    const view = { cards: [{ id: "high", num: 1106, owner_role: "Boardsmith", batch: "g6", repo: "flight-board", ...high }, { id: "low", num: 1063, owner_role: "Boardsmith", batch: "g13", repo: "flight-board" }, ...extraCards], evidence: {}, groupOrder: groups };
    return outOfOrderPushes(first, () => "low\n", stackQueueFile(view, T), T + MIN).length;
  };
  assert.equal(blocked({}), 1, "an unheld higher card blocks");
  assert.equal(blocked({ waiting_on: "the owner's answer", check_at: T + 60 * MIN }), 0, "waiting_on with a check date holds it");
  assert.equal(blocked({ paused: 1 }), 0, "paused");
  assert.equal(blocked({ blocked_reason: "waits on a deploy", hold_end: "dep" }), 0, "blocked");
  assert.equal(blocked({ depends_on: JSON.stringify(["dep"]) }, [{ id: "dep", num: 1000, owner_role: "Builder", repo: "flight-board" }]), 0, "a dependency that is not live holds it");
});

// The owner's pick A (11-16, Checker 2's M1): the group order decides only which NEW work starts. Rework (a card sent back with findings) and the next card of a group that
// already started come first, as the dispatch's agentRank has them; a fresh start below a higher ready group is still refused. Same rule in both doors.
test("A: rework on a lower group and the next card of a started group are allowed; a fresh start below a higher ready group is refused", () => {
  const Z = "0".repeat(40), first = (id) => `refs/heads/build/${id} abc refs/heads/build/${id} ${Z}`;
  const rows = (extra = []) => [{ id: "high", num: 1106, owner_role: "Boardsmith", batch: "g6", repo: "flight-board" }, { id: "low", num: 1063, owner_role: "Boardsmith", batch: "g13", repo: "flight-board" }, ...extra];
  const gate = (cards, evidence, id) => outOfOrderPushes(first(id), () => `${id}\n`, stackQueueFile({ cards, evidence, groupOrder: [{ batch: "g6", pos: 1 }, { batch: "g13", pos: 2 }] }, T), T + MIN).length;
  assert.equal(gate(rows(), {}, "low"), 1, "a fresh start below a higher ready group: refused");
  // (b) g13 already started by another card: its next card is allowed.
  const started = { "cards.g13-first": { value: { lit: ["checker"], phase: "checker", headSha12: "a".repeat(12) } } };
  assert.equal(gate(rows([{ id: "g13-first", num: 1062, owner_role: "Boardsmith", batch: "g13", repo: "flight-board" }]), started, "low"), 0, "the next card of a started group");
  // the started group's own first card does not count for itself: with only "low" pushed, a second unpushed g13 card is the next card, but "low" itself was a fresh start
  assert.equal(gate(rows(), { "cards.low": { value: { lit: ["build"], phase: "build", headSha12: "b".repeat(12) } } }, "low"), 1, "a card's own push does not start its group for itself");
  // (a) a card sent back with checker findings is rework, whatever its group.
  const sentBack = { "cards.low": { value: { lit: ["checker"], phase: "checker", headSha12: "b".repeat(12), findings: ["checker"] } } };
  const rowsBack = rows();
  const view = { cards: rowsBack, evidence: sentBack, groupOrder: [{ batch: "g6", pos: 1 }, { batch: "g13", pos: 2 }] };
  const q = stackQueueFile(view, T);
  assert.deepEqual(q.cards.map((c) => [c.id, c.rework, c.groupStarted]), [["high", false, false], ["low", true, false]]);
  // the real path (Checker 2's M1 on a7442d70): a rework card first-pushed on a re-cut build/ branch gets through; the same card read as no rework is refused
  assert.equal(outOfOrderPushes(first("low"), () => "low\n", q, T + MIN).length, 0, "a rework card's first push on a re-cut branch");
  assert.equal(outOfOrderPushes(first("low"), () => "low\n", { ...q, cards: q.cards.map((c) => ({ ...c, rework: false })) }, T + MIN).length, 1, "without the rework flag it is refused");
  // the same for a card of a started group, through the queue file's groupStarted
  const startedView = { cards: rows([{ id: "g13-first", num: 1062, owner_role: "Boardsmith", batch: "g13", repo: "flight-board" }]), evidence: started, groupOrder: view.groupOrder };
  assert.equal(outOfOrderPushes(first("low"), () => "low\n", stackQueueFile(startedView, T), T + MIN).length, 0);
  assert.equal(outOfOrderPushes(first("low"), () => "low\n", { ...stackQueueFile(startedView, T), cards: stackQueueFile(startedView, T).cards.map((c) => ({ ...c, groupStarted: false })) }, T + MIN).length, 1, "without groupStarted it is refused");
  // a queue file from before orderHeld (LOW): `held` is what says the higher card is held
  const oldQ = (heldHigh) => { const f = stackQueueFile({ cards: rows(), evidence: {}, groupOrder: view.groupOrder }, T); return { ...f, cards: f.cards.map((c) => { const { orderHeld: _o, ...rest } = c; return { ...rest, held: c.id === "high" && heldHigh }; }) }; };
  assert.equal(outOfOrderPushes(first("low"), () => "low\n", oldQ(true), T + MIN).length, 0, "an older queue file's held higher card does not block");
  assert.equal(outOfOrderPushes(first("low"), () => "low\n", oldQ(false), T + MIN).length, 1, "and an unheld one still does");
  // the store's line: the same two cases are not named
  const evidence = (extra = {}) => ({ high: { lit: ["build"], phase: "build", headSha12: "a".repeat(12) }, ...extra });
  const go = (cards, ev) => outOfOrderWork({ cards, evidence: ev, agents: { Boardsmith: { state: "working", card: "low" } }, groupOrder: order }).map((s) => s.num);
  assert.deepEqual(go(rows(), evidence({ low: { lit: ["build"], phase: "build", headSha12: "b".repeat(12) } })), [1063], "a fresh start worked out of order is named");
  assert.deepEqual(go(rows(), evidence({ low: { lit: ["build"], phase: "build", headSha12: "b".repeat(12), rework: true } })), [], "rework (a rework with no reason attached): not named");
  assert.deepEqual(go(rows(), evidence({ low: { lit: ["checker"], phase: "checker", headSha12: "b".repeat(12), findings: ["checker"] } })), [], "sent back with checker findings: not named");
  assert.deepEqual(go(rows([{ id: "g13-first", num: 1062, owner_role: "Boardsmith", batch: "g13" }]), evidence({ low: { lit: ["build"], phase: "build", headSha12: "b".repeat(12) }, "g13-first": { lit: ["checker"], phase: "checker", headSha12: "a".repeat(12) } })), [], "the next card of a started group: not named");
});

test("the first-push check judges only a new build/ branch, and fails open on anything it cannot read", () => {
  const view = { cards: [{ id: "high", num: 1, owner_role: "Boardsmith", batch: "g6" }, { id: "low", num: 2, owner_role: "Boardsmith", batch: "g13" }], evidence: {}, groupOrder: [{ batch: "g6", pos: 1 }, { batch: "g13", pos: 2 }] };
  const q = stackQueueFile(view, T), git = () => "low\n", Z = "0".repeat(40);
  const run = (line, queue = q, now = T + MIN, g = git) => outOfOrderPushes(line, g, queue, now);
  assert.equal(run(`refs/heads/build/low abc refs/heads/build/low ${Z}`).length, 1);
  assert.equal(run(`refs/heads/build/low abc refs/heads/build/low deadbeef`).length, 0, "a branch the remote has: an update, not a start");
  assert.equal(run(`refs/heads/dev abc refs/heads/dev ${Z}`).length, 0, "not a card branch");
  assert.equal(run(`(delete) ${Z} refs/heads/build/low abc`).length, 0, "a deletion");
  assert.equal(run(`refs/heads/build/low abc refs/heads/build/low ${Z}`, null).length, 0, "no queue file");
  assert.equal(run(`refs/heads/build/low abc refs/heads/build/low ${Z}`, q, T + 20 * MIN).length, 0, "a stale queue file");
  assert.equal(run(`refs/heads/build/low abc refs/heads/build/low ${Z}`, q, T + MIN, () => { throw new Error("no"); }).length, 0, "git cannot read the tip");
  assert.equal(run(`refs/heads/build/low abc refs/heads/build/low ${Z}`, q, T + MIN, () => "not-a-card\n").length, 0, "a Board-Id the queue does not list");
  assert.equal(run(`refs/heads/build/low abc refs/heads/build/low ${Z}`, { ...q, cards: q.cards.map((c) => ({ id: c.id, owner_role: c.owner_role, batch: c.batch })) }).length, 0, "an old queue file with no `turn`: nothing is claimed");
});

test("the store names work under way out of order, once, and the line goes when the spell is over", async () => {
  const db = makeDb();
  for (const [id, group, num] of [["hi", "g6", 11], ["lo", "g13", 12]]) await createCard(db, T, "Manager", { id, title: id, summary: "s", owner_role: "Boardsmith", batch: group });
  await db.prepare("UPDATE cards SET num = 11 WHERE id = 'hi'").run();
  await db.prepare("UPDATE cards SET num = 12 WHERE id = 'lo'").run();
  await db.prepare("INSERT INTO group_order (batch, pos, set_by, set_at) VALUES ('g6', 1, 'owner', 1), ('g13', 2, 'owner', 1)").run();
  const reading = (c) => ({ lit: ["build"], phase: "build", headSha12: c.repeat(12), signed: [], onMain: false });
  const lines = async (at) => (await takeInbox(db, at)).stalls.map((s) => s.reason).filter((r) => r.endsWith(ORDER_ROW_END));
  await beat(db, T + MIN);
  await writeEvidence(db, T + MIN, "probe", "cards.lo", reading("b"));
  await writeEvidence(db, T + MIN, "probe", "agents", { Boardsmith: { state: "working", card: "lo", lastActivityAt: T + MIN, since: T } });
  await wakeAsk(db, T + 2 * MIN);
  assert.deepEqual(await lines(T + 2 * MIN + 1000), [orderLine({ num: 12, group: "g13" }, { num: 11, group: "g6" })]);
  await writeEvidence(db, T + 3 * MIN, "probe", "agents", { Boardsmith: { state: "working", card: "hi", lastActivityAt: T + 3 * MIN, since: T } });
  await wakeAsk(db, T + 3 * MIN + 1000);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM stall_wakes WHERE reason LIKE ?").bind(`%${ORDER_ROW_END}`).first()).n, 0, "the owner is on the higher card now: the row is gone");
});

test("outOfOrderWork: only a role that is working that very card, and only on its own turn", () => {
  const rows = [{ id: "hi", num: 1, owner_role: "Boardsmith", batch: "g6" }, { id: "lo", num: 2, owner_role: "Boardsmith", batch: "g13" }];
  const ev = { hi: { lit: ["build"], phase: "build", headSha12: "a".repeat(12) }, lo: { lit: ["build"], phase: "build", headSha12: "b".repeat(12) } };
  const go = (agents, evidence = ev, cards = rows) => outOfOrderWork({ cards, evidence, agents, groupOrder: order }).map((s) => s.num);
  assert.deepEqual(go({ Boardsmith: { state: "working", card: "lo" } }), [2]);
  assert.deepEqual(go({ Boardsmith: { state: "working", card: "hi" } }), [], "working the higher card");
  assert.deepEqual(go({ Boardsmith: { state: "idle", card: "lo" } }), [], "idle");
  assert.deepEqual(go({ Boardsmith: { state: "working", card: "other" } }), []);
  assert.deepEqual(go(undefined), []);
  assert.deepEqual(go({ Boardsmith: { state: "working", card: "lo" } }, { ...ev, hi: { lit: ["checker"], phase: "checker", headSha12: "a".repeat(12) } }), [], "the higher card is at review: not waiting for the role");
  assert.deepEqual(orderCards(rows, ev).map((c) => c.group), ["g6", "g13"]);
});
