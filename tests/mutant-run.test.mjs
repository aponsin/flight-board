// #C1115: the mutant runner (scripts/mutant-run.mjs). It refuses an edit that matches nothing, runs only the named tests in temp copies, requires a failure, and
// reports a survivor only after the full suite has had its chance at it. Real node --test runs in a small fixture repository; fictional names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { specErrors, applyMutant, runMutants, summary } from "../scripts/mutant-run.mjs";

const GUARD = `export const big = (n) => {
  if (n > 10) return "big";
  return "small";
};
export const neg = (n) => (n < 0 ? "neg" : "pos");
`;
const T = (body) => `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { big, neg } from "../src/guard.mjs";\ntest("t", () => {\n${body}\n});\n`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "fb-mutant-"));
  mkdirSync(join(dir, "src")); mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "src/guard.mjs"), GUARD);
  writeFileSync(join(dir, "tests/guard.test.mjs"), T(`assert.equal(big(11), "big"); assert.equal(big(1), "small");`));
  writeFileSync(join(dir, "tests/neg.test.mjs"), T(`assert.equal(neg(-1), "neg"); assert.equal(neg(1), "pos");`));
  writeFileSync(join(dir, "tests/other.test.mjs"), T(`assert.equal(big(1), "small");`));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  // A test that needs the repository's own git: it fails in a plain copy of the files and passes in a real working tree.
  writeFileSync(join(dir, "tests/git.test.mjs"), `import test from "node:test";\nimport { execFileSync } from "node:child_process";\ntest("needs git history", () => { execFileSync("git", ["rev-parse", "HEAD"], { stdio: "pipe" }); });\n`);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "start"], { cwd: dir });
  return dir;
}
const m = (id, extra) => ({ id, file: "src/guard.mjs", line: 2, find: "n > 10", replace: "false", tests: ["tests/guard.test.mjs"], ...extra });
const FULL = ["node", "--test"];

test("the spec: ids, a path inside the checkout, a line, the text to find, and test files; anything else is named", () => {
  assert.deepEqual(specErrors({ mutants: [m("M1")] }), []);
  assert.ok(specErrors(null).length);
  assert.ok(specErrors({ mutants: [] }).length);
  assert.match(specErrors({ mutants: [m("M1", { file: "../x.mjs" })] }).join(), /file is a path inside the checkout/);
  assert.match(specErrors({ mutants: [m("M1", { file: "/etc/passwd" })] }).join(), /file is a path/);
  assert.match(specErrors({ mutants: [m("M1", { line: 0 })] }).join(), /line/);
  assert.match(specErrors({ mutants: [m("M1", { find: "" })] }).join(), /find/);
  assert.match(specErrors({ mutants: [m("M1", { tests: [] })] }).join(), /tests/);
  assert.match(specErrors({ mutants: [m("M1", { tests: ["scripts/x.mjs"] })] }).join(), /tests/);
  assert.match(specErrors({ mutants: [m("M1"), m("M1")] }).join(), /used twice/);
});

test("applyMutant: replaces the text on that line, disables the line when there is no replacement, and refuses an edit that matches nothing", () => {
  assert.equal(applyMutant(GUARD, m("M1")).text.split("\n")[1], '  if (false) return "big";');
  assert.equal(applyMutant(GUARD, m("M1", { replace: undefined })).text.split("\n")[1], '  // MUTANT M1: if (n > 10) return "big";');
  assert.match(applyMutant(GUARD, m("M1", { line: 99 })).refused, /past the end/);
  assert.match(applyMutant(GUARD, m("M1", { find: "zzz" })).refused, /does not contain/);
  assert.match(applyMutant(GUARD, m("M1", { replace: "n > 10" })).refused, /leaves the line as it was/);
});

