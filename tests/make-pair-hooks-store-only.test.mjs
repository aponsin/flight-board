// Security's RISKS on pc67 line 3 (11-16): the hooks step is made from the previous pair's, so its read-back still wanted two board entries (Stop plus the page-publish
// entry) after scripts/hooks.mjs began to write the Stop entry alone (#C1054 b1). The step would have failed on the owner's Mac and sent them to undo. The template is
// now rewritten to one entry, and make-pair compares the step's read-back with what scripts/hooks.mjs at the pin writes: a disagreement writes nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeAll, hooksText, storeOnly, hooksExpectation, hooksWritten, checkHooksExpectation, hookEntriesAt, STORE_ONLY_FIXES } from "../scripts/make-pair.mjs";
import { hookEntries } from "../scripts/hooks.mjs";

const OLD = "1".repeat(40), CUE = "c".repeat(64);
// The wording pc66's hooks file had (the two-entry installer), in the lines that matter.
const TWO = (sha = OLD) => [
  "// The hooks step of pair pc7 (pins the Stop hook and the page-publish hook to this main), for flight-board main " + sha + ". Run by the owner in Terminal AFTER the pair's two lines",
  "//  4. runs the signed installer: node scripts/hooks.mjs <config> --pin " + sha.slice(0, 7) + " --store --write. That leaves exactly two board entries,",
  "//     Stop gate/stop.mjs --store and PreToolUse gate/publish.mjs on the page tools, both from the pinned copy of " + sha.slice(0, 7) + " (#C888's Stop hook code takes effect);",
  "//  6. reads settings.json back and checks it: exactly two board entries, both from " + sha.slice(0, 7) + ", exactly one cue entry, and every other entry as it was.",
  `const SIGNED = "${sha}";`, `const CUE_SHA = "${CUE}";`, "const backup = `settings.json.before-pc7`;",
  "// Read it back: two board entries from the signed commit, one cue entry, nothing else different from before.",
  "if (board.length !== 2 || stop.length !== 1 || publish.length !== 1 || cue.length !== 1 || commands.filter(isCue).length !== 1 || others(back) !== others(before)) {",
  "console.log(`HOOKS OK: exactly two board entries (Stop stop.mjs --store, PreToolUse publish.mjs), both from ${SIGNED.slice(0, 8)}; the send-refused cue is installed.`);",
  "",
].join("\n");
const ONE_ENTRY = "if (board.length !== 1 || stop.length !== 1 || publish.length !== 0 || cue.length !== 1) {";

test("hooksText moves a two-entry template to one: no wording of two board entries or a publish entry is left, and the read-back expects 1 / 1 / 0", () => {
  const out = hooksText({ n: 7, text: TWO() }, { name: "pc8", sha: "2".repeat(40), cueSha: CUE });
  assert.doesNotMatch(out, /two board entries|publish\.length !== 1|page-publish hook|PreToolUse gate\/publish/);
  assert.deepEqual(hooksExpectation(out), { board: 1, stop: 1, publish: 0 });
  assert.match(out, /exactly one board entry \(Stop stop\.mjs --store; no page-publish entry\)/);
  assert.match(out, /that leaves exactly one board entry|That leaves exactly one board entry/);
  assert.match(out.split("\n")[0], /^\/\/ The hooks step of pair pc8 \(pins the Stop hook to this main\), for flight-board main 2{40}\. .*its read-back now expects the one Stop entry/);
});

