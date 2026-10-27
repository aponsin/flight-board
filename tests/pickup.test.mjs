// The pickup digests (#C338, the context-tax brief's card C, Builder's #C336): each collector run refreshes every role's
// digest in each refresh repository that ships scripts/pickup-digest.mjs on its main, running that file as main has it
// (never the checkout's working copy), with --all --no-fetch, in the repository. A failure is one line, never a stop.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { refreshPickups, PICKUP_SCRIPT } from "../collector/pickup.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
// A repository with an origin whose main holds `script` (or none), checked out at main.
function repoWith(dir, name, script) {
  const bare = join(dir, `${name}.git`), co = join(dir, name);
  git(dir, "init", "-q", "--bare", "-b", "main", bare);
  git(dir, "clone", "-q", bare, co);
  writeFileSync(join(co, "README.md"), "x\n");
  if (script != null) { mkdirSync(join(co, "scripts"), { recursive: true }); writeFileSync(join(co, PICKUP_SCRIPT), script); }
  git(co, "add", "-A");
  git(co, "commit", "-q", "-m", "init");
  git(co, "push", "-q", "origin", "HEAD:main");
  git(co, "fetch", "-q", "origin");
  return co;
}
// A stand-in digest script: writes what it was run with into notes/pickup/args.json, and prints a line per role.
const FAKE = `import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync("notes/pickup", { recursive: true });
writeFileSync("notes/pickup/args.json", JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), from: import.meta.url, version: "main" }));
console.log("/x/notes/pickup/Builder.md: 4000 bytes");
console.log("/x/notes/pickup/Release.md: 3000 bytes");
`;

test("a repo whose main ships the script: run as main has it, with --all --no-fetch, in the repo; one line saying how many", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-pickup-"));
  try {
    const co = repoWith(dir, "team", FAKE);
    // The working copy differs from main: main's file is the one that runs.
    writeFileSync(join(co, PICKUP_SCRIPT), FAKE.replace('version: "main"', 'version: "working copy"'));
    const lines = refreshPickups([co], { main: "main" });
    assert.deepEqual(lines, ["PICKUP team: 2 digest(s) refreshed"]);
    const got = JSON.parse(readFileSync(join(co, "notes/pickup/args.json"), "utf8"));
    assert.deepEqual(got.args, ["--all", "--no-fetch"]);
    assert.equal(got.version, "main", "never the working copy");
    assert.equal(execFileSync("realpath", [got.cwd], { encoding: "utf8" }).trim(), execFileSync("realpath", [co], { encoding: "utf8" }).trim());
    assert.ok(!got.from.includes(co), "the file runs from a copy outside the checkout");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a repo without the script, a missing folder, or a failing script: no stop; a failure is one line", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-pickup-"));
  try {
    const none = repoWith(dir, "board", null);
    assert.deepEqual(refreshPickups([none, join(dir, "gone")], { main: "main" }), [], "nothing to run, nothing said");
    const bad = repoWith(dir, "bad", "console.error('boom\\nsecond line'); process.exit(3);\n");
    const lines = refreshPickups([bad], { main: "main" });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^PICKUP bad: failed \(exit 3\): boom$/);
    const slow = repoWith(dir, "slow", "setTimeout(() => {}, 10000);\n");
    assert.match(refreshPickups([slow], { main: "main", timeoutMs: 300 })[0], /^PICKUP slow: failed \(timed out after 0\.3 s\)$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the repos come from collector.refresh.repos, ~ expanded", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-pickup-"));
  try {
    const co = repoWith(dir, "team", FAKE);
    const lines = refreshPickups([co.replace(process.env.HOME ?? "\0", "~")], { main: "main" });
    assert.equal(lines.length, 1);
    assert.ok(existsSync(join(co, "notes/pickup/args.json")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
