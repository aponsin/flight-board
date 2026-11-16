// #C1082 (after #C1080): the idle-agent stall line ("Boardsmith idle since ..., N queued, next #C..") must name the card the dispatch would send, so it uses
// the dispatch's open-group rule: while a STARTED group of the role is not READY, a queued card outside it is not counted or named; none left = no line.
import test from "node:test";
import assert from "node:assert/strict";
import { stalledWaits, openGroupWithheld } from "../worker/board-rules.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, wakeAsk, takeInbox } from "../worker/board-store.mjs";

const T = 1_800_000_000_000, MIN = 60_000, NOW = T + 30 * MIN;
const row = (id, num, extra = {}) => ({ id, num, owner_role: "Boardsmith", updated_at: T, queue_pos: num, ...extra });
const idle = { Boardsmith: { state: "idle", tool: null, card: null, since: T } };
const pushed = (extra = {}) => ({ lit: ["checker"], phase: "checker", headSha12: "aaaaaaaaaaaa", ...extra });
const run = (cards, evidence) => stalledWaits({ now: NOW, cards, evidence, agents: idle, openAskCards: new Set(), phaseStart: new Map(), endsPassed: new Set() }).filter((s) => /queued/.test(s.reason));

// g1 is started (c1 pushed) and not READY: c2 of the group has nothing pushed. c3 (no group) and c4 (another group) are queued outside it.
const open = () => [row("c1-one", 1, { batch: "g1-a" }), row("c2-two", 2, { batch: "g1-a", queue_pos: 9 }), row("c3-loose", 3, { queue_pos: 1 }), row("c4-other", 4, { batch: "g2-b", queue_pos: 2 })];

test("open group with a queued card outside it: the line names the group's card and counts only it", () => {
  const got = run(open(), { "c1-one": pushed() });
  assert.equal(got.length, 1);
  assert.match(got[0].reason, /, 1 queued, next #C2$/);
  assert.equal(got[0].num, 2);
});

test("no group open (the started group's cards all pushed and signalled): the line is as before, the queue's first card", () => {
  const cards = [row("c1-one", 1, { batch: "g1-a" }), row("c3-loose", 3, { queue_pos: 1 }), row("c4-other", 4, { batch: "g2-b", queue_pos: 2 })];
  const got = run(cards, { "c1-one": pushed() });
  assert.equal(got.length, 1);
  assert.match(got[0].reason, /, 2 queued, next #C4$/, "a card in a group comes before one in none (#C1053)");
});

test("the open group's only remaining card is pushed with no stack-ready signal (stackHold): the queue outside is withheld, so there is no line at all", () => {
  const cards = [row("c1-one", 1, { batch: "g1-a" }), row("c2-two", 2, { batch: "g1-a" }), row("c3-loose", 3), row("c4-other", 4, { batch: "g2-b" })];
  assert.deepEqual(run(cards, { "c1-one": pushed(), "c2-two": pushed({ headSha12: "bbbbbbbbbbbb", stackHold: true }) }), []);
});

test("a blocker of the group's card (same role) keeps its turn: it is let through though it sits outside the group", () => {
  const cards = [row("c1-one", 1, { batch: "g1-a" }), row("c2-two", 2, { batch: "g1-a", depends_on: JSON.stringify(["c3-dep"]) }), row("c3-dep", 3, { queue_pos: 5 }), row("c4-other", 4, { queue_pos: 1 })];
  const got = run(cards, { "c1-one": pushed() });
  assert.equal(got.length, 1);
  assert.match(got[0].reason, /next #C3$/, "the dependency, never the loose card");
});

test("a started group whose unfinished cards all wait on ANOTHER role's card: the role may take a loose card, never a card of another group", () => {
  const cards = [row("c1-one", 1, { batch: "g1-a" }), row("c2-two", 2, { batch: "g1-a", depends_on: JSON.stringify(["x-builder"]) }), row("x-builder", 9, { owner_role: "Builder" }), row("c3-loose", 3, { queue_pos: 4 }), row("c4-other", 4, { batch: "g2-b", queue_pos: 1 })];
  const w = openGroupWithheld({ now: NOW, cards, evidence: { "c1-one": pushed() }, openAskCards: new Set(), endsPassed: new Set() });
  assert.equal(w(cards[3]), false, "the loose card is let through");
  assert.equal(w(cards[4]), true, "another group's card is withheld");
});

test("the store passes the rule to the stall line: with an open group, Manager is told the group's card, not the one outside it", async () => {
  const db = makeDb();
  for (const [id, n, batch, pos] of [["c1-one", 1, "g1-a", 1], ["c2-two", 2, "g1-a", 9], ["c3-loose", 3, null, 1]]) {
    assert.ok((await createCard(db, T, "Manager", { id, title: id, owner_role: "Boardsmith", queue_pos: pos, ...(batch ? { batch } : {}) })).ok, id);
  }
  await writeEvidence(db, T, "probe", "cards.c1-one", pushed());
  await writeEvidence(db, T, "probe", "agents", idle);
  await db.prepare("UPDATE evidence SET read_at = ? WHERE key LIKE 'cards.%'").bind(NOW).run();
  assert.ok((await wakeAsk(db, NOW)).count >= 1);
  const lines = (await takeInbox(db, NOW + 1000)).stalls.map((s) => s.reason).filter((r) => /queued/.test(r));
  assert.equal(lines.length, 1); assert.match(lines[0], /, 1 queued, next #C2$/);
});
