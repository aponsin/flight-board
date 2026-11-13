#!/usr/bin/env node
// #C1059: `npm test` runs the suite in a temp folder of its own and fails when anything is left in it. The suite used to leave its temp
// folders behind (Ops measured the temp dir: card-eta-wrap-* 5.8 GB, tmp.* fake home folders 14.2 GB, besides fb-, publish-, board-release-
// and race-), so every run filled the disk a little more. Now: the run's TMPDIR is a fresh folder under the caller's TMPDIR (or the system
// one); a test that does not remove what it made leaves an entry there; the wrapper names the entries (first 20, with their sizes), removes the
// folder so the leak does not pile up, and exits 1. A failing test run keeps its own exit code.
// usage: node scripts/test-run.mjs [test files or globs...]   (default: tests/*.test.mjs, which node expands itself)
import { mkdtempSync, readdirSync, lstatSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

// Runs the suite; returns { status, left }. `run` and the temp parent are parameters so a test can drive it without the whole suite.
export function runSuite({ args = ["tests/*.test.mjs"], parent = process.env.TMPDIR || tmpdir(), run = spawnSync, cwd = process.cwd() } = {}) {
  const root = mkdtempSync(join(parent, "suite-"));
  let status = 1;
  try {
    const r = run(process.execPath, ["--test", ...args], { cwd, env: { ...process.env, TMPDIR: root }, stdio: "inherit" });
    status = typeof r.status === "number" ? r.status : 1;
    const left = leftovers(root);
    return { status, left, root };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const { status, left } = runSuite(args.length ? { args } : {});
  if (left.length) console.error(leftoverLine(left));
  process.exit(status !== 0 ? status : left.length ? 1 : 0);
}
