// #C1210 (Security on pc87: the ask LaunchAgent kept its OS alarm of 45 s after #C1208 raised the ask job's limit to 65 s, and no pack step rewrote it, so a second send was killed at 45 s instead
// of 80 s): a pack whose worker/probe-jobs.mjs (JOBS) changed a job's limitSec or intervalSec since the last pack carries a step, scripts/pair/probes.template.mjs, that rewrites those jobs'
// LaunchAgents (alarm = limitSec + OUTER_EXTRA_SEC, StartInterval = intervalSec) and reloads them. No change, no step.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { makeAll, jobsAt, probesChanged, probesText } from "../scripts/make-pair.mjs";
import { JOBS } from "../worker/probe-jobs.mjs";
import { OUTER_EXTRA_SEC, launchdPlist } from "../collector/probe-run.mjs";

const SHA = "a".repeat(40);
const table = (jobs) => `export const JOBS = {\n${Object.entries(jobs).map(([j, v]) => `  ${j}: { intervalSec: ${v.intervalSec}, limitSec: ${v.limitSec} },`).join("\n")}\n};\nexport const LAND_TIP_SEC = 360;\n`;
const gitWith = (files) => (...args) => (args[0] === "show" && files[args[1].split(":")[1]] !== undefined ? { status: 0, stdout: files[args[1].split(":")[1]] } : { status: 128, stdout: "" });
const two = { ask: { intervalSec: 20, limitSec: 30 }, land: { intervalSec: 600, limitSec: 590 } };

test("jobsAt reads the JOBS table of the real file as the module itself exports it (either key order, comments after a job)", () => {
  const text = readFileSync(new URL("../worker/probe-jobs.mjs", import.meta.url), "utf8");
  assert.deepEqual(jobsAt(gitWith({ "worker/probe-jobs.mjs": text }), SHA), JOBS);
  assert.deepEqual(jobsAt(gitWith({ "worker/probe-jobs.mjs": "export const JOBS = {\n  a: { limitSec: 5, intervalSec: 2 }, // x\n};\n" }), SHA), { a: { limitSec: 5, intervalSec: 2 } });
  assert.deepEqual(jobsAt(gitWith({}), SHA), {}, "no file at that commit: no jobs");
  assert.equal(jobsAt(gitWith({ "worker/probe-jobs.mjs": "export const JOBS = makeJobs();\n" }), SHA), null, "a file this cannot read");
  assert.equal(jobsAt(gitWith({ "worker/probe-jobs.mjs": "export const JOBS = {\n  a: { limitSec: 5, limitSec: 6 },\n};\n" }), SHA), null, "a repeated key is no job");
});

test("probesChanged: a limit change names that job only; no change names none; a new job counts; an unreadable table is an error, never an empty answer", () => {
  const at = (jobs) => gitWith({ "worker/probe-jobs.mjs": table(jobs) });
  const old = at(two), now = at({ ...two, ask: { intervalSec: 20, limitSec: 65 } });
  const git = (...args) => (args[1].startsWith("old:") ? old(...args) : now(...args));
  assert.deepEqual(probesChanged(git, "old", "new"), { ask: { intervalSec: 20, limitSec: 65 } });
  assert.deepEqual(probesChanged(old, "x", "y"), {}, "the same table at both commits");
  const added = at({ ...two, usage: { intervalSec: 300, limitSec: 120 } });
  assert.deepEqual(probesChanged((...a) => (a[1].startsWith("old:") ? old(...a) : added(...a)), "old", "new"), { usage: { intervalSec: 300, limitSec: 120 } });
  const interval = at({ ...two, land: { intervalSec: 300, limitSec: 590 } });
  assert.deepEqual(Object.keys(probesChanged((...a) => (a[1].startsWith("old:") ? old(...a) : interval(...a)), "old", "new")), ["land"], "an interval change counts too");
  const bad = gitWith({ "worker/probe-jobs.mjs": "export const JOBS = nothing;\n" });
  assert.throws(() => probesChanged((...a) => (a[1].startsWith("old:") ? old(...a) : bad(...a)), "old", "new"), /cannot be read as the JOBS table/);
});

