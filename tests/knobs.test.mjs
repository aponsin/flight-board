import { test } from "node:test";
import assert from "node:assert/strict";
import { KNOBS, resolveKnobs, knobsShape, knobFrom } from "../worker/knobs.mjs";

test("no ops section: every default, nothing ignored", () => {
  const r = resolveKnobs(undefined);
  assert.deepEqual(r.ignored, []);
  for (const [k, d] of Object.entries(KNOBS)) assert.equal(r.values[k], d.default);
});

test("a value in bounds is used", () => {
  const r = resolveKnobs({ staleAfterSec: 180 });
  assert.equal(r.values.staleAfterSec, 180);
  assert.deepEqual(r.ignored, []);
});

test("too low falls back to the default and is named", () => {
  const r = resolveKnobs({ staleAfterSec: 5 });
  assert.equal(r.values.staleAfterSec, KNOBS.staleAfterSec.default);
  assert.deepEqual(r.ignored, [{ key: "staleAfterSec", why: "too low" }]);
});

test("too high falls back to the default and is named", () => {
  const r = resolveKnobs({ staleAfterSec: 999999 });
  assert.equal(r.values.staleAfterSec, KNOBS.staleAfterSec.default);
  assert.deepEqual(r.ignored, [{ key: "staleAfterSec", why: "too high" }]);
});

test("not a number falls back to the default and is named", () => {
  for (const bad of ["180", null, NaN, Infinity, {}, [], true]) {
    const r = resolveKnobs({ staleAfterSec: bad });
    assert.equal(r.values.staleAfterSec, KNOBS.staleAfterSec.default, String(bad));
    assert.deepEqual(r.ignored, [{ key: "staleAfterSec", why: "not a number" }], String(bad));
  }
});

test("an ops section that is not an object is unreadable; defaults stand", () => {
  const r = resolveKnobs([1, 2]);
  assert.deepEqual(r.ignored, [{ key: "ops", why: "unreadable" }]);
  assert.equal(r.values.evidenceIntervalSec, 60);
});

test("an unknown key is named and changes nothing", () => {
  const r = resolveKnobs({ madeUp: 5 });
  assert.deepEqual(r.ignored, [{ key: "madeUp", why: "unknown setting" }]);
});

test("slowRunSec must stay under the limit", () => {
  const r = resolveKnobs({ evidenceLimitSec: 100, slowRunSec: 120 });
  assert.equal(r.values.evidenceLimitSec, 100);
  assert.ok(r.values.slowRunSec < 100);
  assert.deepEqual(r.ignored, [{ key: "slowRunSec", why: "not under evidenceLimitSec" }]);
});

test("the shape accepts a resolved answer and refuses strangers", () => {
  assert.equal(knobsShape(resolveKnobs({ staleAfterSec: 5 })), true);
  assert.equal(knobsShape({ values: { nope: 1 }, ignored: [] }), false);
  assert.equal(knobsShape({ values: { staleAfterSec: "x" }, ignored: [] }), false);
  assert.equal(knobsShape({ values: {}, ignored: [{ key: "a<b", why: "x" }] }), false);
  assert.equal(knobsShape({ values: {}, ignored: [], extra: 1 }), false);
});

test("inherited names are never settings (Security's LOW on d24fd7c2)", () => {
  for (const name of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
    assert.equal(knobsShape({ values: JSON.parse(`{"${name}":5}`), ignored: [] }), false, name);
    const r = resolveKnobs(JSON.parse(`{"${name}":5}`));
    assert.deepEqual(r.ignored, [{ key: name, why: "unknown setting" }], name);
    assert.equal(Object.keys(r.values).length, Object.keys(KNOBS).length, name);
  }
  assert.equal(knobsShape({ values: { toString: 5 }, ignored: [] }), false);
  assert.equal(knobsShape({ values: { constructor: 5 }, ignored: [] }), false);
});

test("the Worker side reads a stored value only when valid", () => {
  assert.equal(knobFrom({ values: { staleAfterSec: 200 } }, "staleAfterSec"), 200);
  assert.equal(knobFrom({ values: { staleAfterSec: 1 } }, "staleAfterSec"), 300);
  assert.equal(knobFrom(null, "staleAfterSec"), 300);
});