test("a template that is already store-only is left as it is (no fix applies, no sentence about the change)", () => {
  const one = TWO().replace(/if \(board\.length !== 2.*\n/, ONE_ENTRY + "\n");
  const out = hooksText({ n: 7, text: storeOnly(one) }, { name: "pc8", sha: "2".repeat(40), cueSha: CUE });
  assert.deepEqual(hooksExpectation(out), { board: 1, stop: 1, publish: 0 });
  assert.doesNotMatch(out.split("\n")[0], /now expects the one Stop entry/);
});

test("storeOnly refuses a template that still talks of two entries in words it does not know", () => {
  assert.throws(() => storeOnly("// the installer leaves two board entries, in a new sentence\n"), /still expects two board entries/);
  assert.throws(() => storeOnly("if (board.length !== 3 || publish.length !== 1) {"), /still expects two board entries/);
  assert.ok(STORE_ONLY_FIXES.every(([from, to]) => from !== to));
});

test("hooksExpectation and hooksWritten: the counts of the read-back, and of what hooks.mjs writes (the repository's own, one Stop entry)", () => {
  assert.deepEqual(hooksExpectation(ONE_ENTRY), { board: 1, stop: 1, publish: 0 });
  assert.equal(hooksExpectation("no read-back here"), null);
  assert.deepEqual(hooksWritten(hookEntries("/pin", "/c.json", "/bin/node")), { board: 1, stop: 1, publish: 0 }, "scripts/hooks.mjs here writes the Stop entry alone");
  assert.deepEqual(hooksWritten({ Stop: { hooks: [{ command: "n /pin/gate/stop.mjs --config /c --store" }] }, PreToolUse: [{ hooks: [{ command: "n /pin/gate/publish.mjs --config /c" }] }] }), { board: 2, stop: 1, publish: 1 });
  assert.equal(checkHooksExpectation(ONE_ENTRY, hookEntries("/pin", "/c.json", "/bin/node")).ok, true);
  const bad = checkHooksExpectation(TWO().split("\n").find((l) => l.startsWith("if (board")), hookEntries("/pin", "/c.json", "/bin/node"));
  assert.equal(bad.ok, false);
  assert.match(bad.why, /expects 2 board entries \(1 Stop --store, 1 publish\).* writes 1 \(1 Stop --store, 0 publish\)/);
  assert.equal(checkHooksExpectation("a fixture with no read-back", {}).skipped, true);
});

// A repository with the files make-pair reads, whose scripts/hooks.mjs is `hooksSource` at the new commit.
function world(hooksSource) {
  const dir = mkdtempSync(join(tmpdir(), "fb-hooks-store-only-")), bare = join(dir, "origin.git"), work = join(dir, "work"), out = join(dir, "out");
  mkdirSync(out);
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...a], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g("remote", "add", "origin", bare);
  const commit = (subject, files) => { for (const [f, t] of Object.entries(files)) { mkdirSync(join(work, f, ".."), { recursive: true }); writeFileSync(join(work, f), t); } g("add", "-A"); g("commit", "-qm", subject); const sha = g("rev-parse", "HEAD"); g("push", "-q", "origin", "main"); return sha; };
  const base = { "gate/stop.mjs": "export const s = 1;\n", "hooks/send-refused-cue.py": "cue\n", "scripts/wake-watch.mjs": "export const w = 1;\n", "worker/a.mjs": "1\n" };
  const a = commit("first (#C100)", base);
  assert.equal(makeAll({ repo: work, sha: a, n: 1, out }).ok, true);
  writeFileSync(join(out, "board-store-deploy-pc1.done"), a + "\n");
  const b = commit("the hooks installer (#C101)", { "scripts/hooks.mjs": hooksSource, "gate/stop.mjs": "export const s = 2;\n" });
  return { dir, work, out, b, g };
}
const REAL_HOOKS = readFileSync(new URL("../scripts/hooks.mjs", import.meta.url), "utf8");
const TWO_ENTRY_HOOKS = `export function hookEntries(repo, configPath, node = "/bin/node") {
  const cmd = (file, more = "") => node + " " + repo + "/gate/" + file + " --config " + configPath + more;
  return { Stop: { hooks: [{ type: "command", command: cmd("stop.mjs", " --store") }] }, PreToolUse: [{ matcher: "x", hooks: [{ type: "command", command: cmd("publish.mjs") }] }] };
}\n`;

test("makeAll: an old two-entry template and the repository's one-entry hooks.mjs give a store-only hooks file (the pc67 case, end to end)", () => {
  const w = world(REAL_HOOKS);
  try {
    writeFileSync(join(w.out, "board-store-hooks-pc7.mjs"), TWO(OLD));
    const r = makeAll({ repo: w.work, sha: w.b, n: 8, out: w.out });
    assert.equal(r.ok, true, r.why);
    const hooks = readFileSync(join(w.out, "board-store-hooks-pc8.mjs"), "utf8");
    assert.deepEqual(hooksExpectation(hooks), { board: 1, stop: 1, publish: 0 });
    assert.doesNotMatch(hooks, /two board entries|page-publish hook|PreToolUse gate\/publish/);
    const steps = readFileSync(join(w.out, "board-store-pc8-steps.md"), "utf8");
    assert.match(steps, /## Line 3: hooks \(the Stop hook, pinned to this main\)/);
    assert.doesNotMatch(steps, /page-publish hook/);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("makeAll: a hooks file that expects one entry while hooks.mjs at the pin still writes two is refused, and nothing is written", () => {
  const w = world(TWO_ENTRY_HOOKS);
  try {
    writeFileSync(join(w.out, "board-store-hooks-pc7.mjs"), TWO(OLD).replace(/if \(board\.length !== 2.*\n/, ONE_ENTRY + "\n"));
    const before = readdirSync(w.out).sort();
    const r = makeAll({ repo: w.work, sha: w.b, n: 8, out: w.out });
    assert.equal(r.ok, false);
    assert.match(r.why, /expects 1 board entry .* writes 2 \(1 Stop --store, 1 publish\)/);
    assert.deepEqual(readdirSync(w.out).sort(), before, "nothing written");
    assert.equal(hookEntriesAt((...a) => ({ status: 1, stdout: "" }), "x"), null, "a hooks.mjs that git cannot show is no entries");
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("makeAll: the other way round, a two-entry template over a hooks.mjs that writes two entries is rewritten to one and then refused (the template is never trusted over the installer)", () => {
  const w = world(TWO_ENTRY_HOOKS);
  try {
    writeFileSync(join(w.out, "board-store-hooks-pc7.mjs"), TWO(OLD));
    const r = makeAll({ repo: w.work, sha: w.b, n: 8, out: w.out });
    assert.equal(r.ok, false, "the rewrite makes it expect one; the installer at this pin writes two");
    assert.match(r.why, /hooks step expects 1 board entry/);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});
