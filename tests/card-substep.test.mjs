// A card's line shows its running sub-step (#C417, the owner saw "nothing moved for 20 minutes" while three versions
// shipped; his B): the sub-step, its age and who is next, a thin bar under it, and past 2× its median the row goes amber
// with the usual time instead of the ETA. From the steps collection only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const T = Date.UTC(2026, 9, 28, 20, 0), MIN = 60e3;
const card = (x = {}) => ({ id: "card-a", num: 410, name: "Ship turn alone", size: "S", status: "active", phase: "checker", who: "Boardsmith", branch: "b", thread: "t-1", skip: ["language", "design", "security"], createdAt: T - 9e6, ...x });
// Three past cards, each step taking the given minutes: test 6, checker 12, ship 5, and CI 4 on the live step.
function history() {
  const out = [];
  ["p1", "p2", "p3"].forEach((init, k) => {
    let at = T - (k + 2) * 36e5;
    for (const [phase, who, m] of [["test", "Builder", 6], ["checker", "Checker", 12], ["ship", "Release", 5]]) {
      out.push({ init, phase, who, kind: "start", at }, { init, phase, who, kind: "end", at: at + m * MIN });
      at += m * MIN;
    }
    out.push({ init, phase: "live", who: "Release", kind: "end", at, version: "v1.0." + k, testsMin: 4, deployMin: 2 });
  });
  return out;
}
function board(c, steps) {
  const b = loadNames(["cardLine", "withLine", "liveSubstep", "stepMedians"]);
  Object.assign(b.state, { steps: [...history(), ...steps], derived: [], waiting: [], messages: [], threads: [], initRaw: [c], initiatives: [c] });
  return b;
}
const text = (h) => h.replace(/<span class="ss-bar"[^]*?<\/span>/, "").replace(/<[^>]+>/g, "");

test("a running sub-step: what, its age and who is next, with the bar; the ETA stays", () => {
  const b = board(card({ phase: "test", etaLive: T + 40 * MIN }), [{ init: "card-a", phase: "build", who: "Boardsmith", kind: "start", at: T - 30 * MIN }, { init: "card-a", phase: "build", who: "Boardsmith", kind: "end", at: T - 3 * MIN }, { init: "card-a", phase: "test", who: "Builder", kind: "start", at: T - 3 * MIN }]);
  const h = b.cardLine("t-1", T);
  assert.match(text(h), /^→ #C410 · e2e running 3 min · then Checker( · ~\d.*)?$/, text(h));
  assert.match(h, /<span class="ss">e2e running <span class="nw">3 min<\/span><\/span>/, "the age never splits");
  assert.match(h, /<span class="ss-bar" aria-hidden="true"><i style="width:25%"><\/i><\/span>$/, "3 of 6 min: a quarter of the 2× bar");
  assert.match(h, /<span class="ss-eta"> · <span class="nw">then Checker<\/span><\/span><span class="ss-eta"> · ~/, "'then' and the ETA can give way");
  assert.match(page, /@media \(max-width:600px\)\{\.ss-eta\{display:none\}\}/, "on a phone they do: two lines (Manager)");
});

test("a reviewer by name; skipped phases are skipped for 'then'", () => {
  const b = board(card(), [{ init: "card-a", phase: "checker", who: "Checker", kind: "start", at: T - 6 * MIN }]);
  assert.match(text(b.cardLine("t-1", T)), /^→ #C410 · Checker reviewing 6 min · then Ship/);
  const full = board(card({ skip: ["language", "design"] }), [{ init: "card-a", phase: "checker", who: "Checker", kind: "start", at: T - 6 * MIN }]);
  assert.match(text(full.cardLine("t-1", T)), /· then Security/, "a Full card goes to Security next");
});

test("a ship: CI minutes against the median test minutes; nothing after ship but live", () => {
  const b = board(card({ phase: "ship" }), [{ init: "card-a", phase: "ship", who: "Release", kind: "start", at: T - 2 * MIN }]);
  const h = b.cardLine("t-1", T);
  assert.match(text(h), /^→ #C410 · Release shipping · CI 2\/4 min( · ~\d.*)?$/, text(h));
  assert.ok(h.includes('<span class="nw">CI 2/4 min</span>'), "never split");
});

test("past 2× the median: amber, the usual time, no ETA; at 2× not yet", () => {
  const b = board(card(), [{ init: "card-a", phase: "checker", who: "Checker", kind: "start", at: T - 41 * MIN }]);
  const h = b.cardLine("t-1", T);
  assert.equal(text(h), "→ #C410 · Checker reviewing 41 min (usually 12) · then Ship");
  assert.match(h, /<span class="ss slow">.*<span class="nw">\(usually 12\)<\/span><\/span>/);
  assert.match(h, /width:100%/, "the bar full");
  const at2 = board(card(), [{ init: "card-a", phase: "checker", who: "Checker", kind: "start", at: T - 24 * MIN }]);
  assert.ok(!at2.cardLine("t-1", T).includes("slow"), "exactly 2× isn't slow");
  assert.match(page, /\.w-row:has\(\.ss\.slow\)\{background:var\(--warn-soft\)/, "the row turns amber");
  assert.match(page, /--warn-ink:#9a5700/, "the darker amber for text (Designer)");
});

test("no median yet (under 3 samples): the words, no bar, never amber", () => {
  const b = board(card({ phase: "language", skip: ["security"] }), [{ init: "card-a", phase: "language", who: "Linguist", kind: "start", at: T - 300 * MIN }]);
  const h = b.cardLine("t-1", T);
  assert.match(text(h), /^→ #C410 · Linguist reviewing 5 h · then Checker/);
  assert.ok(!h.includes("ss-bar") && !h.includes("slow"));
});

test("nothing running (the last step ended, or only a live step): the phase and the ETA, as before", () => {
  const ended = board(card(), [{ init: "card-a", phase: "checker", who: "Checker", kind: "start", at: T - 9 * MIN }, { init: "card-a", phase: "checker", who: "Checker", kind: "end", at: T - MIN }]);
  assert.match(text(ended.cardLine("t-1", T)), /^→ #C410 · Checker( · ~\d.*)?$/);
  assert.equal(ended.liveSubstep("card-a"), null);
  const none = board(card(), []);
  assert.match(text(none.cardLine("t-1", T)), /^→ #C410 · Checker/);
  const live = board(card(), [{ init: "card-a", phase: "live", who: "Release", kind: "start", at: T - MIN }]);
  assert.equal(live.liveSubstep("card-a"), null, "a live start isn't a sub-step");
});

test("the medians: per phase from start to end, CI from the live steps; worked out once per data update", () => {
  const b = board(card(), []);
  const m = b.stepMedians();
  assert.equal(m.test, 6 * MIN); assert.equal(m.checker, 12 * MIN); assert.equal(m.ship, 5 * MIN); assert.equal(m.ci, 4 * MIN);
  assert.equal(b.stepMedians(), m, "memoized");
  b.state.steps = [...b.state.steps];
  assert.notEqual(b.stepMedians(), m, "a new update, worked out again");
});

test("who comes from the steps and is escaped", () => {
  const b = board(card({ phase: "build" }), [{ init: "card-a", phase: "build", who: "<b>x</b>", kind: "start", at: T - MIN }]);
  assert.ok(b.cardLine("t-1", T).includes("&lt;b&gt;x&lt;/b&gt; building"));
});
