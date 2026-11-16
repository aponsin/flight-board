// #C1091: the suite's last lines name every failing test (file and name) and the run writes them to a file, so a run whose output was cut off still shows what failed
// (11-16: Checker 2's first full run on #C1075 v3 went red, the output was cut, and the rerun was green: an unknown flake). These tests drive scripts/test-run.mjs
// with tiny fixture test files, never the suite.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { failuresLine, failuresOf, FAILURES_COPY, FAILURES_SHOWN } from "../scripts/test-run.mjs";
import { failureLine } from "../scripts/test-failures-reporter.mjs";

const scratch = [];
const make = () => { const d = mkdtempSync(join(tmpdir(), "snfl-")); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

const file = (dir, name, src) => { const f = join(dir, `${name}.test.mjs`); writeFileSync(f, `import test, { describe, it } from "node:test";\n${src}\n`); return f; };
// The script itself, as `npm test` runs it. NODE_TEST_CONTEXT is dropped (this file runs under node --test).
const go = (files, parent) => { const { NODE_TEST_CONTEXT, ...env } = process.env; return spawnSync(process.execPath, [join(process.cwd(), "scripts", "test-run.mjs"), ...files], { cwd: process.cwd(), env: { ...env, TMPDIR: parent }, encoding: "utf8" }); };
const lastLines = (text, n) => text.trimEnd().split("\n").slice(-n);

test("a suite with one failing test prints its file and name in the last 20 lines, and the exit is not 0", () => {
  const dir = make(), parent = make();
  const f = file(dir, "one-bad", `test("passes", () => {});\ntest("the broken one", () => { throw new Error("it is broken\\nsecond line"); });`);
  const r = go([f], parent);
  assert.notEqual(r.status, 0);
  const tail = lastLines(r.stderr, 20).join("\n");
  assert.match(tail, /FAILED TESTS \(1\):/);
  assert.ok(tail.includes(`FAILED ${f}: the broken one -- it is broken`) || tail.includes(`${basename(f)}: the broken one -- it is broken`), tail);
  assert.ok(!tail.includes("second line"), "only the first line of the error");
  assert.match(lastLines(r.stderr, 1)[0], new RegExp(`^\\(the whole list: .*${FAILURES_COPY}\\)$`), "the file's path is the very last line");
});

test("the same lines are in the file the run writes, and a clean run removes it", () => {
  const dir = make(), parent = make();
  const bad = file(dir, "bad", `test("nope", () => { throw new Error("x"); });`);
  go([bad], parent);
  const copy = join(parent, FAILURES_COPY);
  assert.ok(existsSync(copy));
  assert.deepEqual(failuresOf(readFileSync(copy, "utf8")).map((l) => l.replace(/^FAILED .*?: /, "")), ["nope -- x"]);
  assert.deepEqual(readdirSync(parent), [FAILURES_COPY], "the run's own root is gone; only the copy is left");
  const ok = file(dir, "ok", `test("fine", () => {});`);
  const r = go([ok], parent);
  assert.equal(r.status, 0);
  assert.equal(existsSync(copy), false, "a green run does not leave the last red run's list");
  assert.doesNotMatch(r.stderr, /FAILED TESTS/);
});

test("every failing test is listed, a describe around them is not, and a test that only failed because a subtest did is not", () => {
  const dir = make(), parent = make();
  const f = file(dir, "many", `describe("group", () => { it("first bad", () => { throw new Error("a"); }); it("good", () => {}); it("second bad", () => { throw new Error("b"); }); });
test("outer", async (t) => { await t.test("inner bad", () => { throw new Error("c"); }); });`);
  const r = go([f], parent);
  const names = failuresOf(readFileSync(join(parent, FAILURES_COPY), "utf8")).map((l) => /: (.*?) -- /.exec(l)[1]).sort();
  assert.deepEqual(names, ["first bad", "inner bad", "second bad"]);
  assert.match(r.stderr, /FAILED TESTS \(3\):/);
});

test("a test file that crashes before its tests run is listed by its file", () => {
  const dir = make(), parent = make();
  const f = file(dir, "crash", `throw new Error("boom at load");`);
  const r = go([f], parent);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /FAILED TESTS \(\d+\):/);
  assert.ok(r.stderr.includes("crash.test.mjs"), r.stderr);
});

test("failuresLine: nothing for none; the count, the lines, the path last; 'and N more' past the limit", () => {
  assert.equal(failuresLine([], "/x"), "");
  assert.equal(failuresLine(["FAILED a: b"], "/x"), "FAILED TESTS (1):\nFAILED a: b\n(the whole list: /x)");
  const many = Array.from({ length: FAILURES_SHOWN + 3 }, (_, i) => `FAILED f${i}: n`);
  const out = failuresLine(many, "/x").split("\n");
  assert.equal(out[0], `FAILED TESTS (${many.length}):`);
  assert.equal(out.length, 1 + FAILURES_SHOWN + 1 + 1);
  assert.equal(out[1 + FAILURES_SHOWN], "... and 3 more");
  assert.equal(out.at(-1), "(the whole list: /x)");
});

test("failureLine: a suite and a parent of a failing subtest give no line; a test gives file, name and the error's first line", () => {
  assert.equal(failureLine({ name: "s", file: "/a/b.test.mjs", details: { type: "suite" } }, "/a"), null);
  assert.equal(failureLine({ name: "p", file: "/a/b.test.mjs", details: { error: { failureType: "subtestsFailed", message: "1 subtest failed" } } }, "/a"), null);
  assert.equal(failureLine({ name: "t", file: "/a/b.test.mjs", details: { error: { failureType: "testCodeFailure", message: "bad\nmore" } } }, "/a"), "FAILED b.test.mjs: t -- bad\n");
  assert.equal(failureLine({ name: "t", details: {} }, "/a"), "FAILED (no file): t\n");
});
