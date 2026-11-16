// #C1114 part 2: the red "Unexplained rework" chip. The store holds a step back from a review phase with no FINDINGS note and no reason as evidence
// rework "unexplained" (+ reworkAt); compatView carries it to the card (unexplainedRework, unexplainedAt) and the page draws the chip on that card's row.
import test from "node:test";
import assert from "node:assert/strict";
import { drawPage } from "./helpers/draw-page.mjs";
import { initiativeDoc } from "../worker/compat-view.mjs";

const NOW = Date.now();
const card = { id: "c", num: 962, title: "A card", owner_role: "Builder", size: "S", created_at: NOW - 3600e3, updated_at: NOW };
const ev = (value) => ({ value: { lit: ["checker"], phase: "checker", ...value } });

test("compatView: the evidence flag rework 'unexplained' becomes unexplainedRework and unexplainedAt; rework true and no rework do not", () => {
  const held = initiativeDoc(card, ev({ rework: "unexplained", reworkAt: NOW - 5 * 60e3 }));
  assert.equal(held.unexplainedRework, true);
  assert.equal(held.unexplainedAt, NOW - 5 * 60e3);
  assert.equal(initiativeDoc(card, ev({ rework: true })).unexplainedRework, undefined);
  assert.equal(initiativeDoc(card, ev({})).unexplainedRework, undefined);
  assert.equal(initiativeDoc(card, undefined).unexplainedRework, undefined);
});

const drawn = (extra) => drawPage({ initiatives: [{ id: "c", name: "A card", num: 962, status: "active", phase: "checker", who: "Builder", size: "S", createdAt: NOW - 3600e3, ...extra }] }).html;

test("the page: a card held as unexplained rework wears the red chip, with how long; any other card does not; a closed card never does", () => {
  const html = drawn({ unexplainedRework: true, unexplainedAt: NOW - 5 * 60e3 });
  assert.match(html, /class="unexplained-chip"[^>]*>Unexplained rework · /);
  assert.doesNotMatch(drawn({}), /Unexplained rework/);
  assert.doesNotMatch(drawn({ unexplainedRework: false }), /Unexplained rework/);
  assert.doesNotMatch(drawn({ unexplainedRework: true, status: "done", doneAt: NOW }), /Unexplained rework/);
});
