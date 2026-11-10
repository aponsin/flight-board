// The dry run reads its tabs off the PAGE's own script (collector/import-page.mjs), not off rules written again (Checker on 06422f3): each case
// below is one where the hand-written rules differed from the page.
import test from "node:test";
import assert from "node:assert/strict";
import { storeTabs, oldTabs, postImportView } from "../collector/import-page.mjs";

const NOW = 1_794_348_480_000, DAY = 86_400_000, MIN = 60_000;
const OWNER = "Owner";
const ask = (id, type, extra = {}) => ({ id, num: 1, type, title: id, asked_by: "Manager", card_id: null, created_at: NOW - DAY, eta_at: null, closed_at: null, answered_at: null, answer: null, answer_status: null, answer_note: null,
  body: JSON.stringify(type === "Decision" ? { question: "q", options: ["A", "B"], recommended: "A" } : type === "Later" ? { text: "later" } : { steps: ["x"], expect: "y" }), ...extra });
const msg = (id, thread, author, at, extra = {}) => ({ id, thread_id: thread, author, body: "hi", created_at: at, kind: null, resolved: 0, options: null, ...extra });
const view = ({ asks = [], messages = [], cards = [], evidence = {}, historyCards = [] } = {}) => ({ tag: "t", now: NOW, cards, asks, lists: [], evidence, historyCards, history: [], threads: { messages, threads: [] }, live: {}, ships: [], usage: [] });
const tabs = (v) => storeTabs(v, null, null, { now: NOW, owner: OWNER });

test("1a a settled ask (acknowledged, or Done with an acknowledge-only note) is on no tab", () => {
  const t = tabs(view({ asks: [ask("a-ack", "Action", { answered_at: NOW - 2 * MIN, answer_status: "done", answer_note: "done." }), ask("a-ack2", "Answer", { answered_at: NOW - 2 * MIN, answer: "ack" })] }));
  assert.deepEqual([t.counts.you, t.counts.later, t.counts.lead], [0, 0, 0]);
});

test("1b an answered Later is With the team, not Later", () => {
  const t = tabs(view({ asks: [ask("l-1", "Later", { eta_at: NOW + DAY, answered_at: NOW - 2 * MIN, answer_status: "help", answer_note: "step 2 fails" })] }));
  assert.deepEqual([t.counts.later, t.counts.lead], [0, 1]);
  assert.deepEqual(t.ids.lead, ["l-1"]);
});

test("1c a date in the future makes only a Decision Later; an Action with a date is still on Needs you", () => {
  const t = tabs(view({ asks: [ask("act-1", "Action", { eta_at: NOW + DAY }), ask("dec-1", "Decision", { eta_at: NOW + DAY })] }));
  assert.deepEqual(t.ids.you, ["act-1"]);
  assert.deepEqual(t.ids.later, ["dec-1"]);
});

test("1d an answered ask whose newest thread message is the lead's goes back to Needs you", () => {
  const answered = ask("d-1", "Decision", { answered_at: NOW - 10 * MIN, answer: "A" });
  assert.deepEqual(tabs(view({ asks: [answered] })).ids.lead, ["d-1"], "answered, nobody has spoken since: With the team");
  const t = tabs(view({ asks: [answered], messages: [msg("m1", "d-1", "Manager", NOW - 5 * MIN)] }));
  assert.deepEqual([t.counts.you, t.counts.lead], [1, 0], "the lead's word is the newest: back to the owner");
});

test("2a a thread whose newest word is the owner's, unresolved, is not Resolved even if its item is done", () => {
  const done = ask("r-1", "Action", { closed_at: NOW - DAY, answered_at: NOW - DAY, answer_status: "done", answer_note: "real note, not just an ack" });
  const open = tabs(view({ asks: [done], messages: [msg("m1", "r-1", "Manager", NOW - 3 * MIN), msg("m2", "r-1", "owner", NOW - 2 * MIN)] }));
  assert.equal(open.counts.resolved, 0);
  assert.equal(open.counts.lead, 1, "it waits on the team");
  const closed = tabs(view({ asks: [done], messages: [msg("m1", "r-1", "Manager", NOW - 3 * MIN)] }));
  assert.equal(closed.counts.resolved, 1);
});

test("2b an ask that is settled but still open (acknowledged, not closed) lists its thread as Resolved", () => {
  const t = tabs(view({ asks: [ask("s-1", "Action", { answered_at: NOW - 2 * MIN, answer_status: "done", answer_note: "ok." })], messages: [msg("m1", "s-1", "Manager", NOW - 3 * MIN)] }));
  assert.deepEqual(t.ids.resolved, ["s-1"]);
});

