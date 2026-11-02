// #C591: the every-minute probe says when it last read the repositories fresh (cardsCheckedAt), backs off GitHub after a
// failed call, and the page's chip goes red 5 minutes after the cards were last checked.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";
import { cardsCheckedAt, ciReader, backoffOf, BACKOFF_MIN_MS, BACKOFF_MAX_MS, buildState } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const sha = (n) => String(n).padStart(40, "0");
const hh = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

test("cardsCheckedAt: now when every repository was read fresh; else the last time that was so", () => {
  assert.equal(cardsCheckedAt([{ fresh: true }, {}], NOW, null), NOW);
  assert.equal(cardsCheckedAt([{ fresh: true }, { fresh: false }], NOW, NOW - 7 * MIN), NOW - 7 * MIN);
  assert.equal(cardsCheckedAt([{ fresh: false }], NOW, null), null);
  assert.equal(cardsCheckedAt([{ fresh: false }], NOW, NOW + MIN), null, "a time in the future is none");
  assert.equal(cardsCheckedAt([{ fresh: false }], NOW, "soon"), null);
});

test("the state carries cardsCheckedAt, and a probe without it still fits", () => {
  const s = buildState({ id: "flight-board", now: NOW, probe: null, pageVersion: null, cards: {}, agents: {}, cardsChecked: NOW - MIN });
  assert.equal(s.board.cardsCheckedAt, NOW - MIN);
  const old = structuredClone(s); delete old.board.cardsCheckedAt;
  assert.deepEqual(stateErrors(old), []);
  const bad = structuredClone(s); bad.board.cardsCheckedAt = "a minute ago";
  assert.ok(stateErrors(bad).length);
});

test("gh back-off: a failed call stops gh until the wait is over; each failure in a row doubles it to a cap; a success clears it", () => {
  let calls = 0, fail = true;
  const gh = () => { calls++; if (fail) throw new Error("rate limit"); return "[]"; };
  const backoff = backoffOf(null);
  assert.deepEqual({ ...backoff }, { until: 0, wait: BACKOFF_MIN_MS });
  let ci = ciReader(gh, NOW, {}, backoff);
  ci(sha(1)); ci(sha(2));
  assert.equal(calls, 1, "the second card makes no call after the first failed");
  assert.equal(backoff.until, NOW + BACKOFF_MIN_MS);
  assert.equal(backoff.wait, 2 * BACKOFF_MIN_MS);
  ciReader(gh, NOW + 30e3, {}, backoff)(sha(3));
  assert.equal(calls, 1, "still waiting");
  ciReader(gh, NOW + 2 * MIN, {}, backoff)(sha(3));
  assert.equal(calls, 2);
  assert.equal(backoff.until, NOW + 2 * MIN + 2 * MIN);
  for (let i = 0; i < 10; i++) { backoff.until = 0; ciReader(gh, NOW, {}, backoff)(sha(4)); }
  assert.equal(backoff.wait, BACKOFF_MAX_MS, "capped");
  fail = false;
  backoff.until = 0;
  ciReader(gh, NOW, {}, backoff)(sha(5));
  assert.deepEqual({ ...backoff }, { until: 0, wait: BACKOFF_MIN_MS });
});

test("a back-off read from a file is whole numbers within bounds, nothing else", () => {
  assert.deepEqual({ ...backoffOf({ until: NOW, wait: 5 * MIN, extra: "x" }) }, { until: NOW, wait: 5 * MIN });
  assert.deepEqual({ ...backoffOf({ until: "later", wait: 1e12 }) }, { until: 0, wait: BACKOFF_MAX_MS });
  assert.deepEqual({ ...backoffOf("x") }, { until: 0, wait: BACKOFF_MIN_MS });
});

test("the chip goes red 5 minutes after the cards were last checked, and says when; fresh ones show beside the rest", () => {
  const now = Date.now();
  const make = (extra) => {
    const b = loadNames(["managerChip", "set:(p)=>{probe=p}"]);
    b.state.messages = [];
    b.set({ v: 1, board: { at: now, wakeAliveAt: now - 5e3, wakeSeenAt: null, ...extra }, cards: {}, agents: {} });
    return JSON.parse(JSON.stringify(b.managerChip(now)));
  };
  assert.deepEqual(make({ cardsCheckedAt: now - 30e3 }), { cls: "ok", text: "Manager listening" }, "#C606: fresh cards add nothing to the chip (the header stamp says when the Studio checked)");
  assert.equal(make({ cardsCheckedAt: now - 5 * MIN + 5e3 }).cls, "ok", "inside 5 minutes");
  assert.deepEqual(make({ cardsCheckedAt: now - 6 * MIN }), { cls: "bad", text: `Cards not checked since ${hh(now - 6 * MIN)}` });
  assert.deepEqual(make({ cardsCheckedAt: null }), { cls: "bad", text: "Cards not checked" });
  assert.equal(make({}).text, "Manager listening", "a probe from before #C591 says nothing of cards");
  assert.equal(make({ cardsCheckedAt: now - 6 * MIN, wakeAliveAt: null }).text, "Manager not listening · say wake up the team", "the Manager's red comes first");
});
