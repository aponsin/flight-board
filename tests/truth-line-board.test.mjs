// #C1386: the board draws probe.truth (cards whose stored reading disagrees with git) as one red line in the #stuck box, like the daily e2e line.
import test from "node:test";
import assert from "node:assert/strict";
import { drawPage } from "./helpers/draw-page.mjs";

const NOW = Date.now(); // the page reads its own clock
const base = (extra = {}, at = NOW - 5_000) => ({ v: 1, board: { boardId: "flight-board", at, probe: "a".repeat(12), derivedAt: NOW - 600_000, quietMin: 0 }, cards: {}, agents: {}, ...extra });
const item = (n, over = {}) => ({ card: `card-${n}`, num: n, field: "onMain", reading: "false", git: "true", ...over });
const truth = (items, count = items.length, at = NOW - 5_000) => ({ at, count, items });
const stuck = (probe) => drawPage({}, { probe, host: "store" }).els.stuck;
const lines = (el) => el.innerHTML.match(/<div class="sl-you">/g) || [];

test("absent, stale and count 0 (or not a positive integer) draw nothing", () => {
  assert.equal(stuck(base()).innerHTML, "");
  assert.equal(stuck(base()).hidden, true);
  const stale = stuck(base({ truth: truth([item(1)]) }, NOW - 10 * 60_000));
  assert.equal(stale.innerHTML, "", "the probe itself is stale");
  for (const c of [0, -1, 1.5, "2", null, NaN]) {
    const el = stuck(base({ truth: truth([item(1)], c) }));
    assert.equal(el.innerHTML, "", `count ${String(c)}`);
    assert.equal(el.hidden, true);
  }
  assert.equal(stuck(base({ truth: { at: NOW, count: 2 } })).innerHTML, "", "no items array");
});

test("one red line with the count and the first items, the card number as plain text", () => {
  const el = stuck(base({ truth: truth([item(7), item(8, { field: "notes", reading: "signed", git: "none" })]) }));
  assert.equal(el.hidden, false);
  assert.equal(lines(el).length, 1);
  assert.equal(el.innerHTML.match(/<div /g).length, 1);
  assert.match(el.innerHTML, /2 readings disagree with git/);
  assert.match(el.innerHTML, /#C7 on main: reading false, git true/);
  assert.match(el.innerHTML, /#C8 notes: reading signed, git none/);
  assert.ok(!el.innerHTML.includes("<a "), "no links");
  assert.doesNotMatch(el.innerHTML, /and \d+ more/);
  const one = stuck(base({ truth: truth([item(3)]) }));
  assert.match(one.innerHTML, /1 reading disagrees with git/);
});

test("past 5 items the line says 'and N more' from the total count", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => item(n));
  const el = stuck(base({ truth: truth(items, 23) }));
  assert.match(el.innerHTML, /23 readings disagree/);
  assert.match(el.innerHTML, /#C5 /);
  assert.doesNotMatch(el.innerHTML, /#C6 /);
  assert.match(el.innerHTML, /and 18 more/);
  assert.equal(lines(el).length, 1);
});

test("hostile text is escaped, never a raw tag", () => {
  const bad = `<img src=x onerror=alert(1)> "q" & <script>`;
  const el = stuck(base({ truth: truth([item(1, { reading: bad, git: bad, field: "<b>x</b>", card: bad, num: null })]) }));
  assert.ok(!el.innerHTML.includes("<img") && !el.innerHTML.includes("<script") && !el.innerHTML.includes("<b>"), el.innerHTML);
  assert.ok(el.innerHTML.includes("&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &amp; &lt;script&gt;"), el.innerHTML);
  assert.ok(!el.innerHTML.includes("<a "));
});

test("it sits beside the e2e line, each in its own div, and the box stays red", () => {
  const e2e = { state: "red", reason: "the daily run failed", run: null, lastGreenAt: null };
  const el = stuck(base({ e2e, truth: truth([item(4)]) }));
  assert.equal(el.innerHTML.match(/<div /g).length, 2);
  assert.match(el.innerHTML, /daily full test run failed/);
  assert.match(el.innerHTML, /1 reading disagrees with git/);
  const only = stuck(base({ e2e }));
  assert.equal(only.innerHTML.match(/<div /g).length, 1, "the e2e line alone is unchanged");
});

test("the line clears when truth turns count 0", () => {
  const d = drawPage({}, { probe: base({ truth: truth([item(1)]) }), host: "store" });
  assert.match(d.els.stuck.innerHTML, /disagree/);
  d.b.probeEvent({ type: "data", result: { payload: base({ truth: truth([], 0) }) } });
  d.b.renderAll();
  assert.equal(d.els.stuck.innerHTML, "");
  assert.equal(d.els.stuck.hidden, true);
});
