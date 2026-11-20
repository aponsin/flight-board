// #C1076 (11-13: #C1006 landed overnight and nobody built its deploy pair for about 7 hours): (A) the dispatch line of a landed group card names the
// group; (B) a board card landed 30+ min ago that no deploy pair holds is a line to Manager, whatever its owner is doing; (C) a pair below the
// landing (a held older one) never covers it.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { landedUnbuilt, LANDED_REPO_WORDS, LANDED_UNBUILT_MS } from "../worker/board-rules.mjs";
import { createCard, writeEvidence, wakeAsk } from "../worker/board-store.mjs";
import { turnsOf } from "../collector/store-dispatch.mjs";
import { dispatchItems, dispatchLine } from "../gate/reset.mjs";
import { BOARD_REPO_WORDS, packOf } from "../collector/pairs.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const FULL = "1130018f739472502be94627a0f026e6cf8229c3", S12 = FULL.slice(0, 12);
const landed = (extra = {}) => ({ lit: ["ship"], phase: "ship", headSha: FULL, headSha12: S12, repoFull: "aponsin/flight-board", signed: ["checker", "security"], onMain: true, ...extra });
const card = (extra = {}) => ({ id: "schedule-model-drift", num: 1006, owner_role: "Boardsmith", repo: "flight-board", batch: "g10-small-rules", ...extra });

test("the two lists of the board's repo words are the same", () => {
  assert.deepEqual([...LANDED_REPO_WORDS].sort(), [...BOARD_REPO_WORDS].sort());
});