test("probesText fills the name, the margin and the jobs, and refuses a bad name, no job, a bad number or a template with a placeholder it does not know", () => {
  const t = probesText({ name: "pc9", jobs: { ask: { intervalSec: 20, limitSec: 65 } } });
  assert.ok(t.includes('const NAME = "pc9";') && t.includes(`const MARGIN = ${OUTER_EXTRA_SEC};`) && t.includes('const WANT = {"ask":{"intervalSec":20,"limitSec":65}};'));
  assert.doesNotMatch(t, /@@/);
  assert.throws(() => probesText({ name: "x9", jobs: { ask: { intervalSec: 20, limitSec: 65 } } }), /needs a pair name/);
  for (const jobs of [{}, null, { ask: { intervalSec: 20 } }, { ask: { intervalSec: 20, limitSec: "65; rm" } }, { "../x": { intervalSec: 20, limitSec: 65 } }, { ask: { intervalSec: 0, limitSec: 65 } }]) assert.throws(() => probesText({ name: "pc9", jobs }), /needs at least one job/, JSON.stringify(jobs));
  assert.throws(() => probesText({ name: "pc9", jobs: { ask: { intervalSec: 20, limitSec: 65 } }, template: "x @@NAME@@ @@MARGIN@@ @@JOBS@@ @@OTHER@@" }), /placeholder/);
});

// ---- makeAll, end to end ----
function world() {
  const dir = mkdtempSync(join(tmpdir(), "fb-probes-pack-")), bare = join(dir, "origin.git"), work = join(dir, "work"), out = join(dir, "out");
  mkdirSync(out);
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...a], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g("remote", "add", "origin", bare);
  const commit = (subject, files) => { for (const [f, t] of Object.entries(files)) { mkdirSync(join(work, f, ".."), { recursive: true }); writeFileSync(join(work, f), t); } g("add", "-A"); g("commit", "-qm", subject); const sha = g("rev-parse", "HEAD"); g("push", "-q", "origin", "main"); return sha; };
  const a = commit("first (#C100)", { "worker/probe-jobs.mjs": table(two), "docs/x.md": "1\n" });
  assert.equal(makeAll({ repo: work, sha: a, n: 1, out }).ok, true);
  writeFileSync(join(out, "board-store-deploy-pc1.done"), a + "\n");
  return { dir, work, out, a, commit };
}
const probeFiles = (out) => readdirSync(out).filter((f) => /^board-store-probes-pc\d+\.mjs$/.test(f)).sort();

