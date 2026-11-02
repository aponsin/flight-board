// #C581: a card that is live while its done test is still open reads "Verifying" with the check's due time, from the
// card's own checkAt: calm and blue while it is due, amber ("check overdue") once it passes, never Stalled. Fictional board.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBoard, step } from "./harness.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const built = [step("x", "build", "Builder", "start", T), step("x", "build", "Builder", "end", T + 1)];
function card(b, fields = {}, phase = "live") {
  b.state.steps = built;
  b.state.waiting = [];
  b.state.derived = [{ id: "all", at: T + 100, cards: { x: { at: T + 100, phase, version: "1.104.1", evidence: "on main and deployed in 1.104.1" } } }];
  return b.gates(b.enrich({ id: "x", level: "Full", customerText: false, skip: ["plan"], status: "active", name: "X", ...fields }));
}
const badge = (html) => /<span class="state ([^"]*)">([^<]*)<\/span>/.exec(html).slice(1);
const old = Date.now() - 9e6;

test("live with a check due: Verifying, when the check is due, the Live step says so; never Stalled", () => {
  const b = loadBoard(), at = Date.now() + 9 * MIN;
  const i = card(b, { checkAt: at });
  const html = b.initRow({ ...i, lastStepAt: old });
  assert.deepEqual(badge(html), ["verifying", "Verifying"]);
  assert.match(html, /class="verify-line">Live · <b>checking at \d\d:\d\d [AP]M<\/b> \(in 9 min\)</);
  assert.match(html, /class="step verifying" title="Live">Live<small>check \d\d:\d\d [AP]M<\/small>/);
  assert.doesNotMatch(html, /Stalled|Live, still open|No step logged/);
});

test("the check time passed with no result: overdue in amber, still not Stalled", () => {
  const b = loadBoard();
  const i = card(b, { checkAt: Date.now() - 12 * MIN });
  const html = b.initRow({ ...i, lastStepAt: old });
  assert.deepEqual(badge(html), ["verifying", "Verifying"]);
  assert.match(html, /class="verify-line late">Live · <b>check overdue 12 min<\/b></);
  assert.doesNotMatch(html, /Stalled|No step logged/);
});

test("no checkAt, a card not live, or a done card: as before", () => {
  const b = loadBoard();
  assert.match(b.initRow(card(b)), /Live, still open/, "no checkAt");
  const early = b.initRow(card(b, { checkAt: Date.now() + 5 * MIN }, "checker"));
  assert.doesNotMatch(early, /Verifying|verify-line/, "not live yet");
  const done = b.initRow(card(b, { checkAt: Date.now() + 5 * MIN, status: "done", doneAt: Date.now() - MIN }));
  assert.doesNotMatch(done, /Verifying|verify-line/, "done");
});
