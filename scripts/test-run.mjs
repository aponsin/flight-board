#!/usr/bin/env node
// #C1059: `npm test` runs the suite in a temp folder of its own and fails when anything is left in it. The suite used to leave its temp
// folders behind (Ops measured the temp dir: card-eta-wrap-* 5.8 GB, tmp.* fake home folders 14.2 GB, besides fb-, publish-, board-release-
// and race-), so every run filled the disk a little more. Now: the run's TMPDIR is a fresh folder under the caller's TMPDIR (or the system
// one); a test that does not remove what it made leaves an entry there; the wrapper names the entries (first 20, with their sizes), removes the
// folder so the leak does not pile up, and exits 1. A failing test run keeps its own exit code.
// usage: node scripts/test-run.mjs [test files or globs...]   (default: tests/*.test.mjs, which node expands itself)
import { mkdtempSync, readdirSync, lstatSync, rmSync, existsSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Each test file's process loads this first: it removes, at exit, the mkdtemp folders the test made in this run's temp root (see the file).
const PRELOAD = pathToFileURL(fileURLToPath(new URL("./test-tmp-clean.mjs", import.meta.url))).href;

// The bytes under a path, symlinks counted as themselves and never followed.
export function sizeOf(path) {
  let st;
  try { st = lstatSync(path); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  try { for (const e of readdirSync(path)) total += sizeOf(join(path, e)); } catch { /* unreadable: counts what it could */ }
  return total;
}

// What a run left in its temp root: [{ name, bytes }], biggest first. A root that is gone leaves nothing.
export function leftovers(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root).map((name) => ({ name, bytes: sizeOf(join(root, name)) })).sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1));
}

const mb = (n) => (n / 1048576).toFixed(n >= 10485760 ? 0 : 1);
// A leftover's prefix, the part a test author greps for: mkdtemp adds six random characters ("fb-Ab3dEf" is "fb-"), a shell's mktemp -d names
// "tmp.XXXXXXXXXX" (all "tmp.").
export const prefixOf = (name) => (/^tmp\.[A-Za-z0-9]+$/.test(name) ? "tmp." : name.replace(/[A-Za-z0-9]{6}$/, "") || name);
// The leftovers by prefix, the biggest first: [{ prefix, count, bytes }].
export function leftoverGroups(list) {
  const by = new Map();
  for (const x of list) { const p = prefixOf(x.name), g = by.get(p) ?? { prefix: p, count: 0, bytes: 0 }; g.count++; g.bytes += x.bytes; by.set(p, g); }
  return [...by.values()].sort((a, b) => b.bytes - a.bytes || (a.prefix < b.prefix ? -1 : 1));
}
// The failure text: how many entries and how much, then the prefixes to grep the tests and scripts for (20 at most, then "and N more").
export function leftoverLine(list, max = 20) {
  if (!list.length) return "";
  const total = list.reduce((s, x) => s + x.bytes, 0), groups = leftoverGroups(list);
  const shown = groups.slice(0, max).map((g) => `${g.prefix}* x${g.count} (${mb(g.bytes)} MB)`).join(", ");
  return `TEST TEMP LEFTOVERS: ${list.length} ${list.length === 1 ? "entry" : "entries"}, ${mb(total)} MB, left by tests that did not remove their own temp folder: ${shown}${groups.length > max ? `, and ${groups.length - max} more prefixes` : ""}. Remove it in the test (afterEach / finally with rmSync(dir, { recursive: true, force: true })).`;
}

// #C1091: the failing tests, one "FAILED <file>: <name> -- <why>" line each, written by scripts/test-failures-reporter.mjs beside the spec reporter into
// FAILURES_NAME in the run's root, copied to <parent>/last-suite-failures.txt (or SUITE_FAILURES_FILE) when the run ends (a clean run removes the old
// copy), and printed as the LAST lines of the run: a cut-off run still shows what failed (11-16: a red first run on #C1075 whose output was cut).
export const FAILURES_NAME = "failures.txt", FAILURES_COPY = "last-suite-failures.txt", FAILURES_SHOWN = 40;
const REPORTER = pathToFileURL(fileURLToPath(new URL("./test-failures-reporter.mjs", import.meta.url))).href;
export const failuresOf = (text) => String(text ?? "").split("\n").filter((l) => l.startsWith("FAILED "));
// The closing lines: how many failed, the first FAILURES_SHOWN, "and N more", and where the whole list is. "" when nothing failed.
export function failuresLine(list, file, max = FAILURES_SHOWN) {
  if (!list.length) return "";
  return [`FAILED TESTS (${list.length}):`, ...list.slice(0, max), ...(list.length > max ? [`... and ${list.length - max} more`] : []), `(the whole list: ${file})`].join("\n");
}