test("2c an owner's Ack on an in-flight card's thread is not Resolved; once the card finishes it is", () => {
  const card = { id: "build-1", title: "A card", summary: null, size: "S", review_level: "Quick", created_at: NOW - 5 * DAY, updated_at: NOW - MIN };
  const ack = msg("m1", "build-1", "owner", NOW - 2 * MIN, { kind: "ack", resolved: 1 });
  const live = { value: { lit: ["live"], num: 900, phase: "live", headSha12: "a1b2c3d4e5f6", signed: [], onMain: true, ci: "none", ciMin: null, liveVersion: "1.2.3", at: NOW - 5e3 } };
  const building = { value: { lit: ["build"], num: 900, phase: "build", headSha12: "a1b2c3d4e5f6", signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: NOW - 5e3 } };
  const inFlight = tabs(view({ cards: [card], messages: [msg("m0", "build-1", "Manager", NOW - 3 * MIN), ack], evidence: { "cards.build-1": building } }));
  assert.equal(inFlight.counts.resolved, 0, "the ack leaves it with the team while its card is in flight");
  const finished = tabs(view({ cards: [card], messages: [msg("m0", "build-1", "Manager", NOW - 3 * MIN), ack], evidence: { "cards.build-1": live } }));
  assert.equal(finished.counts.resolved, 1);
});

test("2d a thread that became a card (card.thread is another id) is read through the page's SHOWN cards: the Ack does not resolve it while the card is in flight", () => {
  const docs = {
    initiatives: { c1: { status: "active", name: "A card", thread: "t-1" } }, waiting: {}, threads: {}, ideas: {},
    messages: { m1: { thread: "t-1", from: "Manager", text: "on it", at: NOW - 3 * MIN }, m2: { thread: "t-1", from: OWNER, text: "ok", at: NOW - 2 * MIN, kind: "ack", resolved: true } },
  };
  const t = oldTabs(docs, { now: NOW, owner: OWNER });
  assert.equal(t.counts.resolved, 0, "threadCard finds the card in state.initiatives, which the page's draw step fills");
  assert.deepEqual(t.cards.map((c) => [c.id, c.status]), [["c1", "active"]]);
  const done = oldTabs({ ...docs, initiatives: { c1: { status: "done", name: "A card", thread: "t-1" } } }, { now: NOW, owner: OWNER });
  assert.equal(done.counts.resolved, 1, "once the card is done the Ack resolves it");
});

test("the page's cards: one closed by evidence reads done, so In flight is read off the page, not a rule here", () => {
  const card = { id: "fin-1", title: "Finished", summary: null, size: "S", review_level: "Quick", created_at: NOW - 5 * DAY, updated_at: NOW - MIN };
  const live = { value: { lit: ["live"], num: 901, phase: "live", headSha12: "a1b2c3d4e5f6", signed: [], onMain: true, ci: "none", ciMin: null, liveVersion: "1.2.3", at: NOW - 5e3 } };
  const t = tabs(view({ cards: [card], evidence: { "cards.fin-1": live } }));
  assert.deepEqual(t.cards.map((c) => [c.id, c.status]), [["fin-1", "done"]]);
});

test("the owner's name in the page's config is replaced, or the loader fails loudly", async () => {
  const { loadPage } = await import("../collector/import-page.mjs");
  assert.equal(loadPage({}, { now: NOW, owner: "Ann" }).OWNER, "Ann");
});

test("a page script whose config no longer holds the owner key fails loudly, never runs with the wrong owner (#C834, Checker's survivor on 14fc4c1)", async () => {
  const { loadPage } = await import("../collector/import-page.mjs");
  // A script of a changed template: it has no "owner":"Owner" to replace. The loader is given it directly, as a changed template would reach it.
  const changed = 'const state = { initRaw: [] }; const OWNER = "Someone";';
  assert.throws(() => loadPage({}, { now: NOW, owner: "Ann", script: changed }), /owner/i);
  // The same script with the key present loads and carries the replaced name.
  const ok = 'const state = { initRaw: [], initiatives: [] }; const CONFIG = {"owner":"Owner"}; const OWNER = CONFIG.owner;';
  assert.throws(() => loadPage({}, { now: NOW, owner: "Ann", script: ok }), (e) => !/owner key|no longer holds/i.test(e.message), "with the key present the guard does not fire (a later error about the stub script is fine)");
});

test("the old side is the page's code too: oldTabs reads the export's documents", () => {
  const docs = { initiatives: {}, waiting: { w1: { kind: "decision", text: "q", options: [{ key: "A", label: "A" }], since: NOW - DAY } }, messages: {}, threads: {}, ideas: { i1: { text: "idea", since: NOW - DAY } } };
  const t = oldTabs(docs, { now: NOW, owner: OWNER });
  assert.deepEqual([t.counts.you, t.counts.ideas], [1, 1]);
});

test("the post-import view lays the plan's rows into a copy: the store's view is never changed", () => {
  const v = view({ asks: [ask("o-1", "Action")] });
  const before = JSON.stringify(v);
  const out = postImportView(v, { asks: [ask("n-1", "Action")], messages: [] }, { asks: [], closeOpen: [{ id: "o-1", closed_at: NOW }], messages: [], resolve: [], threads: [], historyCards: [] });
  assert.equal(JSON.stringify(v), before);
  assert.deepEqual(out.asks.map((a) => [a.id, a.closed_at ? "closed" : "open"]), [["o-1", "closed"], ["n-1", "open"]]);
});
