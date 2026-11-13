// #C1059: `npm test` runs the suite in a temp folder of its own (scripts/test-run.mjs). A test that makes a folder with mkdtemp, in its own process or in a node
// process it starts, has it removed when that process ends (scripts/test-tmp-clean.mjs, preloaded); a folder made another way is named by the wrapper and fails
// the run. These tests drive the wrapper with tiny fixture tests, never the suite.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { leftovers, leftoverLine, leftoverGroups, prefixOf, runSuite, sizeOf } from "../scripts/test-run.mjs";

const scratch = [];
const make = () => { const d = mkdtempSync(join(tmpdir(), "trl-")); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

// A fixture test file: the body runs inside a node:test test, in a process the wrapper starts with the suite's TMPDIR.
function fixture(dir, name, body) {
  const f = join(dir, `${name}.test.mjs`);
  writeFileSync(f, `import test from "node:test";\nimport { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\nimport { spawnSync } from "node:child_process";\ntest("${name}", () => {\n${body}\n});\n`);
  return f;
}
// The wrapper's own spawn, with the fixture's output thrown away. NODE_TEST_CONTEXT is dropped: this file runs under node --test, and with it set the inner
// node --test would take itself for a test child, run nothing and exit 0.
const run = (files, parent) => runSuite({ args: files, parent, cwd: process.cwd(), run: (cmd, args, o) => { const { NODE_TEST_CONTEXT, ...env } = o.env; return spawnSync(cmd, args, { ...o, env, stdio: "ignore" }); } });

test("prefixOf: mkdtemp's six characters and a shell's tmp.XXXX are taken off, so a name shows the prefix to grep for", () => {
  assert.equal(prefixOf("fb-Ab3dEf"), "fb-");
  assert.equal(prefixOf("board-release-suite-x1Y2z3"), "board-release-suite-");
  assert.equal(prefixOf("tmp.Ab3dEf12"), "tmp.");
  assert.equal(prefixOf("short"), "short");
});

test("leftovers: a missing root leaves nothing; entries come biggest first with their sizes, names breaking a tie", () => {
  assert.deepEqual(leftovers(join(make(), "nope")), []);
  const root = make();
  mkdirSync(join(root, "b-aaaaaa")); writeFileSync(join(root, "b-aaaaaa", "f"), "x".repeat(100));
  writeFileSync(join(root, "a-bbbbbb"), "x".repeat(10));
  writeFileSync(join(root, "a-cccccc"), "x".repeat(10));
  assert.deepEqual(leftovers(root), [{ name: "b-aaaaaa", bytes: 100 }, { name: "a-bbbbbb", bytes: 10 }, { name: "a-cccccc", bytes: 10 }]);
  assert.equal(sizeOf(join(root, "b-aaaaaa")), 100);
});

test("leftoverLine: empty for nothing; otherwise the count, the size and each prefix with its count, and 'and N more' past the limit", () => {
  assert.equal(leftoverLine([]), "");
  const list = [{ name: "fb-aaaaaa", bytes: 1048576 }, { name: "fb-bbbbbb", bytes: 1048576 }, { name: "grp-cccccc", bytes: 10 }];
  assert.match(leftoverLine(list), /^TEST TEMP LEFTOVERS: 3 entries, 2\.0 MB, .*fb-\* x2 \(2\.0 MB\), grp-\* x1/);
  assert.match(leftoverLine([list[0]]), /: 1 entry, /);
  assert.match(leftoverLine(list, 1), /and 1 more prefixes\./);
  assert.deepEqual(leftoverGroups(list).map((g) => [g.prefix, g.count]), [["fb-", 2], ["grp-", 1]]);
});

test("runSuite: a folder made with mkdtemp, in the test or in a node process it starts (even one that ends with process.exit), is removed; the run is clean", () => {
  const dir = make(), parent = make();
  const a = fixture(dir, "own", `mkdtempSync(join(tmpdir(), "own-"));`);
  const b = fixture(dir, "child", `spawnSync(process.execPath, ["-e", "require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'kid-')); process.exit(0)"]);`);
  const r = run([a, b], parent);
  assert.equal(r.status, 0);
  assert.deepEqual(r.left, []);
  assert.equal(existsSync(r.root), false, "the run's own root is removed");
});

test("runSuite: a folder made some other way is left, and named; the wrapper still removes the root so it does not pile up", () => {
  const dir = make(), parent = make();
  const leaky = fixture(dir, "leaky", `mkdirSync(join(tmpdir(), "leaky-abc123"));`);
  const r = run([leaky], parent);
  assert.equal(r.status, 0, "the tests passed; the leak is the wrapper's to report");
  assert.deepEqual(r.left.map((x) => x.name), ["leaky-abc123"]);
  assert.equal(existsSync(r.root), false);
});

test("runSuite: only folders directly in the run's own root are removed, never one elsewhere", () => {
  const dir = make(), parent = make(), elsewhere = make();
  const f = fixture(dir, "far", `mkdtempSync(${JSON.stringify(join(elsewhere, "keep-"))});`);
  run([f], parent);
  assert.equal(readdirSync(elsewhere).length, 1, "a mkdtemp folder outside the run's root is not the preload's to remove");
});

test("runSuite: a failing test run keeps its own exit status", () => {
  const dir = make(), parent = make();
  const bad = fixture(dir, "bad", `throw new Error("no");`);
  assert.notEqual(run([bad], parent).status, 0);
});
