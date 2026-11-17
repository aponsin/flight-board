// Security's RISKS on pc67 line 3 (11-16): the hooks step is made from the previous pair's, so its read-back still wanted two board entries (Stop plus the page-publish
// entry) after scripts/hooks.mjs began to write the Stop entry alone (#C1054 b1). The step would have failed on the owner's Mac and sent them to undo. The template is
// now rewritten to one entry, and make-pair compares the step's read-back with what scripts/hooks.mjs at the pin writes: a disagreement writes nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeAll, hooksText, storeOnly, hooksExpectation, hooksWritten, checkHooksExpectation, hookEntriesAt, STORE_ONLY_FIXES, FIRST_PUSH_FIXES } from "../scripts/make-pair.mjs";
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
  "const publish = board.filter((c) => c.includes(`/${SIGNED}/gate/publish.mjs`));",
  "if (board.length !== 2 || stop.length !== 1 || publish.length !== 1 || cue.length !== 1 || commands.filter(isCue).length !== 1 || others(back) !== others(before)) {",
  "console.log(`HOOKS OK: exactly two board entries (Stop stop.mjs --store, PreToolUse publish.mjs), both from ${SIGNED.slice(0, 8)}; the send-refused cue is installed.`);",
  "",
].join("\n");
const ONE_ENTRY = "if (board.length !== 1 || stop.length !== 1 || publish.length !== 0 || cue.length !== 1) {";

test("hooksText moves a two-entry (Stop plus page-publish) template to Stop plus the first-push guard: no page-publish entry is left, and the read-back expects 2 / 1 / 0 / 1 (#C1065)", () => {
  const out = hooksText({ n: 7, text: TWO() }, { name: "pc8", sha: "2".repeat(40), cueSha: CUE });
  assert.doesNotMatch(out, /publish\.length !== 1|page-publish hook|PreToolUse gate\/publish/);
  assert.deepEqual(hooksExpectation(out), { board: 2, stop: 1, publish: 0, first: 1 });
  assert.match(out, /exactly two board entries \(Stop stop\.mjs --store and PreToolUse first-push\.mjs; no page-publish entry\)/);
  assert.match(out, /That leaves exactly two board entries,\n\/\/     Stop gate\/stop\.mjs --store and PreToolUse gate\/first-push\.mjs, both from/);
  assert.match(out, /const first = board\.filter\(\(c\) => c\.includes\(`\/\$\{SIGNED\}\/gate\/first-push\.mjs`\)\);/);
  assert.match(out.split("\n")[0], /^\/\/ The hooks step of pair pc8 \(pins the Stop hook to this main\), for flight-board main 2{40}\. .*its read-back now expects the one Stop entry.*now also expects the PreToolUse first-push guard entry/);
});

