import test from "node:test";
import assert from "node:assert/strict";
import { isReady, readyOf } from "../collector/ready-rule.mjs";

const WORKING = "#C719: part 2\n\nbody\n\nBoard-Id: refactor-step1-store\nCo-Authored-By: Someone <a@b.c>\n";
const READY = `${WORKING}Ready: refactor-step1-store\n`;

test("a Board-Id trailer alone is work in progress, not READY (the false READY on refactor-step1-store)", () => {
  assert.equal(isReady(WORKING, "refactor-step1-store", 0), false);
});

test("an explicit Ready trailer naming this card counts", () => {
  assert.equal(isReady(READY, "refactor-step1-store", 0), true);
  assert.deepEqual(readyOf(READY), ["refactor-step1-store"]);
});

test("a Ready trailer naming another card does not", () => {
  assert.equal(isReady(READY, "some-other-card", 0), false);
});

test("a sign-off note on the head counts", () => {
  assert.equal(isReady(WORKING, "refactor-step1-store", 1), true);
});

test("the word ready inside prose is not a trailer", () => {
  assert.equal(isReady("The work is Ready: refactor-step1-store soon\n", "refactor-step1-store", 0), false);
  assert.equal(isReady("", "x", 0), false);
  assert.equal(isReady(undefined, "x", 0), false);
});
