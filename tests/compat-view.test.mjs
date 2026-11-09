// The compatibility view (#C723 A2): the store's rows answered in the old collection shapes, drawn by the OLD page's own render
// code (scripts/fixtures.mjs runs the page's script in a vm), so "same as the old board" is checked by the old board.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { render, observe } from "../scripts/fixtures.mjs";
import { compatView, waitingDoc, optionOfKey, optionObjects } from "../worker/compat-view.mjs";

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const NOW = Date.now();
const ask = (o) => ({ id: "t1", num: 1, type: "Action", title: "Run the install", asked_by: "Manager", card_id: null, body: JSON.stringify({ steps: ["Open Terminal.", "Run it."], expect: "done" }), eta_at: null, eta_precondition: null, created_at: NOW - 30 * 60e3, answered_at: null, answer: null, closed_at: null, ...o });
const card = (o) => ({ id: "c1", num: 1, title: "A card", summary: "", size: "S", review_level: "Quick", from_thread: null, track: "product", owner_role: "Builder", next_note: "Building it.", next_note_at: NOW - 5 * 60e3, waiting_on: null, blocked_reason: null, paused: 0, dropped: 0, rework_reason: null, created_at: NOW - 5 * 36e5, updated_at: NOW, customer_text: null, look_change: null, skip: null, ...o });
const view = (o = {}) => ({ tag: "t", now: NOW, live: { state: "unknown", age: null }, cards: [], asks: [], lists: [], evidence: {}, ...o });
const draw = (v) => render(html, compatView(v).collections);

test("an open Action ask is under Needs you, waiting on the owner", () => {
  const d = draw(view({ asks: [ask({})] }));
  const o = observe(d, "t1");
  assert.equal(o.section, "needs-you"); assert.equal(o.rows, 1); assert.equal(o.badge, "waiting on you");
});

test("a Decision keeps its options as A, B and an answer maps back to the store's string", () => {
  const body = { question: "Which hero?", options: ["Blue", "Green"], recommended: "Green" };
  const a = ask({ id: "t2", type: "Decision", title: "Hero", body: JSON.stringify(body) });
  const doc = waitingDoc(a);
  assert.deepEqual(doc.options, [{ key: "A", label: "Blue" }, { key: "B", label: "Green" }]);
  assert.equal(doc.recommended, "B"); assert.equal(doc.kind, "decision");
  assert.equal(optionOfKey(body.options, "B"), "Green"); assert.equal(optionOfKey(body.options, "Z"), undefined);
  const open = observe(draw(view({ asks: [a] })), "t2");
  assert.equal(open.section, "needs-you");
  const answered = observe(draw(view({ asks: [{ ...a, answered_at: NOW - 60e3, answer: "Blue" }] })), "t2");
  assert.equal(answered.section, "waiting-on-manager"); assert.equal(answered.badge, "with the team");
  assert.equal(waitingDoc({ ...a, answered_at: NOW, answer: "Blue" }).response.choice, "A");
});

test("a Terminal ask carries each command as a step with a Copy command; the doc has no status or phase of the ask's own", () => {
  const doc = waitingDoc(ask({ type: "Terminal", body: JSON.stringify({ commands: ["node a.mjs"] }) }));
  assert.equal(doc.kind, "action"); assert.deepEqual(doc.steps, [{ text: "Run this in Terminal:", cmd: "node a.mjs" }]);
});

test("a card is drawn on the board at the probe's lit phase, never a typed one", () => {
  const v = view({ cards: [card({})], evidence: { "cards.c1": { value: { lit: ["build"], phase: "build", headSha12: "aaaaaaaaaaaa", onMain: false }, readAt: NOW - 60e3 } } });
  const out = compatView(v);
  assert.equal(out.collections.initiatives[0].phase, "build");
  assert.equal(out.collections.derived[0].cards.c1.phase, "build");
  // The old page draws the card on its board with the probe's phase lit. (The row carries the old page's own "gap-red" because the
  // store has no ETA or plan yet: that is B3b / A4, noted in the parity list, not a drawing failure.)
  const board = draw(v).board;
  assert.match(board, /data-card="c1"/); assert.match(board, /<strong>A card<\/strong>/);
  assert.match(board, /<div class="step now" title="Build">/);
});

test("a card with no probe reading has no phase of its own", () => {
  assert.equal("phase" in compatView(view({ cards: [card({})] })).collections.initiatives[0], false);
});

test("to-do and idea rows land in their own collections, with the done flag", () => {
  const out = compatView(view({ lists: [{ id: "todo-1", kind: "todo", text: "Buy milk", area: "home", category: null, note: null, rank: 1, done: 0, done_at: null, added_at: NOW }, { id: "idea-1", kind: "idea", text: "An idea", area: null, category: "x", note: null, rank: null, done: 1, done_at: NOW, added_at: NOW }] })).collections;
  assert.deepEqual(out.todo.map((d) => [d.id, d.text, d.done]), [["todo-1", "Buy milk", false]]);
  assert.deepEqual(out.ideas.map((d) => [d.id, d.done, d.kind]), [["idea-1", true, "idea"]]);
});

test("the probe document is reassembled from the evidence keys; stuck and ship appear only when written", () => {
  const ev = { board: { value: { boardId: "b", at: NOW }, readAt: NOW }, agents: { value: { Builder: { state: "working" } }, readAt: NOW }, "cards.c1": { value: { lit: ["build"], phase: "build" }, readAt: NOW } };
  const p = compatView(view({ evidence: ev })).probe;
  assert.equal(p.v, 1); assert.deepEqual(Object.keys(p.cards.c1), ["phase"]); assert.equal("stuck" in p, false);
  assert.deepEqual(compatView(view({ evidence: { ...ev, ship: { value: { version: null, ci: "running", at: NOW }, readAt: NOW } } })).probe.ship, { version: null, ci: "running", at: NOW });
});

test("a collection the store cannot fill is left out, never invented", () => {
  const c = compatView(view()).collections;
  for (const name of ["messages", "threads", "steps", "events", "usage", "plan", "approvals", "agentPrs"]) assert.equal(name in c, false, name);
  assert.deepEqual(optionObjects(undefined), undefined);
});
