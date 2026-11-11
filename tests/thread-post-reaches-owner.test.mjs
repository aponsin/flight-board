// #C916: a post by the lead on a card's thread reaches the card's owner through the dispatch (no SendMessage, which the app may cap).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun, DECISION_FRESH_MS } from "../collector/store-dispatch.mjs";
import { dispatchLine, DISPATCH_STEPS } from "../gate/reset.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Builder"], LEAD = "Manager";
// Boardsmith owns #C914 (pushed, at checker, waiting on Checker: no turn of its own) and has been idle since `idle` ms before NOW.
const view = ({ msgs = [], idle = 20 * MIN, state = "idle", card = {}, asks = [] } = {}) => ({
  cards: [{ id: "c914-pick", num: 914, owner_role: "Boardsmith", waiting_on: null, paused: 0, dropped: 0, ...card }],
  asks,
  threads: { threads: [], messages: msgs },
  evidence: {
    agents: { readAt: NOW - 10_000, value: { Boardsmith: { state, since: NOW - idle, lastActivityAt: NOW - idle, card: null }, Manager: { state: "idle", since: NOW, lastActivityAt: NOW, card: null } } },
    "cards.c914-pick": { readAt: NOW - 10_000, value: { phase: "checker", headSha12: "a".repeat(12), signed: ["checker"] } },
  },
});
const msg = (o) => ({ id: `m-${o.created_at}`, thread_id: "c914-pick", author: "Manager", body: "Pick A.", kind: null, resolved: 0, options: null, ...o });
const run = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "c916-")), roster: ROSTER, lead: LEAD, now: NOW }).items;
const forOwner = (items) => items.filter((i) => i.role === "Boardsmith");

test("a lead's post in a Boardsmith-owned card's thread queues one wake for Boardsmith, and its line says to read the thread", () => {
  const items = forOwner(run(view({ msgs: [msg({ created_at: NOW - 10 * MIN })] })));
  assert.equal(items.length, 1);
  assert.equal(items[0].card, "c914-pick"); assert.equal(items[0].step, "post"); assert.equal(items[0].phase, "post");
  assert.equal(dispatchLine(items[0]), `DISPATCH #C914 at post: it ${DISPATCH_STEPS.post} (Boardsmith's turn; pushing your own build branch, sending READY and taking your next queued card need no go from anyone, act on this)`);
  // Two posts: still one wake.
  assert.equal(forOwner(run(view({ msgs: [msg({ created_at: NOW - 12 * MIN }), msg({ created_at: NOW - 10 * MIN, id: "m2" })] }))).length, 1);
});

test("held back: the owner active since the post, busy now, the post over a day old, another author, another thread, an open ask on the card", () => {
  const p = msg({ created_at: NOW - 10 * MIN });
  assert.deepEqual(forOwner(run(view({ msgs: [p], idle: 5 * MIN }))), [], "idle since after the post: it was seen");
  assert.deepEqual(forOwner(run(view({ msgs: [p], state: "working" }))), []);
  assert.deepEqual(forOwner(run(view({ msgs: [msg({ created_at: NOW - DECISION_FRESH_MS - 1 })], idle: 2 * DECISION_FRESH_MS }))), []);
  assert.deepEqual(forOwner(run(view({ msgs: [msg({ created_at: NOW - 10 * MIN, author: "Checker" })] }))), []);
  assert.deepEqual(forOwner(run(view({ msgs: [msg({ created_at: NOW - 10 * MIN, author: "Boardsmith" })] }))), []);
  assert.deepEqual(forOwner(run(view({ msgs: [msg({ created_at: NOW - 10 * MIN, thread_id: "t-1" })] }))), []);
  assert.deepEqual(forOwner(run(view({ msgs: [p], asks: [{ id: "a1", card_id: "c914-pick", closed_at: null, answered_at: null }] }))), []);
  assert.deepEqual(forOwner(run(view({ msgs: [p], card: { paused: 1 } }))), []);
});

test("Still allowed: with no post the card keeps its turns (Checker's review, nothing for Boardsmith); the lead's own card is not woken by its own post", () => {
  const items = run(view());
  assert.deepEqual(forOwner(items), []);
  const own = run(view({ msgs: [msg({ created_at: NOW - 10 * MIN })], card: { owner_role: "Manager" } }));
  assert.deepEqual(own.filter((i) => i.step === "post"), []);
  // A builder's card with nothing pushed and a post: the post turn takes the build turn's place (one wake for the card, naming the post).
  const b = { ...view({ msgs: [msg({ created_at: NOW - 10 * MIN })] }) };
  b.evidence = { ...b.evidence, "cards.c914-pick": undefined };
  delete b.evidence["cards.c914-pick"];
  const bi = forOwner(run(b));
  assert.equal(bi.length, 1); assert.equal(bi[0].step, "post");
});