test("a no-op or unmatched edit is refused before anything runs, and the other mutants do not run either", async () => {
  const repo = fixture();
  try {
    const r = await runMutants({ repo, spec: { mutants: [m("M1"), m("M2", { replace: "n > 10" }), m("M3", { find: "zzz" })] }, fullCmd: FULL });
    assert.equal(r.pass, false);
    assert.deepEqual(r.results.map((x) => x.status), ["not run", "refused", "refused"]);
    assert.match(r.results[1].detail, /leaves the line as it was/);
    assert.ok(summary(r.results, r.pass).at(-1).endsWith("FAIL"));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a mutant the named tests fail on is killed; the checkout itself is never edited", async () => {
  const repo = fixture();
  try {
    const r = await runMutants({ repo, spec: { mutants: [m("M1")] }, fullCmd: FULL });
    assert.equal(r.pass, true);
    assert.equal(r.results[0].status, "killed");
    assert.match(r.results[0].detail, /tests\/guard\.test\.mjs/);
    assert.equal(readFileSync(join(repo, "src/guard.mjs"), "utf8"), GUARD, "the checkout is as it was");
    assert.ok(summary(r.results, r.pass).at(-1).startsWith("mutation check: pass"));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a survivor of the named tests meets the full suite: killed there it is named with its failing files, and only a pass there makes it a survivor", async () => {
  const repo = fixture();
  try {
    // M2: the named test never looks at neg(): the full suite does. M3: the same behaviour in other words: nothing can tell it from the original.
    const spec = { mutants: [m("M2", { line: 5, find: "n < 0", replace: "false", tests: ["tests/other.test.mjs"] }), m("M3", { line: 3, find: '"small"', replace: '"small" /* same */' })] };
    const r = await runMutants({ repo, spec, fullCmd: FULL });
    assert.equal(r.results[0].status, "killed-by-full-suite-only");
    assert.match(r.results[0].detail, /tests\/neg\.test\.mjs/);
    assert.equal(r.results[1].status, "survivor");
    assert.equal(r.pass, false, "a real survivor fails the check");
    const lines = summary(r.results, r.pass);
    assert.ok(lines.at(-1).endsWith("FAIL"));
    assert.ok(lines.some((l) => /^SURVIVOR\s+M3/.test(l)));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// Checker 2's H1 on 7c254382: a mutant that changes nothing read as killed (every copy lacked .git, so the full suite failed in each) and the run said "pass".
test("the copy is a real working tree: a comment-only mutant reads as a survivor, though the suite has a test that needs git history", async () => {
  const repo = fixture();
  try {
    const r = await runMutants({ repo, spec: { mutants: [m("C1", { line: 1, find: "export const big = (n) => {", replace: "export const big = (n) => { /* only a comment */" })] }, fullCmd: FULL });
    assert.equal(r.results[0].status, "survivor", JSON.stringify(r.results[0]));
    assert.equal(r.pass, false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("the working tree's own changes are what is mutated: an uncommitted guard, and a new uncommitted test file, are in the copy", async () => {
  const repo = fixture();
  try {
    writeFileSync(join(repo, "src/guard.mjs"), `${GUARD}export const pos = (n) => (n > 0 ? "pos" : "zero");\n`); // not committed
    writeFileSync(join(repo, "tests/pos.test.mjs"), `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { pos } from "../src/guard.mjs";\ntest("pos", () => { assert.equal(pos(1), "pos"); assert.equal(pos(0), "zero"); });\n`); // new, untracked
    const r = await runMutants({ repo, spec: { mutants: [{ id: "U1", file: "src/guard.mjs", line: 6, find: "n > 0", replace: "true", tests: ["tests/pos.test.mjs"] }] }, fullCmd: FULL });
    assert.equal(r.results[0].status, "killed", JSON.stringify(r.results[0]));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a file deleted in the working tree is gone from the copy too, so a test that is no longer there cannot kill a mutant", async () => {
  const repo = fixture();
  try {
    rmSync(join(repo, "tests/neg.test.mjs")); // tracked, deleted and not committed
    const r = await runMutants({ repo, spec: { mutants: [m("D1", { line: 5, find: "n < 0", replace: "false", tests: ["tests/other.test.mjs"] })] }, fullCmd: FULL });
    assert.equal(r.results[0].status, "survivor", "neg.test.mjs is the only test that looks at neg(), and it is deleted");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a named test file with no test in it kills nothing: the mutant goes to the full suite and is judged there", async () => {
  const repo = fixture();
  try {
    writeFileSync(join(repo, "tests/empty.test.mjs"), `// no test in here\n`);
    const r = await runMutants({ repo, spec: { mutants: [m("N1", { tests: ["tests/empty.test.mjs"] })] }, fullCmd: FULL });
    assert.equal(r.results[0].status, "killed-by-full-suite-only", "the named file could not catch it; guard.test.mjs in the full suite does");
    assert.match(r.results[0].detail, /tests\/guard\.test\.mjs/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("named tests that fail before any mutation: nothing is judged, every mutant is an error naming what failed, and the run does not pass", async () => {
  const repo = fixture();
  try {
    writeFileSync(join(repo, "tests/broken.test.mjs"), `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("red", () => { assert.equal(1, 2); });\n`);
    const r = await runMutants({ repo, spec: { mutants: [m("B1", { tests: ["tests/broken.test.mjs"] }), m("B2")] }, fullCmd: FULL });
    assert.deepEqual(r.results.map((x) => x.status), ["error", "error"]);
    assert.match(r.results[0].detail, /do not pass before any mutation/);
    assert.match(r.results[0].detail, /tests\/broken\.test\.mjs/);
    assert.equal(r.pass, false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a test that already fails in the unmutated copy (git or history the copy lacks) does not kill a mutant: the full suite counts only what the mutant newly breaks", async () => {
  const repo = fixture();
  try {
    writeFileSync(join(repo, "tests/broken.test.mjs"), `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("always red here", () => { assert.equal(1, 2); });\n`);
    const spec = { mutants: [m("M2", { line: 5, find: "n < 0", replace: "false", tests: ["tests/other.test.mjs"] }), m("M3", { line: 3, find: '"small"', replace: '"small" /* same */' })] };
    const r = await runMutants({ repo, spec, fullCmd: FULL });
    assert.equal(r.results[0].status, "killed-by-full-suite-only");
    assert.match(r.results[0].detail, /tests\/neg\.test\.mjs/);
    assert.doesNotMatch(r.results[0].detail, /broken\.test/, "the baseline failure is not what killed it");
    assert.equal(r.results[1].status, "survivor", "the full suite fails with it, but only where it failed without it");
    assert.match(r.results[1].detail, /1 files fail in the unmutated copy/);
    assert.equal(r.pass, false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a full suite that crashes before running any test is no kill: the mutant is reported as a survivor for a person to look at", async () => {
  const repo = fixture();
  try {
    writeFileSync(join(repo, "wrap.mjs"), `import { execFileSync } from "node:child_process";\nexecFileSync(process.execPath, ["--test"], { stdio: "inherit" });\n`);
    // the mutant breaks the wrapper the full suite runs through, not anything the named test loads
    const r = await runMutants({ repo, spec: { mutants: [{ id: "W1", file: "wrap.mjs", line: 2, find: "execFileSync(process.execPath", replace: "(() => { throw new Error('no suite'); })(process.execPath", tests: ["tests/other.test.mjs"] }] }, fullCmd: ["node", "wrap.mjs"] });
    assert.equal(r.results[0].status, "survivor");
    assert.equal(r.pass, false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("named tests that do not exist are an error, not a kill; concurrency 1 and 8 give the same answer", async () => {
  const repo = fixture();
  try {
    const bad = await runMutants({ repo, spec: { mutants: [m("M1", { tests: ["tests/missing.test.mjs"] })] }, fullCmd: FULL });
    assert.equal(bad.results[0].status, "error");
    assert.equal(bad.pass, false);
    const spec = { mutants: [m("M1"), m("M4", { line: 5, find: "n < 0", replace: "true", tests: ["tests/neg.test.mjs"] }), m("M5", { line: 5, find: '"pos"', replace: '"neg"', tests: ["tests/neg.test.mjs"] })] };
    const one = await runMutants({ repo, spec, concurrency: 1, fullCmd: FULL }), eight = await runMutants({ repo, spec, concurrency: 8, fullCmd: FULL });
    assert.deepEqual(one.results.map((x) => x.status), ["killed", "killed", "killed"]);
    assert.deepEqual(eight.results.map((x) => x.status), one.results.map((x) => x.status));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
