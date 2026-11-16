// #C1082 (after #C1080): the idle-agent stall line ("Boardsmith idle since ..., N queued, next #C..") must name the card the dispatch would send, so it uses
// the dispatch's open-group rule: while a STARTED group of the role is not READY, a queued card outside it is not counted or named; none left = no line.
import test from "node:test";
import assert from "node:assert/strict";
import { stalledWaits, openGroupWithheld } from "../worker/board-rules.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, wakeAsk, takeInbox, setStackSwitch } from "../worker/board-store.mjs";

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

test("stack switch on: a pushed same-role dependency is satisfied, so its own unbuilt dependency is not let through (the count says 1, not 2); off, it is let through", () => {
  const cards = [row("c1-one", 1, { batch: "g1-a" }), row("c2-two", 2, { batch: "g1-a", depends_on: JSON.stringify(["c4-four"]), queue_pos: 2 }), row("c4-four", 4, { depends_on: JSON.stringify(["c5-five"]), queue_pos: 9 }), row("c5-five", 5, { queue_pos: 8 })];
  const ev = { "c1-one": pushed(), "c4-four": pushed({ headSha12: "123456abcdef" }) };
  const line = (stackOn) => stalledWaits({ now: NOW, cards, evidence: ev, agents: idle, openAskCards: new Set(), phaseStart: new Map(), stackOn }).filter((s) => /queued/.test(s.reason));
  assert.match(line(true)[0].reason, /, 1 queued, next #C2$/);
  assert.match(line(false)[0].reason, /, 1 queued, next #C5$/, "off: c2 waits on c4 (not live), c4's own dependency c5 is let through and is the card to build");
});

test("a role with NO open session: its line counts and names only the group's card too, and has no line when the whole queue is withheld", () => {
  const noSession = (cards, ev) => stalledWaits({ now: NOW, cards, evidence: ev, agents: { Manager: { state: "idle", tool: null, card: null, since: T } }, openAskCards: new Set(), phaseStart: new Map() }).filter((s) => /no open session/.test(s.reason));
  const got = noSession(open(), { "c1-one": pushed() });
  assert.equal(got.length, 1);
  assert.match(got[0].reason, /^Boardsmith has no open session, 1 queued, next #C2$/);
  assert.deepEqual(noSession([row("c1-one", 1, { batch: "g1-a" }), row("c2-two", 2, { batch: "g1-a" }), row("c3-loose", 3)], { "c1-one": pushed(), "c2-two": pushed({ headSha12: "bbbbbbbbbbbb", stackHold: true }) }), []);
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
  const ev = { "c1-one": pushed() };
  const w = openGroupWithheld({ now: NOW, cards, evidenceOf: (id) => ev[id], askedCards: new Set(), endPassed: () => false });
  const held = (c) => w({ role: c.owner_role, id: c.id, group: c.batch ?? "" });
  assert.equal(held(cards[3]), false, "the loose card is let through");
  assert.equal(held(cards[4]), true, "another group's card is withheld");
});

// The store's own wiring (syncStalls): the set of cards with an UNANSWERED ask, and the stack switch, reach the rule (Checker 2's F1 and his surviving mutants).
async function storeLines(setup) {
  const db = makeDb();
  await setup(db);
  await writeEvidence(db, T, "probe", "agents", idle);
  await db.prepare("UPDATE evidence SET read_at = ? WHERE key LIKE 'cards.%'").bind(NOW).run();
  await wakeAsk(db, NOW);
  return (await takeInbox(db, NOW + 1000)).stalls.map((s) => s.reason).filter((r) => /queued/.test(r));
}
const mk = (db, id, extra = {}) => createCard(db, T, "Manager", { id, title: id, owner_role: "Boardsmith", ...extra }).then((r) => assert.ok(r.ok, id));
const ask = (db, answered) => db.prepare("INSERT INTO asks (id, num, type, title, asked_by, card_id, body, created_at, answered_at) VALUES ('t1', 1, 'Decision', 'q', 'Boardsmith', 'c2-two', '{}', ?, ?)").bind(T, answered ? T : null).run();

test("the store: an ANSWERED ask left open on the group's card does not hold it, so the group stays open and the loose card is not named; an unanswered one does", async () => {
  const setup = (answered) => async (db) => {
    await mk(db, "c1-one", { batch: "g1-a", queue_pos: 1 }); await mk(db, "c2-two", { batch: "g1-a", queue_pos: 2 }); await mk(db, "c3-loose", { queue_pos: 1 });
    await writeEvidence(db, T, "probe", "cards.c1-one", pushed());
    await ask(db, answered);
  };
  assert.deepEqual(await storeLines(setup(true)), [], "answered: c2 is still the group's card to build, c3 is withheld");
  const open = await storeLines(setup(false));
  assert.equal(open.length, 1); assert.match(open[0], /, 1 queued, next #C\d+$/, "unanswered: the ask holds c2, the loose card is the one named");
  assert.match(open[0], /next #C3$/);
});

test("the store: with the board's stack switch on, a pushed same-role dependency is satisfied, so the group's own card is named; off, it is not", async () => {
  const setup = (on) => async (db) => {
    await mk(db, "c1-one", { batch: "g1-a", queue_pos: 1 }); await mk(db, "c4-four", { queue_pos: 9 });
    await mk(db, "c2-two", { batch: "g1-a", queue_pos: 2, depends_on: ["c4-four"] });
    await writeEvidence(db, T, "probe", "cards.c1-one", pushed()); await writeEvidence(db, T, "probe", "cards.c4-four", pushed({ headSha12: "123456abcdef" }));
    assert.ok((await setStackSwitch(db, T, "owner", { repo: "board", stack: on })).ok); // the board's default is not assumed
  };
  assert.deepEqual(await storeLines(setup(false)), [], "off: c2 waits on c4, which is not live: nothing can start");
  const on = await storeLines(setup(true));
  assert.equal(on.length, 1); assert.match(on[0], /, 1 queued, next #C3$/, "c2-two is the third card created");
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