test("(A) a landed card in a group: the pair turn carries the group, and the DISPATCH line says 'build pack <group>'; no group, no such words", () => {
  const t = turnsOf(card(), landed());
  assert.equal(t[0].step, "pair"); assert.equal(t[0].batch, "g10-small-rules");
  const items = (cd, ev) => dispatchItems({ cards: [{ id: cd.id, who: "Boardsmith", num: cd.num, status: "active", turns: turnsOf(cd, ev) }], agents: { Boardsmith: { state: "idle", since: T - 60 * MIN } }, roster: ["Boardsmith"], lead: "Manager", now: T }).items;
  const line = dispatchLine(items(card(), landed())[0]);
  assert.match(line, /build the deploy pair/); assert.match(line, /; build pack g10-small-rules \(Boardsmith's turn/);
  assert.doesNotMatch(dispatchLine(items(card({ batch: null }), landed())[0]), /build pack/);
  // a group id that is not a plain word never reaches the line
  const odd = items(card({ batch: "a/b c" }), landed());
  assert.doesNotMatch(dispatchLine(odd[0] ?? { card: "x", role: "Boardsmith" }), /build pack/);
});

const rule = (cards, evidence, installStart, now = T + LANDED_UNBUILT_MS) => landedUnbuilt({ now, cards, evidence, installStart: new Map(Object.entries(installStart)) });

test("(B) the line fires at 30 minutes after the landing and not before; it says the landing time, the owner and the pack", () => {
  const cards = [card()], ev = { "schedule-model-drift": landed() }, st = { "schedule-model-drift": T };
  assert.deepEqual(rule(cards, ev, st, T + LANDED_UNBUILT_MS - 1), [], "29 min 59 s: not yet");
  const r = rule(cards, ev, st);
  assert.equal(r.length, 1); assert.equal(r[0].card_id, "schedule-model-drift");
  assert.match(r[0].reason, /^#C1006 landed at .+ and no deploy pair holds it: Boardsmith builds it \(pack g10-small-rules\)$/);
});

test("(B) one line per group on its newest card; a card with no group is its own line", () => {
  const cards = [card(), card({ id: "other-in-group", num: 1059 }), card({ id: "alone", num: 1100, batch: null })];
  const ev = Object.fromEntries(cards.map((c) => [c.id, landed()])), st = Object.fromEntries(cards.map((c) => [c.id, T]));
  const r = rule(cards, ev, st);
  assert.equal(r.length, 2);
  const g = r.find((x) => x.card_id === "other-in-group");
  assert.match(g.reason, /^#C1006, #C1059 landed at .+ and no deploy pair holds them: Boardsmith builds it \(pack g10-small-rules\)$/);
  assert.ok(r.some((x) => x.card_id === "alone" && !/pack/.test(x.reason)));
});

test("(B) no line for: a pair that holds the landing, a product card, a card not on main, not at ship, closed, dropped or paused, or with no install wait yet", () => {
  const st = { "schedule-model-drift": T };
  const none = (c, e, s = st) => assert.deepEqual(rule([c], { [c.id]: e }, s), []);
  none(card(), landed({ packed: true }));
  none(card({ repo: null }), landed());
  none(card({ repo: "the-product" }), landed());
  none(card(), landed({ onMain: false }));
  none(card(), landed({ lit: ["live"], phase: "live" }));
  none(card({ done_at: T }), landed());
  none(card({ dropped: 1 }), landed());
  none(card({ paused: 1 }), landed());
  none(card(), landed(), {});
});

test("(B) through the store: a landed board card with no pair is a pending line for Manager 30 min after its install wait began, and ends when a pair holds it", async () => {
  const db = makeDb();
  assert.equal((await createCard(db, T, "Manager", { id: "board-c", title: "A board card", owner_role: "Boardsmith", repo: "flight-board", batch: "g10-small-rules" })).ok, true);
  assert.equal((await createCard(db, T, "Manager", { id: "prod-c", title: "A product card", owner_role: "Builder" })).ok, true);
  await writeEvidence(db, T + 1, "probe", "cards.board-c", landed());
  await writeEvidence(db, T + 1, "probe", "cards.prod-c", landed());
  const rows = async (pendingOnly = false) => (await db.prepare(`SELECT card_id, reason, taken_at FROM stall_wakes WHERE reason LIKE '%no deploy pair holds%'${pendingOnly ? " AND taken_at IS NULL" : ""}`).all()).results;
  await wakeAsk(db, T + 29 * MIN);
  assert.deepEqual(await rows(), [], "not at 29 min");
  await wakeAsk(db, T + 31 * MIN);
  const r = await rows(true);
  assert.equal(r.length, 1); assert.equal(r[0].card_id, "board-c"); assert.match(r[0].reason, /Boardsmith builds it \(pack g10-small-rules\)$/);
  await writeEvidence(db, T + 40 * MIN, "probe", "cards.board-c", landed({ packed: true }));
  await wakeAsk(db, T + 41 * MIN);
  assert.deepEqual(await rows(true), [], "a pair holds it: the line is no longer pending (the store retires it)");
  await wakeAsk(db, T + 90 * MIN);
  assert.equal((await rows()).length, 1, "and it is not raised again");
});

test("(C) a pair below the landing, built or held, never covers it; one whose pin is the landing or holds it does", () => {
  const LAND = FULL, OLD = "ac5b7d0b" + "0".repeat(32), NEWER = "a386d516" + "1".repeat(32);
  // history: OLD is an ancestor of LAND; LAND is an ancestor of NEWER
  const anc = new Set([`${OLD}>${LAND}`, `${OLD}>${NEWER}`, `${LAND}>${NEWER}`]);
  const git = (args) => ({ status: args[0] === "merge-base" && anc.has(`${args[2]}>${args[3]}`) ? 0 : 1 });
  assert.deepEqual(packOf([{ n: 63, sha: OLD, ran: false }], LAND, git), { packed: false, installed: false }, "a held older pair covers nothing");
  assert.deepEqual(packOf([{ n: 63, sha: OLD, ran: true }], LAND, git), { packed: false, installed: false }, "nor does an installed older one");
  assert.deepEqual(packOf([{ n: 64, sha: LAND, ran: false }], LAND, git), { packed: true, installed: false, pack: 64 }, "a pair built on the landing itself does");
  assert.deepEqual(packOf([{ n: 65, sha: NEWER, ran: false }, { n: 64, sha: LAND, ran: true }], LAND, git), { packed: true, installed: true, pack: 64 }, "the pack named is the oldest that holds it");
});
