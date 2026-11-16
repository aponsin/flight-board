import { test } from "node:test";
import assert from "node:assert/strict";
import { knobsOf, knobsWrite, evidenceDue } from "../collector/probe-evidence.mjs";
import { evidenceRefusal, liveNow, e2eWake, staleMsOf, STALE_AFTER_MS } from "../worker/board-rules.mjs";
import { headerHtml } from "../worker/page-header.mjs";
import { probeDoc } from "../worker/compat-view.mjs";
import { checkConfig } from "../scripts/config.mjs";

const cfg = (ops) => JSON.stringify({ ops });

test("the probe reads the ops section at every run, nothing reinstalled: a changed file is a changed value", () => {
  let text = cfg({ staleAfterSec: 250 });
  assert.equal(knobsOf("/c", () => text).values.staleAfterSec, 250);
  text = cfg({ staleAfterSec: 400 });
  assert.equal(knobsOf("/c", () => text).values.staleAfterSec, 400);
});

test("a config that cannot be read gives the defaults, and knobsWrite posts nothing for it", () => {
  assert.equal(knobsOf("/c", () => { throw new Error("none"); }).values.staleAfterSec, 300);
  assert.equal(knobsOf("/c", () => "{not json").values.evidenceIntervalSec, 60);
  assert.equal(knobsWrite("{not json"), null);
});

test("knobsWrite posts the resolved values and names each ignored setting: too low, too high, not a number", () => {
  const lines = [];
  const w = knobsWrite(cfg({ staleAfterSec: 5, probeSilentSec: 99999, evidenceLimitSec: "x" }), { log: (l) => lines.push(l) });
  assert.equal(w.key, "knobs");
  assert.equal(w.value.values.staleAfterSec, 300);
  assert.equal(w.value.values.probeSilentSec, 300);
  assert.equal(w.value.values.evidenceLimitSec, 170);
  assert.deepEqual(w.value.ignored.map((i) => `${i.key}:${i.why}`).sort(), ["evidenceLimitSec:not a number", "probeSilentSec:too high", "staleAfterSec:too low"]);
  assert.match(lines.join("\n"), /ignored/);
  assert.equal(evidenceRefusal("knobs", w.value, "probe"), null, "the Worker takes what the probe posts");
});

test("the Worker takes knobs only from the probe and only in its shape", () => {
  assert.equal(evidenceRefusal("knobs", { values: {}, ignored: [] }, "Builder")?.rule, "only-probe-writes-status");
  assert.equal(evidenceRefusal("knobs", { values: { toString: 1 }, ignored: [] }, "probe")?.rule, "knobs-shape");
  assert.equal(evidenceRefusal("knobs", { values: { staleAfterSec: "x" }, ignored: [] }, "probe")?.rule, "knobs-shape");
  assert.equal(evidenceRefusal("knobs", "x", "probe")?.rule, "knobs-shape");
});

test("the evidence job is due only when its interval has passed since the last start (launchd fires every minute)", () => {
  let kept = null, writes = 0;
  const o = { stateFile: "/s/state.json", intervalSec: 180, read: () => { if (kept === null) throw new Error("none"); return kept; }, write: (_p, t) => { kept = t; writes++; } };
  assert.equal(evidenceDue({ ...o, now: 1_000_000 }), true, "the first run");
  assert.equal(evidenceDue({ ...o, now: 1_060_000 }), false, "a minute later: skipped");
  assert.equal(evidenceDue({ ...o, now: 1_120_000 }), false, "two minutes: skipped");
  assert.equal(evidenceDue({ ...o, now: 1_176_000 }), true, "three minutes less launchd's slack: runs");
  assert.equal(writes, 2, "a skipped run records nothing");
  assert.equal(evidenceDue({ ...o, intervalSec: 60, now: 1_236_000 }), true, "back to 60: every minute");
  assert.equal(evidenceDue({ ...o, now: 1_100_000 }), true, "a clock that went backwards never blocks the job");
});

test("the Worker's edges follow the posted setting; with none, or one out of bounds, the default", () => {
  const reading = { version: "v1", readAt: 1_000_000 };
  assert.equal(liveNow(reading, 1_000_000 + 250_000, staleMsOf({ values: { staleAfterSec: 200 } })).state, "stale");
  assert.equal(liveNow(reading, 1_000_000 + 250_000, staleMsOf(null)).state, "live");
  assert.equal(liveNow(reading, 1_000_000 + 250_000, staleMsOf({ values: { staleAfterSec: 1 } })).state, "live", "out of bounds: the default");
  assert.equal(staleMsOf(undefined), STALE_AFTER_MS);
  const value = { state: "red", reason: "x", run: null, lastGreenAt: null };
  assert.ok(e2eWake({ now: 1_250_000, value, readAt: 1_000_000, staleMs: 300_000 }));
  assert.equal(e2eWake({ now: 1_250_000, value, readAt: 1_000_000, staleMs: 200_000 }), null);
});

test("the header names each ignored setting and why; none ignored, no chip", () => {
  const view = { live: { state: "live", version: "v1", age: 1000 }, probe: { state: "ok", lastAt: 1 } };
  assert.doesNotMatch(headerHtml(view), /Settings/);
  const html = headerHtml({ ...view, knobsIgnored: [{ key: "staleAfterSec", why: "too low" }, { key: "evidenceLimitSec", why: "not a number" }] });
  assert.match(html, /staleAfterSec ignored: too low; evidenceLimitSec ignored: not a number/);
  assert.match(headerHtml({ ...view, knobsIgnored: [{ key: "<b>", why: "x" }] }), /&lt;b&gt; ignored: x/, "escaped");
});

test("the view carries the ignored list when there is one", () => {
  const base = { now: 5_000_000, cards: [], evidence: {} };
  const out = (knobs) => probeDoc({ ...base, evidence: knobs ? { knobs: { value: knobs, readAt: base.now } } : {} });
  assert.equal(out(null).knobs, undefined);
  assert.equal(out({ values: {}, ignored: [] }).knobs, undefined);
  assert.deepEqual(out({ values: {}, ignored: [{ key: "staleAfterSec", why: "too low" }] }).knobs, { ignored: [{ key: "staleAfterSec", why: "too low" }] });
});

test("the config accepts an ops section and never refuses the file for a bad number", () => {
  const problems = checkConfig({ ops: { staleAfterSec: "oops", madeUp: 1 } });
  assert.deepEqual(problems.filter((p) => /ops/.test(p)), []);
});
