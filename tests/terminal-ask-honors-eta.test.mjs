// #C1012 (#T1865): a Terminal ask written with eta_at was nudged at 10 minutes and would have pushed to the owner's phone at 30, overnight, because only a
// Decision (not before) and a Later (its date) wait for eta_at. The store now refuses eta_at on any other type on a live write; an import keeps the old shape.
import test from "node:test";
import assert from "node:assert/strict";
import { askRefusal } from "../worker/board-rules.mjs";

const NOW = Date.UTC(2026, 10, 12, 8, 0, 0), SEVEN = NOW + 23 * 3600e3;
const terminal = (extra = {}) => ({ type: "Terminal", title: "Copy the job check", asked_by: "Manager", commands: ["node ~/x/check.mjs"], ...extra });

test("a Terminal ask with eta_at is refused on a live write, naming why; without eta_at it is fine", () => {
  const r = askRefusal(terminal({ eta_at: SEVEN }), NOW);
  assert.equal(r?.rule, "eta-unsupported");
  assert.match(r.detail, /Terminal does not wait for eta_at/);
  assert.equal(askRefusal(terminal(), NOW), null);
});

test("every other type that has no wait for eta_at is refused too, before its other parts are judged", () => {
  for (const type of ["Action", "Answer", "Approval"]) assert.equal(askRefusal({ type, title: "t", asked_by: "Manager", eta_at: SEVEN }, NOW)?.rule, "eta-unsupported", type);
});

test("a Decision (not before) and a Later (its date) still take eta_at", () => {
  const later = { type: "Later", title: "Check the deploy", asked_by: "Manager", text: "Look at the deploy", eta_at: SEVEN, eta_precondition: "the deploy is in" };
  assert.equal(askRefusal(later, NOW), null);
  const decision = { type: "Decision", title: "Pick one", asked_by: "Manager", question: "Which?", options: ["A", "B"], recommended: "A", eta_at: SEVEN };
  assert.notEqual(askRefusal(decision, NOW)?.rule, "eta-unsupported");
});

test("an import (now = null) keeps the old ask's shape: a Terminal with eta_at is not refused for it", () => {
  assert.notEqual(askRefusal(terminal({ eta_at: SEVEN }), null)?.rule, "eta-unsupported");
});