test("a one-entry (Stop only) template is moved to expect the first-push guard too, once: a template that already expects it is left as it is (#C1065)", () => {
  // pc76's own shape: the one-entry wording and check, no first-push anywhere (the two-entry template with only STORE_ONLY_FIXES applied).
  const one = STORE_ONLY_FIXES.reduce((t, [from, to]) => t.split(from).join(to), TWO().replace(/if \(board\.length !== 2.*\n/, ONE_ENTRY + "\n"));
  assert.doesNotMatch(one, /first\.length|two board entries/);
  const out = hooksText({ n: 7, text: one }, { name: "pc8", sha: "2".repeat(40), cueSha: CUE });
  assert.deepEqual(hooksExpectation(out), { board: 2, stop: 1, publish: 0, first: 1 });
  assert.doesNotMatch(out.split("\n")[0], /now expects the one Stop entry/);
  assert.match(out.split("\n")[0], /now also expects the PreToolUse first-push guard entry/);
  const again = hooksText({ n: 8, text: out }, { name: "pc9", sha: "3".repeat(40), cueSha: CUE });
  assert.deepEqual(hooksExpectation(again), { board: 2, stop: 1, publish: 0, first: 1 });
  assert.doesNotMatch(again.split("\n")[0], /first-push guard entry/, "the third pair has nothing left to move");
  assert.equal(storeOnly(out), out, "an already moved text is not touched, and its 'two board entries' is not read as the retired page-publish wording");
  assert.ok(FIRST_PUSH_FIXES.every(([from, to]) => from !== to));
});

test("a read-back with no `const publish` line to put the first-push count beside is refused, never half moved (a ReferenceError on the owner's Mac after the install wrote)", () => {
  assert.throws(() => storeOnly(ONE_ENTRY + "\n"), /no `const publish = board\.filter\(\.\.\.\)` line/);
  assert.equal(storeOnly("a fixture with no read-back\n"), "a fixture with no read-back\n");
});

test("storeOnly refuses a template that still talks of two entries in words it does not know", () => {
  assert.throws(() => storeOnly("// the installer leaves two board entries, in a new sentence\n"), /still expects two board entries/);
  assert.throws(() => storeOnly("if (board.length !== 3 || publish.length !== 1) {"), /still expects two board entries/);
  assert.ok(STORE_ONLY_FIXES.every(([from, to]) => from !== to));
});

const FIRST_ENTRY = "if (board.length !== 2 || stop.length !== 1 || publish.length !== 0 || first.length !== 1 || cue.length !== 1) {";
test("hooksExpectation and hooksWritten: the counts of the read-back, and of what hooks.mjs writes (the repository's own: the Stop entry and the first-push guard)", () => {
  assert.deepEqual(hooksExpectation(ONE_ENTRY), { board: 1, stop: 1, publish: 0, first: 0 }, "a text with no first-push check expects none");
  assert.deepEqual(hooksExpectation(FIRST_ENTRY), { board: 2, stop: 1, publish: 0, first: 1 });
  assert.equal(hooksExpectation("no read-back here"), null);
  assert.deepEqual(hooksWritten(hookEntries("/pin", "/c.json", "/bin/node")), { board: 2, stop: 1, publish: 0, first: 1 }, "scripts/hooks.mjs here writes the Stop entry and the first-push guard");
  assert.deepEqual(hooksWritten({ Stop: { hooks: [{ command: "n /pin/gate/stop.mjs --config /c --store" }] }, PreToolUse: [{ hooks: [{ command: "n /pin/gate/publish.mjs --config /c" }] }] }), { board: 2, stop: 1, publish: 1, first: 0 });
  assert.equal(checkHooksExpectation(FIRST_ENTRY, hookEntries("/pin", "/c.json", "/bin/node")).ok, true);
  const noFirst = checkHooksExpectation("if (board.length !== 2 || stop.length !== 1 || publish.length !== 0 || cue.length !== 1) {", hookEntries("/pin", "/c.json", "/bin/node"));
  assert.equal(noFirst.ok, false, "the counts agree on everything but the first-push guard: still a refusal");
  assert.match(noFirst.why, /0 first-push\).* writes 2 \(1 Stop --store, 0 publish, 1 first-push\)/);
  const stale = checkHooksExpectation(ONE_ENTRY, hookEntries("/pin", "/c.json", "/bin/node"));
  assert.equal(stale.ok, false, "a Stop-only read-back over an installer that also writes the guard would fail on the owner's Mac: refused here");
  assert.match(stale.why, /expects 1 board entry \(1 Stop --store, 0 publish, 0 first-push\).* writes 2 \(1 Stop --store, 0 publish, 1 first-push\)/);
  const bad = checkHooksExpectation(TWO().split("\n").find((l) => l.startsWith("if (board")), hookEntries("/pin", "/c.json", "/bin/node"));
  assert.equal(bad.ok, false);
  assert.match(bad.why, /expects 2 board entries \(1 Stop --store, 1 publish, 0 first-push\).* writes 2 \(1 Stop --store, 0 publish, 1 first-push\)/);
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

test("makeAll: an old two-entry template and the repository's hooks.mjs (Stop plus the first-push guard) give a hooks file with no page-publish entry (the pc67 case, end to end; #C1065)", () => {
  const w = world(REAL_HOOKS);
  try {
    writeFileSync(join(w.out, "board-store-hooks-pc7.mjs"), TWO(OLD));
    const r = makeAll({ repo: w.work, sha: w.b, n: 8, out: w.out });
    assert.equal(r.ok, true, r.why);
    const hooks = readFileSync(join(w.out, "board-store-hooks-pc8.mjs"), "utf8");
    assert.deepEqual(hooksExpectation(hooks), { board: 2, stop: 1, publish: 0, first: 1 });
    assert.doesNotMatch(hooks, /page-publish hook|PreToolUse gate\/publish/);
    const steps = readFileSync(join(w.out, "board-store-pc8-steps.md"), "utf8");
    assert.match(steps, /## Line 3: hooks \(the Stop hook, pinned to this main\)/);
    assert.doesNotMatch(steps, /page-publish hook/);
    assert.doesNotMatch(steps, /only the pin and the pair number changed/);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("makeAll: a hooks file that expects one entry while hooks.mjs at the pin still writes two is refused, and nothing is written", () => {
  const w = world(TWO_ENTRY_HOOKS);
  try {
    writeFileSync(join(w.out, "board-store-hooks-pc7.mjs"), TWO(OLD).replace(/if \(board\.length !== 2.*\n/, ONE_ENTRY + "\n"));
    const before = readdirSync(w.out).sort();
    const r = makeAll({ repo: w.work, sha: w.b, n: 8, out: w.out });
    assert.equal(r.ok, false);
    assert.match(r.why, /expects 2 board entries .* writes 2 \(1 Stop --store, 1 publish, 0 first-push\)/);
    assert.deepEqual(readdirSync(w.out).sort(), before, "nothing written");
    assert.equal(hookEntriesAt((...a) => ({ status: 1, stdout: "" }), "x"), null, "a hooks.mjs that git cannot show is no entries");
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("makeAll: the other way round, a two-entry template over a hooks.mjs that writes two entries is rewritten to one and then refused (the template is never trusted over the installer)", () => {
  const w = world(TWO_ENTRY_HOOKS);
  try {
    writeFileSync(join(w.out, "board-store-hooks-pc7.mjs"), TWO(OLD));
    const r = makeAll({ repo: w.work, sha: w.b, n: 8, out: w.out });
    assert.equal(r.ok, false, "the rewrite makes it expect Stop plus the first-push guard; the installer at this pin writes Stop plus the publish entry");
    assert.match(r.why, /hooks step expects 2 board entries/);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});
