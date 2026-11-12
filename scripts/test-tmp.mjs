// #C989: runs a test command with its own temp folder and fails when the run leaves anything in it.
// 11-11 the Studio's disk filled with ~6 million leftover test folders from both repositories and stopped every agent.
// Each run gets TMPDIR = <system temp>/testrun-XXXXXX, so a run still in progress (another worktree's, CI's) is never
// counted, and the folder is removed at the end whatever happens: a leak can no longer pile up. A folder named
// "keep-*" (kept on purpose to debug a failure) is moved up to the system temp and named; anything else fails the run.
//   node scripts/test-tmp.mjs <command> [args...]
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Node's own compile cache sits in the temp folder; it is no test's.
const OURS_NOT = ["node-compile-cache"];
// Pure: the run folder's entries -> what is kept on purpose and what was left behind, by prefix.
export function leftovers(names) {
  const kept = [], left = [];
  for (const n of names) { if (n.startsWith("keep-")) kept.push(n); else if (!OURS_NOT.includes(n)) left.push(n); }
  const byPrefix = {};
  for (const n of left) { const k = n.replace(/[-_.]?[A-Za-z0-9]{6}$/, "").replace(/[-_]?\d+$/, "") || n; byPrefix[k] = (byPrefix[k] ?? 0) + 1; }
  return { kept, left, byPrefix };
}
export function leftoverLine({ left, byPrefix }) {
  const top = Object.entries(byPrefix).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ×${n}`).join(", ");
  return `test-tmp: the run left ${left.length} temp folder${left.length === 1 ? "" : "s"} (${top}): remove each in an after or finally hook, or name it keep-* to keep it`;
}

async function main(argv) {
  if (!argv.length) { console.error("test-tmp: say the command, e.g. node scripts/test-tmp.mjs node --test tests/"); return 2; }
  const base = tmpdir();
  const run = mkdtempSync(join(base, "testrun-"));
  let code = 1;
  try {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", env: { ...process.env, TMPDIR: run, TMP: run, TEMP: run } });
    const stop = (sig) => child.kill(sig);
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    code = await new Promise((done) => child.on("close", (c, sig) => done(c ?? (sig ? 1 : 1))));
    const found = leftovers(readdirSync(run));
    for (const k of found.kept) { const to = join(base, k); try { renameSync(join(run, k), to); console.error(`test-tmp: kept ${to}`); } catch { /* leave it to the removal */ } }
    if (found.left.length) { console.error(leftoverLine(found)); if (code === 0) code = 1; }
  } finally { rmSync(run, { recursive: true, force: true }); }
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
