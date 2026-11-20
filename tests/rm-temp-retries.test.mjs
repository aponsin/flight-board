// #C1367 part 2: tests/landing-refuses-data-md-edit.test.mjs once failed with ENOTEMPTY while removing its own temp git folder at the end of a loaded full suite (it passed alone).
// rmTemp (tests/harness.mjs) tries a busy folder again; these drive it with a fake remover, so no folder is made or removed and the load is not needed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTemp } from "./harness.mjs";

const busy = (code = "ENOTEMPTY") => Object.assign(new Error(`${code}, Directory not empty`), { code });
const flaky = (fails, code) => { const calls = []; const rm = (d, o) => { calls.push([d, o]); if (calls.length <= fails) throw busy(code); }; return { rm, calls }; };

test("a folder that is busy twice is removed on the third try, 50 ms apart, with the recursive and force options", () => {
  const { rm, calls } = flaky(2), waits = [];
  rmTemp("/x/y", { rm, wait: (ms) => waits.push(ms) });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], ["/x/y", { recursive: true, force: true }]);
  assert.deepEqual(waits, [50, 50]);
});

test("a folder that stays busy is given up after the limit and the busy error is thrown, never swallowed", () => {
  const { rm, calls } = flaky(99);
  assert.throws(() => rmTemp("/x/y", { rm, tries: 4, wait: () => {} }), { code: "ENOTEMPTY" });
  assert.equal(calls.length, 4);
});

test("any other error is thrown at once, with no second try", () => {
  const { rm, calls } = flaky(99, "EACCES");
  assert.throws(() => rmTemp("/x/y", { rm, wait: () => {} }), { code: "EACCES" });
  assert.equal(calls.length, 1);
});

test("with the real remover it removes a folder with files in it, and a folder that is already gone is no error", () => {
  const d = mkdtempSync(join(tmpdir(), "rmt-"));
  writeFileSync(join(d, "f"), "x");
  rmTemp(d);
  assert.equal(existsSync(d), false);
  rmTemp(d);
});
