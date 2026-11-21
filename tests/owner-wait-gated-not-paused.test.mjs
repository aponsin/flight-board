// #C1405 (the owner, 2026-11-20, #T2255: #C1391 showed "paused" for hours while it waited on his decision, and no ask had been posted): a card waiting on the owner is gated on his ask, never
// paused. The store refuses paused:true when the next_note names the owner, a decision or a pick (the refusal says to post the ask, then set blocked_reason with hold_end = that ask's id), through
// card_update and card_create alike; and a blocked card that has an open ask draws as gated (red stripes, under Needs you), not as the yellow Blocked overlay.
import test from "node:test";
import assert from "node:assert/strict";
import { cardWriteRefusal, waitsOnOwner } from "../worker/board-rules.mjs";
import { readingDocs } from "../worker/compat-reading.mjs";
import { tileOf } from "../worker/reading.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";

const NOW = 1_800_000_000_000;
const OWNER_NOTES = [
  "Waiting on the owner's decision on #T2255.",
  "Paused until the owner picks A or B.",
  "Needs his pick before it can start.",
  "Waiting for your choice on the wording.",
  "Awaiting a decision, then the build resumes.",
  "Waiting for the owner.",
];
// What the rule must still allow: a pause for a build reason that says "decision" in another sense, and a pause by an agent waiting on Director or another agent.
const ALLOWED_NOTES = [
  "Paused until #C1391 lands: the decision recorded in the contract is built there.",
  "Paused: waiting for Director's decision on the contract text.",
  "Paused until Director sends the final contract.",
  "Waiting on Manager's pick of the group, then Boardsmith builds.",
  "Paused until the group it follows has shipped.",
  "Waiting for a decision from Director, then it resumes.",
  "Paused: the owner_role field is renamed in #C1380 first.",
];

test("a pause whose next_note names the owner, a decision or a pick is refused, with the way out in the words", () => {
  for (const next_note of OWNER_NOTES) for (const paused of [true, 1]) {
    const r = cardWriteRefusal({ id: "x", paused, next_note }, null);
    assert.equal(r?.rule, "paused-waits-on-owner", `${paused} ${next_note}`);
    assert.match(r.message ?? JSON.stringify(r), /post the ask first/);
    assert.match(r.message ?? JSON.stringify(r), /blocked_reason/);
    assert.match(r.message ?? JSON.stringify(r), /hold_end/);
  }
});

test("must still allow: a pause for a build reason, a decision in another sense, or an agent's wait on Director or another agent", () => {
  for (const next_note of ALLOWED_NOTES) {
    assert.equal(cardWriteRefusal({ id: "x", paused: true, next_note }, null), null, next_note);
    assert.equal(waitsOnOwner(next_note), false, next_note);
  }
});

test("only a pause is refused: a blocked card or a plain note that names the owner is written as before, and an unpause is free", () => {
  assert.equal(cardWriteRefusal({ id: "x", blocked_reason: "waits on the owner's decision", next_note: "Waiting on the owner's decision." }, null), null);
  assert.equal(cardWriteRefusal({ id: "x", next_note: "Asked the owner, see the thread." }, null), null);
  assert.equal(cardWriteRefusal({ id: "x", paused: false, next_note: "The owner picked A: building." }, null), null);
  assert.equal(cardWriteRefusal({ id: "x", paused: true }, null)?.rule, "blocked-needs-note", "the note is still needed");
});

const BASE = { title: "A follow-up", summary: "Build it, because it is needed.", batch: "g1-first", repo: "product-app", owner_role: "Boardsmith", review_level: "Quick" };
const tool = (env, name, args) => worker.fetch(new Request("https://board.test/mcp", { method: "POST", headers: { "content-type": "application/json", "x-as": "m" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env, null, NOW, async () => ({ who: "Manager", role: "agent" })).then((r) => r.json()).then((j) => j.result);
const row = (env, id) => env.DB.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first();

test("through the tools: card_create and card_update refuse the paused wait on the owner, write nothing, and allow the agent's wait", async () => {
  const env = { DB: makeDb() };
  const refused = await tool(env, "card_create", { ...BASE, id: "own-wait", paused: true, next_note: OWNER_NOTES[0] });
  assert.match(JSON.stringify(refused), /paused-waits-on-owner/);
  assert.equal(await row(env, "own-wait"), null, "nothing is written for a refused card");
  const ok = await tool(env, "card_create", { ...BASE, id: "agent-wait", paused: true, next_note: ALLOWED_NOTES[1] });
  assert.doesNotMatch(JSON.stringify(ok), /refused/i, JSON.stringify(ok));
  assert.equal((await row(env, "agent-wait")).paused, 1);
  await tool(env, "card_create", { ...BASE, id: "live-card" });
  const upd = await tool(env, "card_update", { id: "live-card", paused: true, next_note: OWNER_NOTES[1] });
  assert.match(JSON.stringify(upd), /paused-waits-on-owner/);
  assert.equal((await row(env, "live-card")).paused, 0, "the card is not paused");
});

// ---- the page: a blocked card with an open ask is gated ----
const card = (id, over = {}) => ({ id, num: 7, owner_role: "Builder", repo: "flight-board", batch: "g1", created_at: NOW - 1e6, ...over });
const view = (cards, asks = []) => ({ now: NOW, cards, history: [], asks, reviewClaims: [], evidence: { agents: { value: {} } } });
const OPEN = { id: "t-1", num: 2255, card_id: "gated-card", closed_at: null, answered_at: null, withdrawn_at: null };

test("a blocked card whose hold is an open ask reads Gated (wait ask, no overlay, the ask's number), and draws the red ask tile", () => {
  const [d] = readingDocs(view([card("gated-card", { blocked_reason: "Waiting on the owner's decision", hold_end: "t-1" })], [OPEN]));
  assert.equal("overlay" in d, false, "not the yellow Blocked overlay");
  assert.equal(d.wait, "ask");
  assert.equal(d.ask, 2255);
  assert.equal(d.state, "waiting");
  assert.equal(tileOf(d), "ask");
});

test("must still allow: a blocked card with no open ask, or whose ask is answered, stays the Blocked overlay; a paused card keeps its overlay", () => {
  const [none] = readingDocs(view([card("gated-card", { blocked_reason: "waits on a part" })]));
  assert.equal(none.overlay, "blocked");
  const [answered] = readingDocs(view([card("gated-card", { blocked_reason: "waits" })], [{ ...OPEN, answered_at: NOW - 1000 }]));
  assert.equal(answered.overlay, "blocked", "an answered ask gates nothing");
  const [paused] = readingDocs(view([card("gated-card", { paused: 1, blocked_reason: "waits" })], [OPEN]));
  assert.equal(paused.overlay, "paused");
});
