// The pickup digests (#C338, the context-tax brief's card C): each collector run, after its board work, refreshes every
// role's digest (notes/pickup/<Role>.md, Builder's #C336) in each refresh repository (collector.refresh.repos) whose main
// ships scripts/pickup-digest.mjs, so a pickup after a crash starts lean too. The file runs as that repository's main has
// it (git show <remote>/<main>:<file>, into a folder of its own), never the checkout's working copy: only reviewed code
// runs in the collector's process. It runs in the repository (the script finds its main checkout from there) with --all
// --no-fetch (the collector's run doesn't fetch the team's checkouts; the refs are as their sessions left them).
// A repository without the file says nothing; a failure is one PICKUP line, never a stop: the board's work is done.
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { home } from "../gate/gate.mjs";

export const PICKUP_SCRIPT = "scripts/pickup-digest.mjs";
const TIMEOUT_MS = 60e3;

// One "PICKUP <repo>: …" line per repository that ships the script.
export function refreshPickups(repos, { remote = "origin", main = "main", timeoutMs = TIMEOUT_MS } = {}) {
  const out = [];
  for (const r of repos ?? []) {
    const at = home(r);
    if (!existsSync(at)) continue;
    let src;
    try { src = execFileSync("git", ["-C", at, "show", `${remote}/${main}:${PICKUP_SCRIPT}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024 }); } catch { continue; }
    const name = basename(at);
    const dir = mkdtempSync(join(tmpdir(), "flight-board-pickup-"));
    try {
      const file = join(dir, "pickup-digest.mjs");
      writeFileSync(file, src);
      const run = spawnSync(process.execPath, [file, "--all", "--no-fetch"], { cwd: at, encoding: "utf8", timeout: timeoutMs });
      if (run.error?.code === "ETIMEDOUT") out.push(`PICKUP ${name}: failed (timed out after ${timeoutMs / 1000} s)`);
      else if (run.status !== 0) out.push(`PICKUP ${name}: failed (exit ${run.status}): ${String(run.stderr ?? "").trim().split("\n")[0].slice(0, 160)}`);
      else out.push(`PICKUP ${name}: ${String(run.stdout).split("\n").filter((l) => / bytes/.test(l)).length} digest(s) refreshed`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}
