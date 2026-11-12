// #C1013: is a landed card already covered by a deploy pair that is built and waits only for the owner's install? Read-only, no network.
// The pairs are the files scripts/make-pair.mjs writes into the owner's folder: board-store-deploy-pc<n>.mjs holding `const SIGNED = "<40 hex>"`, and
// board-store-deploy-pc<n>.done once the deploy step ran (holding the same sha). The pair that waits is the NEWEST one, when it has not run: an older
// never-run pair was replaced by it. Kept here, not imported from make-pair.mjs, so the probe has no dependency on the pair tool's file being in its pack.
// What is not checked here: Security's SAFE note on the pair (Manager's pick A on #C1013, said on the card).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { BOARD_REPO_WORDS } from "./store-dispatch.mjs";

// { n, sha } of the newest pair when it has not run, else null (no folder, no pair, no pin, or the newest ran).
export function waitingPair(folder) {
  if (typeof folder !== "string" || !folder || !existsSync(folder)) return null;
  let names;
  try { names = readdirSync(folder); } catch { return null; }
  const n = Math.max(-1, ...names.map((f) => /^board-store-deploy-pc(\d{1,6})\.mjs$/.exec(f)).filter(Boolean).map((m) => Number(m[1])));
  if (n < 0) return null;
  let sha;
  try { sha = /const SIGNED = "([0-9a-f]{40})"/.exec(readFileSync(join(folder, `board-store-deploy-pc${n}.mjs`), "utf8"))?.[1]; } catch { return null; }
  if (!sha) return null; // a deploy file with no pin is no pair
  let ran = false;
  try { ran = names.includes(`board-store-deploy-pc${n}.done`) && readFileSync(join(folder, `board-store-deploy-pc${n}.done`), "utf8").trim() === sha; } catch { /* not run */ }
  return ran ? null : { n, sha };
}

// Whether the commit `landing` is the pair's pin or an ancestor of it (the pin descends from the landing). git(args) -> { status }; an answer it cannot give is false.
export function descends(git, landing, pin) {
  if (!/^[0-9a-f]{40}$/.test(landing ?? "") || !/^[0-9a-f]{40}$/.test(pin ?? "")) return false;
  if (landing === pin) return true;
  try { return git(["merge-base", "--is-ancestor", landing, pin]).status === 0; } catch { return false; }
}

// The checkout the pair's pin and the landed board cards live in (#C1013 Checker F1): the collector.repos entry named for the board's repository (a repo
// word the board uses), else collector.repoPath, the team's own repository, which is the board's only when the team's repository is the board's.
// On an install whose repoPath is the product repository, using it would make every ancestor question fail and the skip never fire.
export function boardRepoPath(collector) {
  const entry = (Array.isArray(collector?.repos) ? collector.repos : []).find((r) => r && typeof r.name === "string" && BOARD_REPO_WORDS.has(r.name) && typeof r.path === "string" && r.path);
  return entry ? entry.path : (typeof collector?.repoPath === "string" ? collector.repoPath : "");
}

// The function the dispatch asks per landed card: (full sha) -> true when the waiting pair covers it. null when no folder is set or no pair waits
// (the dispatch then skips nothing, today's behaviour). The pin is read once here, per run.
export function pairCoversFor({ folder, repoPath, git = (args) => { try { execFileSync("git", ["-C", repoPath, ...args], { stdio: "ignore", timeout: 5000 }); return { status: 0 }; } catch (e) { return { status: typeof e?.status === "number" ? e.status : 128 }; } } }) {
  const pair = typeof folder === "string" && folder && typeof repoPath === "string" && repoPath ? waitingPair(folder) : null;
  return pair ? (sha) => descends(git, sha, pair.sha) : null;
}