test("makeAll: a pack that changes a job's limit writes the probes step and a steps section naming the job and the file's hash; the first pack and a pack with no change write none", () => {
  const w = world();
  try {
    assert.deepEqual(probeFiles(w.out), [], "the first pack has nothing to compare");
    const b = w.commit("the ask limit (#C101)", { "worker/probe-jobs.mjs": table({ ...two, ask: { intervalSec: 20, limitSec: 65 } }) });
    const r = makeAll({ repo: w.work, sha: b, n: 2, out: w.out });
    assert.equal(r.ok, true, r.why);
    assert.deepEqual(probeFiles(w.out), ["board-store-probes-pc2.mjs"]);
    const step = readFileSync(join(w.out, "board-store-probes-pc2.mjs"), "utf8"), steps = readFileSync(join(w.out, "board-store-pc2-steps.md"), "utf8");
    assert.ok(step.includes('const WANT = {"ask":{"intervalSec":20,"limitSec":65}};'), "only the changed job");
    assert.match(steps, /## Probe jobs \(moves the probe LaunchAgents to the new limits/);
    assert.ok(steps.includes(`board-store-probes-pc2.mjs | cut -c1-64)" = ${r.files["board-store-probes-pc2.mjs"]}`), "the line carries the step's own hash");
    assert.ok(steps.includes(`, probes ${r.files["board-store-probes-pc2.mjs"]}.`), "the full hash list names it");
    assert.match(steps, /ask \(limit 65 s, every 20 s\)/);
    writeFileSync(join(w.out, "board-store-deploy-pc2.done"), b + "\n");
    const c = w.commit("docs only (#C102)", { "docs/x.md": "2\n" });
    assert.equal(makeAll({ repo: w.work, sha: c, n: 3, out: w.out }).ok, true);
    assert.deepEqual(probeFiles(w.out), ["board-store-probes-pc2.mjs"], "no probes step for pc3");
    assert.doesNotMatch(readFileSync(join(w.out, "board-store-pc3-steps.md"), "utf8"), /Probe jobs|probes /);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("makeAll: a probe-jobs file this cannot read refuses the pack and writes nothing", () => {
  const w = world();
  try {
    const b = w.commit("a table by code (#C101)", { "worker/probe-jobs.mjs": "export const JOBS = build();\n" });
    const r = makeAll({ repo: w.work, sha: b, n: 2, out: w.out });
    assert.equal(r.ok, false);
    assert.match(r.why, /cannot be read as the JOBS table/);
    assert.deepEqual(readdirSync(w.out).filter((f) => /pc2/.test(f)), []);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

// ---- the step itself, in a sandbox: HOME is a temp folder, launchctl and plutil are shims on PATH ----
function sandbox({ jobs = { ask: { intervalSec: 20, limitSec: 65 } }, plists } = {}) {
  const home = mkdtempSync(join(tmpdir(), "fb-probes-step-")), bin = join(home, "bin"), log = join(home, "launchctl.log"), agents = join(home, "Library", "LaunchAgents");
  mkdirSync(bin); mkdirSync(agents, { recursive: true });
  // launchctl shim: logs "<verb> <target>"; bootout unloads, bootstrap loads (a marker per job), print succeeds while loaded.
  writeFileSync(join(bin, "launchctl"), `#!/bin/sh\necho "$1 $2" >> "${log}"\ncase "$1" in\n  bootout) rm -f "${home}/loaded-$(basename "$2")"; exit 0;;\n  bootstrap) if [ -n "$FAIL_BOOTSTRAP" ]; then echo "Bootstrap failed: 5" >&2; exit 5; fi; : > "${home}/loaded-$(basename "$3" .plist)"; exit 0;;\n  print) [ -e "${home}/loaded-$(basename "$2")" ];;\nesac\n`);
  writeFileSync(join(bin, "plutil"), `#!/bin/sh\nif grep -q BADPLIST "$2"; then echo "bad plist"; exit 1; fi\nexit 0\n`);
  chmodSync(join(bin, "launchctl"), 0o755); chmodSync(join(bin, "plutil"), 0o755);
  // The plists as the job installer writes them: launchdPlist from the OLD numbers (the alarm 45 s of the ask job before #C1208).
  const old = { ask: { intervalSec: 20, limitSec: 30 }, evidence: { intervalSec: 60, limitSec: 170 } };
  const file = (job) => join(agents, `com.flight-board.store.${job}.plist`);
  for (const job of plists ?? ["ask", "evidence"]) writeFileSync(file(job), launchdPlist({ job, label: `com.flight-board.store.${job}`, nodePath: "/usr/bin/node", script: "/h/probe.mjs", args: ["--config", "/c.json"], logPath: "/h/l.log" }).replace(/alarm \d+;/, `alarm ${old[job].limitSec + OUTER_EXTRA_SEC};`).replace(/(<key>StartInterval<\/key><integer>)\d+/, `$1${old[job].intervalSec}`));
  const step = join(home, "probes.mjs");
  writeFileSync(step, probesText({ name: "pc9", jobs }));
  const run = (arg, env = {}) => spawnSync(process.execPath, arg ? [step, arg] : [step], { encoding: "utf8", env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...env } });
  return { home, file, run, loadLog: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter((l) => !l.startsWith("print")) : []), backup: (job) => `${file(job)}.before-pc9` };
}
const alarmOf = (text) => Number(/alarm (\d+);/.exec(text)[1]);
const intervalOf = (text) => Number(/<key>StartInterval<\/key><integer>(\d+)/.exec(text)[1]);

test("the step: the ask job's alarm goes from 45 to 80 s with a backup, a reload and a read-back; the evidence job named nowhere is untouched; a second run changes nothing more", () => {
  const s = sandbox();
  try {
    const evidenceBefore = readFileSync(s.file("evidence"), "utf8");
    assert.equal(alarmOf(readFileSync(s.file("ask"), "utf8")), 45, "the fixture: the old alarm");
    const first = s.run();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /^PROBES OK: ask alarm 80 s, every 20 s; launchd has them loaded\./);
    const text = readFileSync(s.file("ask"), "utf8");
    assert.equal(alarmOf(text), 65 + OUTER_EXTRA_SEC);
    assert.equal(intervalOf(text), 20);
    assert.ok(text.includes("<string>--config</string><string>/c.json</string>") && text.includes("/h/l.log"), "the rest of the file is as it was");
    assert.equal(alarmOf(readFileSync(s.backup("ask"), "utf8")), 45, "the backup is the file as it was");
    assert.equal(readFileSync(s.file("evidence"), "utf8"), evidenceBefore);
    assert.equal(existsSync(s.backup("evidence")), false);
    assert.deepEqual(s.loadLog().map((l) => l.split(" ")[0]), ["bootout", "bootstrap"], "the ask job was reloaded once, no other");
    assert.match(s.run().stdout, /^PROBES OK: every probe job named here already has its alarm and interval; nothing changed\./);
    assert.equal(readFileSync(s.file("ask"), "utf8"), text);
    assert.equal(s.loadLog().length, 2, "no second reload");
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test("the step: an interval that changed is written too; the first backup is never overwritten by a later run", () => {
  const s = sandbox({ jobs: { ask: { intervalSec: 30, limitSec: 65 } } });
  try {
    assert.equal(s.run().status, 0);
    assert.equal(intervalOf(readFileSync(s.file("ask"), "utf8")), 30);
    const original = readFileSync(s.backup("ask"), "utf8");
    writeFileSync(s.file("ask"), readFileSync(s.file("ask"), "utf8").replace("alarm 80;", "alarm 99;"));
    assert.equal(s.run().status, 0);
    assert.equal(alarmOf(readFileSync(s.file("ask"), "utf8")), 80);
    assert.equal(readFileSync(s.backup("ask"), "utf8"), original, "the first backup stays the file as it was before the first move");
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test("the step: undo puts the backup back and reloads the job; with no backup it refuses; a job with no file here is skipped and said so", () => {
  const s = sandbox({ jobs: { ask: { intervalSec: 20, limitSec: 65 }, usage: { intervalSec: 300, limitSec: 120 } } });
  try {
    assert.match(s.run("undo").stdout, /^PROBES FAILED: no backup of any probe job's file/);
    const first = s.run();
    assert.match(first.stdout, /No LaunchAgent file here for: usage\./);
    const undone = s.run("undo");
    assert.match(undone.stdout, /^PROBES UNDONE: ask run with the alarm and interval they had before/);
    assert.equal(alarmOf(readFileSync(s.file("ask"), "utf8")), 45);
    assert.deepEqual(s.loadLog().map((l) => l.split(" ")[0]), ["bootout", "bootstrap", "bootout", "bootstrap"]);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test("the step refuses, and changes nothing for any job, when a file has no alarm, two alarms or no interval; or plutil rejects the new file; or the job does not come back", () => {
  for (const [why, mangle] of [["no alarm", (t) => t.replace(/alarm \d+;/, "")], ["two alarms", (t) => t.replace("</array>", "<string>alarm 5; exec @ARGV</string></array>")], ["no interval", (t) => t.replace(/<key>StartInterval<\/key><integer>\d+<\/integer>/, "")]]) {
    const s = sandbox({ jobs: { ask: { intervalSec: 20, limitSec: 65 }, evidence: { intervalSec: 60, limitSec: 400 } } });
    try {
      const evidence = readFileSync(s.file("evidence"), "utf8");
      writeFileSync(s.file("ask"), mangle(readFileSync(s.file("ask"), "utf8")));
      const before = readFileSync(s.file("ask"), "utf8");
      const r = s.run();
      assert.equal(r.status, 1, why);
      assert.match(r.stdout, /^PROBES FAILED: the LaunchAgent file for ask has \d alarm and \d StartInterval entries/, why);
      assert.equal(readFileSync(s.file("ask"), "utf8"), before, why);
      assert.equal(readFileSync(s.file("evidence"), "utf8"), evidence, `${why}: the other job too (every file is read before any is written)`);
      assert.deepEqual(s.loadLog(), [], why);
    } finally { rmSync(s.home, { recursive: true, force: true }); }
  }
  const lint = sandbox();
  try {
    writeFileSync(lint.file("ask"), readFileSync(lint.file("ask"), "utf8").replace("<key>Label</key>", "<key>BADPLIST</key><string/><key>Label</key>"));
    const r = lint.run();
    assert.match(r.stdout, /^PROBES FAILED: the new LaunchAgent file for ask did not pass plutil -lint/);
    assert.equal(alarmOf(readFileSync(lint.file("ask"), "utf8")), 45, "the file is as it was");
    assert.deepEqual(readdirSync(join(lint.home, "Library", "LaunchAgents")).filter((f) => f.includes(".new-")), [], "the half-written file is removed");
  } finally { rmSync(lint.home, { recursive: true, force: true }); }
  const noBoot = sandbox();
  try {
    const r = noBoot.run("", { FAIL_BOOTSTRAP: "1" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^PROBES FAILED: launchctl bootstrap failed for ask \(Bootstrap failed: 5\); the file is in place, the backup is .*\.before-pc9\. Paste this line to Manager\./);
  } finally { rmSync(noBoot.home, { recursive: true, force: true }); }
});
