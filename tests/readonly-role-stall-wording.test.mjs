// #C885: a read-only role (Designer, Checker, Security, Linguist) never pushes for its own card; its work is a post on the card's thread.
// Its card with nothing pushed stalls only when its owner posted nothing there in the last hour, and the line says "nothing posted".
import test from "node:test";
import assert from "node:assert/strict";
import { stalledWaits, STALL_AFTER_MS, READ_ONLY_ROLES, POSTED_FRESH_MS } from "../worker/board-rules.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, wakeAsk, takeInbox, postMessage } from "../worker/board-store.mjs";

const T = 1_800_000_000_000, MIN = 60e3, NOW = T + STALL_AFTER_MS;
import { mtTime as hhmm } from "../worker/team-time.mjs"; // #C983
const card = (o = {}) => ({ id: "c884-look", num: 884, owner_role: "Designer", updated_at: T, ...o });
const run = (cards, postedAt, agents = { Designer: { state: "idle", since: T }, Builder: { state: "idle", since: T } }) =>
  stalledWaits({ now: NOW, cards, evidence: {}, agents, openAskCards: new Set(), phaseStart: new Map(), postedAt });

test("the read-only roles are the four that never push for their own card", () => {
  assert.deepEqual(READ_ONLY_ROLES, ["Designer", "Checker", "Security", "Linguist"]);
  assert.equal(POSTED_FRESH_MS, 60 * MIN);
});

test("a read-only card with its owner's post in the last hour does not stall; with none, it stalls with 'nothing posted', never 'pushed' or 'queued'", () => {
  assert.deepEqual(run([card()], new Map([["c884-look", NOW - 10 * MIN]])), [], "posted 10 min ago");
  assert.deepEqual(run([card()], new Map([["c884-look", NOW - POSTED_FRESH_MS]])), [], "exactly an hour ago still counts");
  for (const posted of [undefined, new Map(), new Map([["c884-look", NOW - POSTED_FRESH_MS - 1]]), new Map([["other", NOW]])]) {
    const r = run([card()], posted);
    assert.equal(r.length, 1);
    assert.equal(r[0].reason, `#C884 nothing posted on its thread in the last hour, Designer idle since ${hhmm(T)}`);
    assert.doesNotMatch(r[0].reason, /pushed|queued/);
    assert.equal(r[0].card_id, "c884-look"); assert.equal(r[0].phase, null); assert.equal(r[0].role, "Designer");
  }
  for (const role of ["Checker", "Security", "Linguist"]) {
    assert.match(run([card({ owner_role: role })], new Map(), { [role]: { state: "idle", since: T } })[0].reason, new RegExp(`nothing posted on its thread in the last hour, ${role} idle`));
  }
});

test("Still allowed: a builder's queued cards keep the queued line; a read-only role busy or idle under 15 min is no stall; a held card is no stall", () => {
  const b = run([card({ id: "c1", num: 1, owner_role: "Builder" })], new Map());
  assert.equal(b[0].reason, `Builder idle since ${hhmm(T)}, 1 queued, next #C1`, "a builder's post does not stand in for a push");
  assert.equal(run([card({ id: "c1", num: 1, owner_role: "Builder" })], new Map([["c1", NOW]])).length, 1);
  assert.deepEqual(run([card()], new Map(), { Designer: { state: "working", since: T, card: "x" } }), []);
  assert.deepEqual(run([card()], new Map(), { Designer: { state: "idle", since: NOW - STALL_AFTER_MS + 1 } }), []);
  assert.deepEqual(run([card({ hold_end: "a9" })], new Map()), []);
  assert.deepEqual(run([card({ paused: 1 })], new Map()), []);
});

test("through the store: the owner's post on the card's thread holds the stall back; another author's post does not", async () => {
  const db = makeDb();
  await createCard(db, T - 60 * MIN, "Manager", { id: "c884-look", title: "Look review", owner_role: "Designer" });
  await writeEvidence(db, T, "probe", "agents", { Designer: { state: "idle", tool: null, card: null, since: T } });
  await postMessage(db, T + 5 * MIN, "Designer", { thread_id: "c884-look", body: "Reviewing the screens now." });
  assert.equal((await wakeAsk(db, NOW)).count, 0, "the owner posted 10 min ago");
  const db2 = makeDb();
  await createCard(db2, T - 60 * MIN, "Manager", { id: "c884-look", title: "Look review", owner_role: "Designer" });
  await writeEvidence(db2, T, "probe", "agents", { Designer: { state: "idle", tool: null, card: null, since: T } });
  await postMessage(db2, T + 5 * MIN, "Manager", { thread_id: "c884-look", body: "Any news?" });
  assert.equal((await wakeAsk(db2, NOW)).count, 1);
  assert.match((await takeInbox(db2, NOW + MIN)).stalls[0].reason, /^#C\d+ nothing posted on its thread in the last hour, Designer idle since /);
});

// #C943 (Checker's LOW on #C931): the store's post query and the rule share one boundary. The rule counts a post exactly POSTED_FRESH_MS
// old as fresh (now - posted <= POSTED_FRESH_MS), so the query must read it too (created_at >= now - POSTED_FRESH_MS); one ms older is not.
test("through the store, at the boundary: a post exactly an hour old holds the stall back; one a millisecond older does not", async () => {
  const at = async (postAt) => {
    const db = makeDb();
    await createCard(db, T - 90 * MIN, "Manager", { id: "c884-look", title: "Look review", owner_role: "Designer" });
    await writeEvidence(db, T, "probe", "agents", { Designer: { state: "idle", tool: null, card: null, since: T } });
    await postMessage(db, postAt, "Designer", { thread_id: "c884-look", body: "Reviewing the screens now." });
    return (await wakeAsk(db, NOW)).count;
  };
  assert.equal(await at(NOW - POSTED_FRESH_MS), 0, "exactly an hour old: still fresh");
  assert.equal(await at(NOW - POSTED_FRESH_MS - 1), 1, "a millisecond older: the card stalls");
});
