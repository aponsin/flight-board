// #C1059: preloaded into every test file's process by scripts/test-run.mjs (node --import). A test that makes a folder with mkdtemp and never removes it
// used to leave it in the temp dir for good (698 entries, 170 MB a run). This records each folder mkdtempSync, mkdtemp and fs.promises.mkdtemp make
// directly in this run's temp root (TMPDIR, which the wrapper sets to a folder of its own) and removes them when the process ends, so a test no longer has
// to. Nothing outside that root is ever touched, and a folder made some other way (mkdirSync in the temp dir, a shell's mktemp, a child's own TMPDIR) is
// not recorded: the wrapper still lists what is left and fails the run, so those are found, not hidden.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, resolve } from "node:path";

// #C1371: a test file's process leaves a marker (its path) in SUITE_ALIVE_DIR when it starts and removes it when it ends by itself, by process.exit or
// by an uncaught error; a process killed by a signal (the node 24.21.0 V8 SIGSEGV under load, #C1370) runs no exit handler, so its marker stays and
// scripts/test-run.mjs knows that file died by a signal and not by a failing test. Only a process node:test started for a *.test.mjs file writes one.
const entry = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return ""; } })();
if (process.env.SUITE_ALIVE_DIR && process.env.NODE_TEST_CONTEXT && /\.test\.mjs$/.test(entry)) {
  const mark = `${process.env.SUITE_ALIVE_DIR}/${process.pid}`;
  try {
    fs.writeFileSync(mark, entry);
    process.on("exit", () => { try { fs.rmSync(mark, { force: true }); } catch { /* the marker stays: the file is retried once, which costs only time */ } });
  } catch { /* no marker: a signal death of this file is then a plain failure, as before */ }
}

export const made = new Set();
const root = process.env.TMPDIR ? resolve(process.env.TMPDIR) : null;
const keep = (path) => {
  if (!root || typeof path !== "string") return path;
  const p = resolve(path);
  if (dirname(p) === root) made.add(p);
  return path;
};

if (root && !globalThis.__testTmpClean) {
  globalThis.__testTmpClean = true;
  const sync = fs.mkdtempSync;
  fs.mkdtempSync = function mkdtempSync(...a) { return keep(sync.apply(this, a)); };
  const cb = fs.mkdtemp;
  fs.mkdtemp = function mkdtemp(...a) {
    const last = a.length - 1;
    if (typeof a[last] === "function") { const done = a[last]; a[last] = (err, dir) => { if (!err) keep(dir); done(err, dir); }; }
    return cb.apply(this, a);
  };
  const prom = fs.promises.mkdtemp;
  fs.promises.mkdtemp = async function mkdtemp(...a) { return keep(await prom.apply(this, a)); };
  syncBuiltinESMExports();
  process.on("exit", () => { for (const p of made) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* the wrapper names what is left */ } } });
}
