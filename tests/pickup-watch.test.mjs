// Steward's pickup watch (#C498) as one decision from its readings: send once the target is idle and cleared, stop once
// someone picked it up (the follow-up: a pickup before the first check, its Messages then growing at every check).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { decide, MAX_CHECKS } from "../scripts/pickup-watch.mjs";

const w = (tokens) => ({ state: "working", tokens }), i = (tokens) => ({ state: "idle", tokens });

test("tonight's case: picked up before the first check, then 14k, 26k, 37k, 52k: picked up at the second check", () => {
  assert.equal(decide([w(14_000)]), "wait", "one reading can't show growth");
  assert.equal(decide([w(14_000), w(26_000)]), "picked-up");
  assert.equal(decide([w(14_000), w(26_000), w(37_000), w(52_000)]), "picked-up");
});

test("a fresh session seen working, then idle, was picked up: no second /pickup (Checker)", () => {
  assert.equal(decide([w(14_000), i(null)]), "picked-up");
  assert.equal(decide([w(600_000), i(null)]), "send", "the old session working, then cleared and idle: send");
  assert.equal(decide([w(600_000), w(580_000), i(0)]), "send");
  assert.equal(decide([i(0), i(0)]), "send", "an idle reading reads 0: it is no fresh session seen working");
});

test("the rule as before: idle and cleared sends; working and fresh is picked up; none listed is 0", () => {
  assert.equal(decide([w(300_000), i(1_200)]), "send");
  assert.equal(decide([i(null)]), "send");
  assert.equal(decide([w(300_000), w(2_000)]), "picked-up");
});

test("not yet cleared waits: a big session working, steady or shrinking, or growing from a high start", () => {
  assert.equal(decide([w(300_000), w(301_000)]), "wait", "growing, but from a start no fresh session has");
  assert.equal(decide([w(300_000), w(300_000)]), "wait", "not growing");
  assert.equal(decide([w(300_000), w(320_000), w(310_000)]), "wait", "not at every check");
  assert.equal(decide([w(300_000), i(300_000), w(320_000)]), "wait", "an idle reading between");
  assert.equal(decide([w(20_000)]), "wait", "one low reading alone is no pickup yet");
  assert.equal(decide([]), "wait");
});

test("ten checks without an answer: give up to the keeper", () => {
  assert.equal(decide(Array.from({ length: MAX_CHECKS }, () => w(300_000))), "give-up");
  assert.equal(decide(Array.from({ length: MAX_CHECKS - 1 }, () => w(300_000))), "wait");
});

test("the command prints one word; anything unreadable is wait", () => {
  const run = (arg) => execFileSync("node", ["scripts/pickup-watch.mjs", arg], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).trim();
  assert.equal(run(JSON.stringify([w(14_000), w(26_000)])), "picked-up");
  assert.equal(run("not json"), "wait");
  assert.equal(run("{}"), "wait");
});
