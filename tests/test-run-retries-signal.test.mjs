// #C1371: scripts/test-run.mjs runs a test file again, once, when a SIGNAL killed it (the node 24.21.0 V8 SIGSEGV under load, #C1370), and only then.
// A failing assertion, a process.exit and a file that dies on both runs are not retried into green. Real runs of small fixture files in a temp folder.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runSuite, diedBySignal } from "../scripts/test-run.mjs";

const mk = () => mkdtempSync(join(tmpdir(), "retry-sig-"));
// A fixture test file: `body` runs inside its one test; every start appends a line to <name>.runs so a test can count the runs.
const fixture = (dir, name, body) => {
  const f = join(dir, `${name}.test.mjs`);
  writeFileSync(f, `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { appendFileSync, existsSync, writeFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(dir, `${name}.runs`))}, "x");\nconst seen = ${JSON.stringify(join(dir, `${name}.seen`))};\ntest("${name}", () => {\n${body}\n});\n`);
  return f;
};
const runs = (dir, name) => (existsSync(join(dir, `${name}.runs`)) ? readFileSync(join(dir, `${name}.runs`), "utf8").length : 0);
// NODE_TEST_CONTEXT is dropped (this file runs under node --test; with it set the inner node would run the file as a child, not as a suite).
const go = (dir, files) => {
  const warned = [];
  const r = runSuite({ args: files, parent: dir, cwd: dir, warn: (l) => warned.push(l), run: (cmd, args, o) => { const { NODE_TEST_CONTEXT, ...env } = o.env; return spawnSync(cmd, args, { ...o, env, stdio: "ignore" }); } });
  return { ...r, warned };
};
const killFirstTime = `if (!existsSync(seen)) { writeFileSync(seen, "1"); process.kill(process.pid, "SIGKILL"); }`;

test("a file killed by a signal once is run again, alone, and the run is green with a loud warning", () => {
  const dir = mk();
  try {
    const f = fixture(dir, "flaky", killFirstTime);
    const r = go(dir, [f]);
    assert.equal(r.status, 0);
    assert.deepEqual(r.failed, []);
    assert.equal(runs(dir, "flaky"), 2);
    assert.deepEqual(r.retried, [{ file: "flaky.test.mjs", ok: true }]);
    assert.ok(r.warned.some((l) => /KILLED BY A SIGNAL: flaky\.test\.mjs/.test(l)), r.warned.join("\n"));
    assert.ok(r.warned.some((l) => /WARNING: flaky\.test\.mjs passed on its second run/.test(l)), r.warned.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a file killed by a signal on both runs fails the run, and names it", () => {
  const dir = mk();
  try {
    const f = fixture(dir, "doomed", `process.kill(process.pid, "SIGKILL");`);
    const r = go(dir, [f]);
    assert.notEqual(r.status, 0);
    assert.equal(runs(dir, "doomed"), 2, "one retry, no more");
    assert.deepEqual(r.retried, [{ file: "doomed.test.mjs", ok: false }]);
    assert.ok(r.failed.some((l) => /^FAILED doomed\.test\.mjs: killed by a signal on both runs/.test(l)), r.failed.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failing assertion is never retried: the file runs once and the run fails", () => {
  const dir = mk();
  try {
    const f = fixture(dir, "real", `assert.equal(1, 2);`);
    const r = go(dir, [f]);
    assert.notEqual(r.status, 0);
    assert.equal(runs(dir, "real"), 1);
    assert.deepEqual(r.retried, []);
    assert.deepEqual(r.warned, []);
    assert.ok(r.failed.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a file that ends with process.exit(3) is not a signal death: it runs once and the run fails", () => {
  const dir = mk();
  try {
    const f = fixture(dir, "exits", `process.exit(3);`);
    const r = go(dir, [f]);
    assert.notEqual(r.status, 0);
    assert.equal(runs(dir, "exits"), 1);
    assert.deepEqual(r.retried, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a killed file that then passes does not hide another file's real failure", () => {
  const dir = mk();
  try {
    const a = fixture(dir, "flaky", killFirstTime);
    const b = fixture(dir, "real", `assert.equal(1, 2);`);
    const r = go(dir, [a, b]);
    assert.notEqual(r.status, 0);
    assert.equal(runs(dir, "flaky"), 2);
    assert.equal(runs(dir, "real"), 1);
    assert.ok(r.failed.some((l) => l.startsWith("FAILED real.test.mjs:")), r.failed.join("\n"));
    assert.ok(!r.failed.some((l) => l.startsWith("FAILED flaky.test.mjs:")), "the passing retry leaves no failure line for the killed file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("diedBySignal lists each marker's file once, and nothing for a folder that is gone", () => {
  const dir = mk();
  try {
    mkdirSync(join(dir, "m"));
    writeFileSync(join(dir, "m", "101"), "/x/a.test.mjs");
    writeFileSync(join(dir, "m", "102"), "/x/a.test.mjs\n");
    writeFileSync(join(dir, "m", "103"), "/x/b.test.mjs");
    assert.deepEqual(diedBySignal(join(dir, "m")), ["/x/a.test.mjs", "/x/b.test.mjs"]);
    assert.deepEqual(diedBySignal(join(dir, "nope")), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
