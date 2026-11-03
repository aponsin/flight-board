// No half-live (#C635): a card that lists what must be true for it to be done (doneWhen) does not go live or done while a
// line has no end step carrying its index; a card without doneWhen is unaffected; the Collector flags one that got there anyway.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { writeErrors, mirrorErrors } from "../gate/rules.mjs";
import { halfLive, DONE_WHEN_MAX } from "../collector/rework.mjs";
import { nudges } from "../collector/nudges.mjs";

const config = fullConfig({ owner: "Sam", roster: ["Manager", "Builder"], collector: { repoPath: "/x", deployWorkflow: "CI" } });
const HOUR = 3600e3, NOW = 100 * HOUR;
const card = (extra = {}) => ({ id: "menu", num: 700, status: "active", phase: "ship", size: "S", who: "Builder", doneWhen: ["page published", "install verified"], ...extra });
const end = (n, extra = {}) => ({ id: `menu-ship-end-${n}`, init: "menu", phase: "ship", who: "Builder", kind: "end", at: NOW - HOUR, doneWhen: n, ...extra });
const mirror = (steps, k = card()) => ({ docs: { initiatives: [k], steps, messages: [], waiting: [], derived: [] }, at: NOW });
const upd = (data) => ({ op: "update", collection: "initiatives", doc_id: "menu", data });
const check = (w, steps, k) => mirrorErrors(w, { config, mirror: mirror(steps, k), now: NOW });

test("halfLive: the doneWhen indexes with no end step of the card (by id or #C number); none without doneWhen", () => {
  assert.deepEqual(halfLive(card(), []), [0, 1]);
  assert.deepEqual(halfLive(card(), [end(0)]), [1]);
  assert.deepEqual(halfLive(card(), [end(0), end(1)]), []);
  assert.deepEqual(halfLive(card(), [end(0, { init: "C700" }), end(1)]), [], "its #C number names it too");
  assert.deepEqual(halfLive(card(), [end(0, { kind: "start" }), end(1, { init: "other" })]), [0, 1], "a start step or another card's step closes nothing");
  assert.deepEqual(halfLive(card({ doneWhen: undefined }), []), []);
  assert.deepEqual(halfLive(card({ doneWhen: [] }), []), []);
});

test("rule 5b: phase live or status done is refused while a line has no step; a card without doneWhen is unaffected", () => {
  assert.match(check(upd({ phase: "live" }), [end(0)])[0], /#C700 has doneWhen lines with no step: 1 \(of 0 to 1\)/);
  assert.match(check(upd({ status: "done" }), [])[0], /doneWhen lines with no step: 0, 1 \(of 0 to 1\)/);
  assert.deepEqual(check(upd({ phase: "live" }), [end(0), end(1)]).filter((m) => /doneWhen/.test(m)), [], "every line has its step");
  assert.deepEqual(check(upd({ phase: "live" }), [], card({ doneWhen: undefined })).filter((m) => /doneWhen/.test(m)), [], "no doneWhen: unaffected");
  assert.deepEqual(check(upd({ phase: "security" }), []).filter((m) => /doneWhen/.test(m)), [], "only going live or done is held");
  assert.deepEqual(check(upd({ phase: "live" }), [], card({ phase: "live" })).filter((m) => /doneWhen/.test(m)), [], "already live: not asked again by an unrelated update");
});

test("rule 5b reads this batch's steps too", () => {
  const w = upd({ phase: "live" });
  const batch = [{ op: "set", collection: "steps", doc_id: "s0", data: end(0) }, { op: "set", collection: "steps", doc_id: "s1", data: end(1) }];
  assert.deepEqual(mirrorErrors(w, { config, mirror: mirror([]), batch, now: NOW }).filter((m) => /doneWhen/.test(m)), []);
});

test("the shapes: doneWhen on a card is 1 to 20 short lines; on a step an index, on an end step", () => {
  const e = (w) => writeErrors(w, { config, now: NOW, who: { manager: true, role: "Manager" } });
  assert.deepEqual(e(upd({ doneWhen: ["a line"] })).filter((m) => /doneWhen/.test(m)), []);
  for (const bad of [[], "a line", [""], [3], new Array(DONE_WHEN_MAX + 1).fill("x"), ["x".repeat(301)]])
    assert.match(e(upd({ doneWhen: bad })).join(), /doneWhen: a list of 1 to 20 lines/, JSON.stringify(bad).slice(0, 30));
  const step = (extra) => ({ op: "set", collection: "steps", doc_id: "s", data: { init: "menu", phase: "ship", who: "Builder", at: NOW, kind: "end", ...extra } });
  assert.deepEqual(e(step({ doneWhen: 1 })).filter((m) => /doneWhen/.test(m)), []);
  for (const bad of [{ doneWhen: -1 }, { doneWhen: "1" }, { doneWhen: 1.5 }, { doneWhen: DONE_WHEN_MAX }, { doneWhen: 1, kind: "start" }])
    assert.match(e(step(bad)).join(), /doneWhen: the index/, JSON.stringify(bad));
});

test("the Collector flags a card live or done with a line unclosed, once per set of lines left", () => {
  const docs = (k, steps) => ({ initiatives: [k], steps, ctx: [] });
  const text = (k, steps, state) => nudges({ config, docs: docs(k, steps), now: NOW, state }).lines.join("\n");
  assert.match(text(card({ phase: "live" }), [end(0)]), /HALF-LIVE menu \(#C700\): live with 1 doneWhen line\(s\) that have no end step \(lines 1\)/);
  assert.match(text(card({ status: "done" }), []), /HALF-LIVE menu \(#C700\): done with 2/);
  assert.doesNotMatch(text(card({ phase: "ship" }), []), /HALF-LIVE/, "not live yet");
  assert.doesNotMatch(text(card({ phase: "live" }), [end(0), end(1)]), /HALF-LIVE/, "every line closed");
  assert.doesNotMatch(text(card({ phase: "live", doneWhen: undefined }), []), /HALF-LIVE/, "no doneWhen");
  const first = nudges({ config, docs: docs(card({ phase: "live" }), [end(0)]), now: NOW });
  assert.doesNotMatch(nudges({ config, docs: docs(card({ phase: "live" }), [end(0)]), now: NOW + 60e3, state: first.state }).lines.join("\n"), /HALF-LIVE/, "quiet period");
});
