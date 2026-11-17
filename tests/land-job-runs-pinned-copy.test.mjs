// #C1140 (what is left after #C1058): the release tool the landing job starts is the owner's installed copy, but board-land.mjs itself ran from ~/.flight-board/current, because the
// LaunchAgent (com.flight-board.store.land) starts it there and every release moves that link: a changed land job ran before the owner had installed it. A pack that changes the land job
// (scripts/board-land.mjs or a file it imports) now carries a fourth step, scripts/pair/land.template.mjs, that points the LaunchAgent at ~/.flight-board/install/<the pack's sha>/scripts/board-land.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { makeAll, landText, landChanged, HOOK_ENTRIES, LAND_ENTRIES } from "../scripts/make-pair.mjs";

const SHA = "a".repeat(40), SHA2 = "b".repeat(40);

test("landText fills the pair's name and the pinned main, and refuses a bad name, a bad sha or a template with a placeholder it does not know", () => {
  const t = landText({ name: "pc9", sha: SHA });
  assert.match(t, /moves the landing job to the owner's pinned install of a{40}/);
  assert.ok(t.includes(`const SIGNED = "${SHA}";`) && t.includes('const NAME = "pc9";'));
  assert.doesNotMatch(t, /@@/);
  for (const bad of [{ name: "pc", sha: SHA }, { name: "x9", sha: SHA }, { name: "pc9", sha: SHA.slice(1) }, { name: "pc9", sha: SHA.toUpperCase() }, { name: "pc9; rm", sha: SHA }]) assert.throws(() => landText(bad), /needs a pair name/, JSON.stringify(bad));
  assert.throws(() => landText({ name: "pc9", sha: SHA, template: "x @@NAME@@ @@SIGNED@@ @@OTHER@@" }), /placeholder/);
});

test("the landing job and its imports are hook-pinned: HOOK_ENTRIES names board-land.mjs, and landChanged follows its relative imports", () => {
  assert.ok(HOOK_ENTRIES.includes("scripts/board-land.mjs") && LAND_ENTRIES.includes("scripts/board-land.mjs"));
  const files = { "scripts/board-land.mjs": 'import { a } from "../worker/a.mjs";\n', "worker/a.mjs": 'import "./b.mjs";\n', "worker/b.mjs": "1\n", "worker/other.mjs": "2\n" };
  const git = (...args) => (args[0] === "show" && files[args[1].split(":")[1]] !== undefined ? { status: 0, stdout: files[args[1].split(":")[1]] } : { status: 128, stdout: "" });
  assert.deepEqual(landChanged(git, SHA, ["worker/b.mjs", "worker/other.mjs", "docs/x.md"]), ["worker/b.mjs"], "a file the land job imports two levels down counts; one it does not import does not");
});

// ---- makeAll, end to end ----
function world() {
  const dir = mkdtempSync(join(tmpdir(), "fb-land-pack-")), bare = join(dir, "origin.git"), work = join(dir, "work"), out = join(dir, "out");
  mkdirSync(out);
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...a], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g("remote", "add", "origin", bare);
  const commit = (subject, files) => { for (const [f, t] of Object.entries(files)) { mkdirSync(join(work, f, ".."), { recursive: true }); writeFileSync(join(work, f), t); } g("add", "-A"); g("commit", "-qm", subject); const sha = g("rev-parse", "HEAD"); g("push", "-q", "origin", "main"); return sha; };
  const base = { "gate/stop.mjs": "export const s = 1;\n", "hooks/send-refused-cue.py": "cue\n", "scripts/wake-watch.mjs": "export const w = 1;\n", "scripts/board-land.mjs": 'import { j } from "../worker/jobs.mjs";\nexport const land = 1;\n', "worker/jobs.mjs": "export const j = 1;\n" };
  const a = commit("first (#C100)", base);
  assert.equal(makeAll({ repo: work, sha: a, n: 1, out }).ok, true);
  writeFileSync(join(out, "board-store-deploy-pc1.done"), a + "\n");
  // an earlier hooks step, so the next pair can make its own from it
  writeFileSync(join(out, "board-store-hooks-pc1.mjs"), `// the hooks step of pair pc1\nconst SIGNED = "${a}";\nconst CUE_SHA = "${"0".repeat(64)}";\n`);
  return { dir, work, out, a, commit };
}
const names = (out) => readdirSync(out).filter((f) => /^board-store-(?:land|hooks)-pc2\.mjs$/.test(f)).sort();

