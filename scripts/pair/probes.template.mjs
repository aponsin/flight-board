// The probe-jobs step of pair @@NAME@@ (#C1210): moves the probe jobs' LaunchAgents to the time limits and intervals of worker/probe-jobs.mjs (JOBS) at this pack's main. Made by
// scripts/make-pair.mjs from scripts/pair/probes.template.mjs, only when a job's limitSec or intervalSec differs from the last pack's. Run by the owner in Terminal: `node board-store-probes-@@NAME@@.mjs`.
// Undo: `node board-store-probes-@@NAME@@.mjs undo`.
// Each probe job is a LaunchAgent (com.flight-board.store.<job>) that starts the job through perl's alarm: the OS ends it at limitSec + the margin, and launchd starts it every intervalSec. A pack
// that changed a job's limit changed the program's own limit only; the alarm in the LaunchAgent stayed (#C1208: the ask job's second send was cut at the old 45 s alarm). This step, for each job
// named below (the ones whose numbers changed), in order, stopping at the first failure:
//  1. reads the LaunchAgent's file; a job with no file here is skipped and said so; a file with not exactly one `alarm N;` and one StartInterval is refused, with nothing changed (all files are read before any is written);
//  2. keeps a backup (<file>.before-@@NAME@@; an earlier backup is never overwritten), writes the new file beside it, checks it with plutil, and moves it into place;
//  3. reloads the job (launchctl bootout, then bootstrap) and checks that launchd has it again;
//  4. reads the file back: the alarm and the interval are the wanted ones.
// It touches no other job, no other key and no other file. Running it twice changes nothing more.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "@@NAME@@";
const MARGIN = @@MARGIN@@;
const WANT = @@JOBS@@;
const HOME = homedir();
const label = (job) => `com.flight-board.store.${job}`;
const plistOf = (job) => `${HOME}/Library/LaunchAgents/${label(job)}.plist`;
const backupOf = (job) => `${plistOf(job)}.before-${NAME}`;
const ALARM = /alarm (\d+); exec @ARGV/g;
const INTERVAL = /(<key>StartInterval<\/key>\s*<integer>)(\d+)(<\/integer>)/g;
// A step that ran (every job it names is now as wanted) leaves board-store-probes-@@NAME@@.done beside itself: the next pack compares with this pack's table only then (scripts/make-pair.mjs lastProbesPair).
const ran = () => { try { writeFileSync(join(dirname(fileURLToPath(import.meta.url)), `board-store-probes-${NAME}.done`), "ok\n"); } catch { /* the marker is a convenience: without it the next pack names every job again, which is harmless */ } };
const fail = (why) => { console.log(`PROBES FAILED: ${why}. Paste this line to Manager.`); process.exit(1); };
const uid = typeof process.getuid === "function" ? process.getuid() : 501;
const launchctl = (args) => spawnSync("launchctl", args, { encoding: "utf8" });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function reload(job) {
  const target = `gui/${uid}/${label(job)}`;
  launchctl(["bootout", target]);
  for (let i = 0; i < 20 && launchctl(["print", target]).status === 0; i++) sleep(500);
  let r = launchctl(["bootstrap", `gui/${uid}`, plistOf(job)]);
  if (r.status !== 0) { sleep(2000); r = launchctl(["bootstrap", `gui/${uid}`, plistOf(job)]); }
  if (r.status !== 0) fail(`launchctl bootstrap failed for ${job} (${String(r.stderr ?? "").trim().split("\n")[0].slice(0, 120)}); the file is in place, the backup is ${backupOf(job)}`);
  for (let look = 0; ; look++) {
    if (launchctl(["print", target]).status === 0) return;
    if (look >= 3) fail(`the job ${label(job)} is not loaded after the bootstrap (launchctl print cannot find it); undo is: node board-store-probes-${NAME}.mjs undo`);
    sleep(500);
  }
}
function put(job, text) {
  const tmp = `${plistOf(job)}.new-${NAME}`;
  writeFileSync(tmp, text);
  const lint = spawnSync("plutil", ["-lint", tmp], { encoding: "utf8" });
  if (lint.status !== 0) { try { unlinkSync(tmp); } catch { /* none */ } fail(`the new LaunchAgent file for ${job} did not pass plutil -lint (${String(lint.stdout || lint.stderr).trim().slice(0, 120)}); nothing was changed for it`); }
  renameSync(tmp, plistOf(job));
}

if (process.argv[2] === "undo") {
  const back = Object.keys(WANT).filter((job) => existsSync(backupOf(job)));
  if (!back.length) fail(`no backup of any probe job's file (${backupOf(Object.keys(WANT)[0])} and the others)`);
  for (const job of back) { copyFileSync(backupOf(job), plistOf(job)); reload(job); }
  console.log(`PROBES UNDONE: ${back.join(", ")} run with the alarm and interval they had before this step. They have been reloaded.`);
  process.exit(0);
}

// Read every file first: a file that is not what this step knows refuses the whole step before any file is written.
const plan = [], skipped = [];
for (const [job, want] of Object.entries(WANT)) {
  const file = plistOf(job);
  if (!existsSync(file)) { skipped.push(job); continue; }
  const before = readFileSync(file, "utf8");
  const alarms = [...before.matchAll(ALARM)], intervals = [...before.matchAll(INTERVAL)];
  if (alarms.length !== 1 || intervals.length !== 1) fail(`the LaunchAgent file for ${job} has ${alarms.length} alarm and ${intervals.length} StartInterval entries in a form this step knows: expected one of each; nothing was changed`);
  const alarm = want.limitSec + MARGIN;
  if (Number(alarms[0][1]) === alarm && Number(intervals[0][2]) === want.intervalSec) continue;
  plan.push({ job, before, alarm, interval: want.intervalSec });
}
if (!plan.length) { console.log(`PROBES OK: every probe job named here already has its alarm and interval${skipped.length ? ` (no LaunchAgent file here for: ${skipped.join(", ")})` : ""}; nothing changed.`); ran(); process.exit(0); }

for (const p of plan) {
  if (!existsSync(backupOf(p.job))) copyFileSync(plistOf(p.job), backupOf(p.job));
  put(p.job, p.before.replace(ALARM, `alarm ${p.alarm}; exec @ARGV`).replace(INTERVAL, (_, open, _old, close) => `${open}${p.interval}${close}`));
  reload(p.job);
  const after = readFileSync(plistOf(p.job), "utf8");
  const a = [...after.matchAll(ALARM)].map((m) => Number(m[1])), i = [...after.matchAll(INTERVAL)].map((m) => Number(m[2]));
  if (a.length !== 1 || a[0] !== p.alarm || i.length !== 1 || i[0] !== p.interval) fail(`the read-back of ${p.job} is wrong (alarm ${a.join(", ") || "none"}, interval ${i.join(", ") || "none"}); undo is: node board-store-probes-${NAME}.mjs undo`);
}
console.log(`PROBES OK: ${plan.map((p) => `${p.job} alarm ${p.alarm} s, every ${p.interval} s`).join("; ")}; launchd has them loaded.${skipped.length ? ` No LaunchAgent file here for: ${skipped.join(", ")}.` : ""} Backups: <file>.before-${NAME}. Undo: node board-store-probes-${NAME}.mjs undo`);
ran();
