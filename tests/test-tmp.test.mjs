// #C989: the test run's own temp folder and its leftover guard (scripts/test-tmp.mjs), and the preload that removes each
// test file's mkdtemp folders (tests/helpers/clean-tmp.mjs). Must still allow, as tests: a folder kept on purpose (keep-*); the
// folders of another run still in progress; node's own compile cache; the command's own exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leftovers, leftoverLine } from "../scripts/test-tmp.mjs";

const WRAPPER = new URL("../scripts/test-tmp.mjs", import.meta.url).pathname;
const PRELOAD = new URL("./helpers/clean-tmp.mjs", import.meta.url).pathname;
// Runs the wrapper with `base` as the system temp folder, on a node script given as text.
const wrap = (base, script) => spawnSync(process.execPath, [WRAPPER, process.execPath, "-e", script], { env: { ...process.env, TMPDIR: base }, encoding: "utf8" });
const LEAK = (name) => `require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), ${JSON.stringify(name)}))`;

test("leftovers: keep-* is kept, node's compile cache is no test's, everything else is left behind, counted by prefix", () => {
  const r = leftovers(["keep-debug-abc123", "node-compile-cache", "fb-state-AbC123", "fb-state-XyZ789", "sd-q1w2e3"]);
  assert.deepEqual(r.kept, ["keep-debug-abc123"]);
  assert.deepEqual(r.left, ["fb-state-AbC123", "fb-state-XyZ789", "sd-q1w2e3"]);
  assert.deepEqual(r.byPrefix, { "fb-state": 2, sd: 1 });
  assert.match(leftoverLine(r), /left 3 temp folders \(fb-state ×2, sd ×1\)/);
  assert.deepEqual(leftovers(["keep-x", "node-compile-cache"]).left, []);
});

test("a run that leaves a folder fails, says which, and its own temp folder is gone afterwards", () => {
  const base = mkdtempSync(join(tmpdir(), "tt-base-"));
  const r = wrap(base, LEAK("fb-state-test-"));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /left 1 temp folder \(fb-state-test ×1\)/);
  assert.deepEqual(readdirSync(base), [], "the run's folder and the leak inside it are removed: nothing piles up");
});

test("a clean run passes; the command's own failure code comes through", () => {
  const base = mkdtempSync(join(tmpdir(), "tt-base-"));
  assert.equal(wrap(base, "process.exit(0)").status, 0);
  assert.equal(wrap(base, "process.exit(3)").status, 3);
  const both = wrap(base, `${LEAK("x-")}; process.exit(3)`);
  assert.equal(both.status, 3, "a failing run that also leaks keeps its own code");
  assert.match(both.stderr, /left 1 temp folder/);
  assert.deepEqual(readdirSync(base), []);
});

test("must still allow: a keep-* folder survives the run, moved up and named; it fails nothing", () => {
  const base = mkdtempSync(join(tmpdir(), "tt-base-"));
  const r = wrap(base, LEAK("keep-debug-"));
  assert.equal(r.status, 0, r.stderr);
  const kept = readdirSync(base);
  assert.equal(kept.length, 1);
  assert.match(kept[0], /^keep-debug-/);
  assert.match(r.stderr, new RegExp(`kept .*${kept[0]}`));
});

test("must still allow: another run in progress is never counted or touched", () => {
  const base = mkdtempSync(join(tmpdir(), "tt-base-"));
  const other = join(base, "testrun-other1"); mkdirSync(other); writeFileSync(join(other, "fb-state-abc123"), "busy");
  assert.equal(wrap(base, "process.exit(0)").status, 0);
  assert.ok(existsSync(join(other, "fb-state-abc123")), "the other run's folder is as it was");
});

test("the preload removes every mkdtemp a test file makes (sync, callback and promise) and keeps keep-*", () => {
  const base = mkdtempSync(join(tmpdir(), "tt-base-"));
  const script = `const fs = require("fs"), p = require("path"), t = require("os").tmpdir();
    fs.mkdtempSync(p.join(t, "s-"));
    fs.mkdtemp(p.join(t, "c-"), () => {});
    fs.promises.mkdtemp(p.join(t, "q-"));
    fs.mkdtempSync(p.join(t, "keep-me-"));`;
  const r = spawnSync(process.execPath, ["--import", PRELOAD, "-e", script], { env: { ...process.env, TMPDIR: base }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const left = readdirSync(base);
  assert.equal(left.length, 1, left.join());
  assert.match(left[0], /^keep-me-/);
});

test("npm test goes through the guard and the preload", () => {
  const unit = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts.test;
  assert.match(unit, /node scripts\/test-tmp\.mjs node --import \.\/tests\/helpers\/clean-tmp\.mjs --test tests\//);
});
