// The landing-job step of pair @@NAME@@ (#C1140): moves the landing job to the owner's pinned install of @@SIGNED@@, for flight-board main @@SIGNED@@. Made by scripts/make-pair.mjs from
// scripts/pair/land.template.mjs, when the pack changes scripts/board-land.mjs or a file it imports. Run by the owner in Terminal AFTER the pair's hooks line (the hooks line creates the
// pinned install): `node board-store-land-@@NAME@@.mjs`. Undo: `node board-store-land-@@NAME@@.mjs undo`.
// The landing job (the LaunchAgent com.flight-board.store.land, every 10 minutes) used to run scripts/board-land.mjs from ~/.flight-board/current, the link every release moves, so a
// changed land job ran before the owner had installed it. This step points the LaunchAgent at ~/.flight-board/install/@@SIGNED@@/scripts/board-land.mjs instead. It does, in order, and stops
// at the first failure:
//  1. checks that file exists (so the hooks line has run);
//  2. reads the LaunchAgent's file and finds the one place it names board-land.mjs (the link, or an earlier pinned install); anything else is refused, nothing changed;
//  3. keeps a backup (com.flight-board.store.land.plist.before-@@NAME@@; an earlier backup is never overwritten), writes the new file beside it, checks it with plutil, and moves it into place;
//  4. reloads the job (launchctl bootout, then bootstrap) and checks that launchd has it again;
//  5. reads the file back: the pinned path once, the link nowhere.
// It touches no other job and no other file. Running it twice changes nothing more.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const SIGNED = "@@SIGNED@@";
const NAME = "@@NAME@@";
const HOME = homedir();
const LABEL = "com.flight-board.store.land";
const PLIST = `${HOME}/Library/LaunchAgents/${LABEL}.plist`;
const PINNED = `${HOME}/.flight-board/install/${SIGNED}/scripts/board-land.mjs`;
const BACKUP = `${PLIST}.before-${NAME}`;
const NAMES_LAND = /<string>([^<\n]*\/\.flight-board\/(?:current|install\/[0-9a-f]{40})\/scripts\/board-land\.mjs)<\/string>/g;
const fail = (why) => { console.log(`LAND FAILED: ${why}. Paste this line to Manager.`); process.exit(1); };
const uid = typeof process.getuid === "function" ? process.getuid() : 501;
const launchctl = (args) => spawnSync("launchctl", args, { encoding: "utf8" });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// bootout, wait until launchd no longer has it, bootstrap (once more after a pause), then the job must answer `launchctl print` (never report a job that is not there).
function reload() {
  const target = `gui/${uid}/${LABEL}`;
  launchctl(["bootout", target]);
  for (let i = 0; i < 20 && launchctl(["print", target]).status === 0; i++) sleep(500);
  let r = launchctl(["bootstrap", `gui/${uid}`, PLIST]);
  if (r.status !== 0) { sleep(2000); r = launchctl(["bootstrap", `gui/${uid}`, PLIST]); }
  if (r.status !== 0) fail(`launchctl bootstrap failed (${String(r.stderr ?? "").trim().split("\n")[0].slice(0, 120)}); the file is in place, the backup is ${BACKUP}`);
  for (let look = 0; ; look++) {
    if (launchctl(["print", target]).status === 0) return;
    if (look >= 3) fail(`the job ${LABEL} is not loaded after the bootstrap (launchctl print cannot find it); undo is: node board-store-land-${NAME}.mjs undo`);
    sleep(500);
  }
}
function put(text) {
  const tmp = `${PLIST}.new-${NAME}`;
  writeFileSync(tmp, text);
  const lint = spawnSync("plutil", ["-lint", tmp], { encoding: "utf8" });
  if (lint.status !== 0) { try { unlinkSync(tmp); } catch { /* none */ } fail(`the new LaunchAgent file did not pass plutil -lint (${String(lint.stdout || lint.stderr).trim().slice(0, 120)}); nothing was changed`); }
  renameSync(tmp, PLIST);
}

if (process.argv[2] === "undo") {
  if (!existsSync(BACKUP)) fail(`no backup at ${BACKUP}`);
  copyFileSync(BACKUP, PLIST);
  reload();
  console.log("LAND UNDONE: the landing job runs from where it did before this step. It has been reloaded.");
  process.exit(0);
}

if (!existsSync(PINNED)) fail(`${PINNED} does not exist (run the pair's hooks line first: it installs the pinned copy)`);
if (!existsSync(PLIST)) fail(`${PLIST} does not exist`);
const before = readFileSync(PLIST, "utf8");
const found = [...before.matchAll(NAMES_LAND)];
if (found.length !== 1) fail(`the LaunchAgent file names board-land.mjs ${found.length} times, in a form this step knows (the link or a pinned install): expected exactly one; nothing was changed`);
if (found[0][1] === PINNED) { console.log(`LAND OK: the landing job already runs from the pinned install of ${SIGNED.slice(0, 8)}; nothing changed.`); process.exit(0); }

if (!existsSync(BACKUP)) copyFileSync(PLIST, BACKUP);
put(before.replace(NAMES_LAND, `<string>${PINNED}</string>`));
reload();

const after = readFileSync(PLIST, "utf8");
const now = [...after.matchAll(NAMES_LAND)].map((m) => m[1]);
if (now.length !== 1 || now[0] !== PINNED || after.includes("/.flight-board/current/")) fail(`the read-back is wrong (${now.join(", ") || "no board-land.mjs"}); undo is: node board-store-land-${NAME}.mjs undo`);
console.log(`LAND OK: the landing job runs ~/.flight-board/install/${SIGNED.slice(0, 8)}.../scripts/board-land.mjs and launchd has it loaded. Backup: ${BACKUP}. Undo: node board-store-land-${NAME}.mjs undo`);