test("makeAll: a pack that changes the land job writes the land step beside the hooks step, and the steps file gives it line 4 with its hash", () => {
  const w = world();
  try {
    const b = w.commit("the land job (#C101)", { "scripts/board-land.mjs": 'import { j } from "../worker/jobs.mjs";\nexport const land = 2;\n' });
    const r = makeAll({ repo: w.work, sha: b, n: 2, out: w.out });
    assert.equal(r.ok, true, r.why);
    assert.deepEqual(names(w.out), ["board-store-hooks-pc2.mjs", "board-store-land-pc2.mjs"]);
    const land = readFileSync(join(w.out, "board-store-land-pc2.mjs"), "utf8"), steps = readFileSync(join(w.out, "board-store-pc2-steps.md"), "utf8");
    assert.ok(land.includes(`const SIGNED = "${b}";`) && land.includes('const NAME = "pc2";'));
    assert.match(steps, /Four lines \(the third installs the hooks, the fourth moves the landing job to the pinned install/);
    assert.match(steps, /## Line 4: landing job \(moves the LaunchAgent to the pinned install\)/);
    assert.ok(steps.includes(`board-store-land-pc2.mjs | cut -c1-64)" = ${r.files["board-store-land-pc2.mjs"]}`), "the line carries the land file's own hash");
    assert.ok(steps.includes(`, land ${r.files["board-store-land-pc2.mjs"]}.`), "the full hash list names it");
    assert.match(steps, /Land job files changed since [0-9a-f]{8}: scripts\/board-land\.mjs\./);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("makeAll: a file the land job imports counts; a pack that does not touch the land job writes no land step and keeps 'Three lines'", () => {
  const w = world();
  try {
    const viaImport = w.commit("a job the land job imports (#C101)", { "worker/jobs.mjs": "export const j = 2;\n" });
    assert.equal(makeAll({ repo: w.work, sha: viaImport, n: 2, out: w.out }).ok, true);
    assert.ok(names(w.out).includes("board-store-land-pc2.mjs"), "worker/jobs.mjs is imported by scripts/board-land.mjs");
    writeFileSync(join(w.out, "board-store-deploy-pc2.done"), viaImport + "\n"); // pc2 ran: the next pair carries only what came after it
    const other = w.commit("only the Stop hook (#C102)", { "gate/stop.mjs": "export const s = 3;\n" });
    assert.equal(makeAll({ repo: w.work, sha: other, n: 3, out: w.out }).ok, true);
    assert.equal(existsSync(join(w.out, "board-store-land-pc3.mjs")), false, "no land step when the land job did not change");
    const steps = readFileSync(join(w.out, "board-store-pc3-steps.md"), "utf8");
    assert.match(steps, /Three lines \(the third installs the hooks, pinned to this main\)/);
    assert.doesNotMatch(steps, /Line 4|landing job \(moves/);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

// ---- the step itself, in a sandbox: HOME is a temp folder, launchctl and plutil are shims on PATH ----
function sandbox({ pinnedExists = true, plistText } = {}) {
  const home = mkdtempSync(join(tmpdir(), "fb-land-step-")), bin = join(home, "bin"), log = join(home, "launchctl.log"), marker = join(home, "loaded");
  mkdirSync(bin); mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  // launchctl shim: logs the verb; bootstrap loads (creates the marker) unless FAIL_BOOTSTRAP is set; bootout unloads; print succeeds while loaded.
  writeFileSync(join(bin, "launchctl"), `#!/bin/sh\necho "$1" >> "${log}"\ncase "$1" in\n  bootout) rm -f "${marker}"; exit 0;;\n  bootstrap) if [ -n "$FAIL_BOOTSTRAP" ]; then echo "Bootstrap failed: 5" >&2; exit 5; fi; : > "${marker}"; exit 0;;\n  print) [ -e "${marker}" ];;\nesac\n`);
  writeFileSync(join(bin, "plutil"), `#!/bin/sh\nif grep -q BADPLIST "$2"; then echo "bad plist"; exit 1; fi\nexit 0\n`);
  chmodSync(join(bin, "launchctl"), 0o755); chmodSync(join(bin, "plutil"), 0o755);
  const plist = join(home, "Library", "LaunchAgents", "com.flight-board.store.land.plist");
  const link = `${home}/.flight-board/current/scripts/board-land.mjs`;
  writeFileSync(plist, plistText ?? `<plist><dict><key>ProgramArguments</key><array><string>/usr/bin/perl</string><string>${link}</string><string>--config</string><string>/c.json</string></array></dict></plist>\n`);
  const pinned = `${home}/.flight-board/install/${SHA2}/scripts/board-land.mjs`;
  if (pinnedExists) { mkdirSync(join(pinned, ".."), { recursive: true }); writeFileSync(pinned, "x\n"); }
  const step = join(home, "land.mjs");
  writeFileSync(step, landText({ name: "pc9", sha: SHA2 }));
  const run = (arg, env = {}) => spawnSync(process.execPath, arg ? [step, arg] : [step], { encoding: "utf8", env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...env } });
  return { home, plist, pinned, link, run, loadLog: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []), backup: `${plist}.before-pc9` };
}

test("the step: the LaunchAgent moves from the link to the pinned install, with a backup, a reload and a checked read-back; a second run changes nothing more", () => {
  const s = sandbox();
  try {
    const first = s.run();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /^LAND OK: the landing job runs ~\/\.flight-board\/install\/bbbbbbbb\.\.\.\/scripts\/board-land\.mjs and launchd has it loaded/);
    const text = readFileSync(s.plist, "utf8");
    assert.ok(text.includes(`<string>${s.pinned}</string>`) && !text.includes("/.flight-board/current/"), "the pinned path, and the link nowhere");
    assert.ok(text.includes("<string>--config</string><string>/c.json</string>"), "the rest of the file is as it was");
    assert.ok(readFileSync(s.backup, "utf8").includes(s.link), "the backup is the file as it was");
    assert.deepEqual(s.loadLog().filter((v) => v !== "print"), ["bootout", "bootstrap"], "reloaded once: bootout, then bootstrap");
    const second = s.run();
    assert.match(second.stdout, /^LAND OK: .* already runs from the pinned install .*nothing changed/);
    assert.equal(readFileSync(s.plist, "utf8"), text);
    assert.deepEqual(s.loadLog().filter((v) => v !== "print"), ["bootout", "bootstrap"], "no second reload");
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test("the step: undo puts the backup back and reloads the job; with no backup it refuses", () => {
  const s = sandbox();
  try {
    assert.match(s.run("undo").stdout, /^LAND FAILED: no backup at /);
    s.run();
    const undone = s.run("undo");
    assert.match(undone.stdout, /^LAND UNDONE/);
    assert.ok(readFileSync(s.plist, "utf8").includes(s.link) && !readFileSync(s.plist, "utf8").includes(s.pinned));
    assert.deepEqual(s.loadLog().filter((v) => v !== "print"), ["bootout", "bootstrap", "bootout", "bootstrap"]);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test("the step refuses, and changes nothing, when the pinned install is missing, the file names board-land.mjs in no known form or twice, or plutil rejects the new file", () => {
  const missing = sandbox({ pinnedExists: false });
  try {
    const r = missing.run();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^LAND FAILED: .*does not exist \(run the pair's hooks line first/);
    assert.ok(readFileSync(missing.plist, "utf8").includes(missing.link), "the file is as it was");
    assert.deepEqual(missing.loadLog(), [], "launchctl was never called");
    assert.equal(existsSync(missing.backup), false);
  } finally { rmSync(missing.home, { recursive: true, force: true }); }
  for (const [why, plistText] of [["none", "<plist><dict><array><string>/usr/bin/true</string></array></dict></plist>\n"], ["a strange path", "<plist><array><string>/elsewhere/scripts/board-land.mjs</string></array></plist>\n"], ["twice", "<plist><array><string>/h/.flight-board/current/scripts/board-land.mjs</string><string>/h/.flight-board/current/scripts/board-land.mjs</string></array></plist>\n"]]) {
    const s = sandbox({ plistText });
    try {
      const r = s.run();
      assert.match(r.stdout, /^LAND FAILED: the LaunchAgent file names board-land\.mjs \d times/, why);
      assert.equal(readFileSync(s.plist, "utf8"), plistText, why);
      assert.deepEqual(s.loadLog(), [], why);
    } finally { rmSync(s.home, { recursive: true, force: true }); }
  }
  const lint = sandbox({ plistText: "<plist><array><string>BADPLIST</string><string>/h/.flight-board/current/scripts/board-land.mjs</string></array></plist>\n" });
  try {
    const r = lint.run();
    assert.match(r.stdout, /^LAND FAILED: the new LaunchAgent file did not pass plutil -lint/);
    assert.ok(readFileSync(lint.plist, "utf8").includes("/h/.flight-board/current/"), "the file is as it was");
    assert.deepEqual(lint.loadLog(), []);
    assert.deepEqual(readdirSync(join(lint.home, "Library", "LaunchAgents")).filter((f) => f.includes(".new-")), [], "the half-written file is removed");
  } finally { rmSync(lint.home, { recursive: true, force: true }); }
});

test("the step says so when launchctl cannot load the job again, and names the backup and the undo", () => {
  const s = sandbox();
  try {
    const r = s.run("", { FAIL_BOOTSTRAP: "1" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^LAND FAILED: launchctl bootstrap failed \(Bootstrap failed: 5\); the file is in place, the backup is .*\.before-pc9\. Paste this line to Manager\./);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});