// #C1371: the test files whose process was killed by a signal: the markers scripts/test-tmp-clean.mjs left in the alive folder (a file that ends by
// itself, even by process.exit or a failing test, removes its own). A file name appears once however many markers it left.
export function diedBySignal(aliveDir) {
  let names = [];
  try { names = readdirSync(aliveDir); } catch { return []; }
  const files = new Set();
  for (const n of names) { try { const f = readFileSync(join(aliveDir, n), "utf8").trim(); if (f) files.add(f); } catch { /* gone */ } }
  return [...files].sort();
}

// Runs the suite; returns { status, left, failed, failuresFile, retried }. `run` and the temp parent are parameters so a test can drive it without the whole suite.
// #C1371: a test file killed by a signal (not one that failed a test, not one that called process.exit) is run once more, alone, with a loud line either way:
// the second run passing means the run is green with the WARNING printed; it dying or failing again is a failure. Any other failing test fails the run as before.
export function runSuite({ args = ["tests/*.test.mjs"], parent = process.env.TMPDIR || tmpdir(), run = spawnSync, cwd = process.cwd(), failuresFile = process.env.SUITE_FAILURES_FILE || join(parent, FAILURES_COPY), warn = (line) => console.error(line) } = {}) {
  const root = mkdtempSync(join(parent, "suite-"));
  const alive = mkdtempSync(join(parent, "suite-alive-"));
  let status = 1;
  try {
    // NODE_OPTIONS, not a flag, so the preload also reaches the node processes a test starts (scripts/board-release.mjs leaves its snapshot folder
    // when it ends with process.exit inside its try, and it is owner-pinned, so it is cleaned from outside).
    const NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${PRELOAD}`].filter(Boolean).join(" ");
    // One run of node --test over `files`: its status, its failing-test lines, and the files a signal killed.
    const attempt = (files, name) => {
      const list = join(root, name), dir = mkdtempSync(join(alive, "run-"));
      const r = run(process.execPath, ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout", `--test-reporter=${REPORTER}`, `--test-reporter-destination=${list}`, ...files], { cwd, env: { ...process.env, TMPDIR: root, NODE_OPTIONS, SUITE_ALIVE_DIR: dir }, stdio: "inherit" });
      let text = "";
      try { text = readFileSync(list, "utf8"); } catch { /* no failure was reported */ }
      try { rmSync(list, { force: true }); } catch { /* the leftovers check will name it */ }
      return { status: typeof r.status === "number" ? r.status : 1, failed: failuresOf(text), killed: diedBySignal(dir) };
    };
    const first = attempt(args, FAILURES_NAME);
    status = first.status;
    let failed = first.failed;
    const retried = [];
    if (status !== 0 && first.killed.length) {
      // Paths are compared as real paths: the failing-test lines hold the file relative to the reporter's cwd (already a real path), the markers what
      // node was given (/var and /private/var on a Mac are the same folder).
      const real = (p) => { try { return realpathSync(p); } catch { return p; } };
      const base = real(cwd);
      const rels = new Map(first.killed.map((f) => [f, relative(base, real(f)) || f]));
      const fileOf = (l) => { const m = /^FAILED (.*?): /.exec(l); return m ? real(resolve(base, m[1])) : ""; };
      const killedReal = new Set(first.killed.map(real));
      const others = failed.filter((l) => !killedReal.has(fileOf(l)));
      const again = [];
      for (const f of first.killed) {
        const rel = rels.get(f);
        warn(`TEST FILE KILLED BY A SIGNAL: ${rel} died without reporting a result (not a failing test); running it once more, alone.`);
        const second = attempt([f], "failures-again.txt");
        const bad = second.status !== 0 || second.killed.length > 0;
        retried.push({ file: rel, ok: !bad });
        if (!bad) { warn(`WARNING: ${rel} passed on its second run after a signal killed it; this run counts as green. Look for a crash report: ls -t ~/Library/Logs/DiagnosticReports/node-*.ips | head -3`); continue; }
        if (second.killed.length) again.push(`FAILED ${rel}: killed by a signal on both runs`);
        else if (second.failed.length) again.push(...second.failed);
        else again.push(`FAILED ${rel}: failed on its second run`);
      }
      failed = [...others, ...again];
      // Green only when every failing line was a killed file's and each of those files then passed; a failure with no line listed stays a failure.
      if (!others.length && !again.length && first.failed.length) status = 0;
    }
    try { if (failed.length) writeFileSync(failuresFile, `${failed.join("\n")}\n`); else rmSync(failuresFile, { force: true }); } catch { /* the lines are printed anyway */ }
    const left = leftovers(root);
    return { status, left, root, failed, failuresFile, retried };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(alive, { recursive: true, force: true });
  }
}

// realpath on both sides (Checker 2's F1 on 85b2a56e): ESM resolves import.meta.url to the real path, so through a symlinked path the plain comparison was
// false and the script ran nothing and exited 0.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const { status, left, failed, failuresFile } = runSuite(args.length ? { args } : {});
  if (left.length) console.error(leftoverLine(left));
  // Last: whatever scrolled or was cut above, these lines name every failing test.
  if (failed.length) console.error(failuresLine(failed, failuresFile));
  process.exit(status !== 0 ? status : left.length ? 1 : 0);
}
