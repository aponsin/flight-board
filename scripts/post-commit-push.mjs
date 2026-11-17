#!/usr/bin/env node
// #C1102 (a) (the owner, 2026-11-16:the board shows a builder's work within 2 minutes of the commit; g13 showed one card building while three were committed on a local branch,
// and they all turned "built" at once at READY, 20 to 30 minutes late): .githooks/post-commit runs this after every commit. A commit on a build/ branch is pushed to the
// same branch of origin at once, so the probe sees the branch on its next run (every 60 s) and the card reads as building.
// The push wakes no reviewer: in a stack-mode repository a pushed tip is Building until the builder's READY signal covers it (#C1066).
// Never harmful to the commit: no force (a branch origin has moved is left alone), no other branch than build/*, no detached HEAD (a rebase or a cherry-pick in a detached state),
// nothing when FB_NO_WIP_PUSH is set, no output, exit 0 whatever happens. The push is a plain `git push`, so the pre-push hook (content scan, Board-Id trailer, group order) judges
// it as it judges every push: a push it refuses is simply not made. The push runs detached so the commit returns at once (FB_WIP_PUSH_SYNC=1 runs it inline, for the tests).
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

// The branch name a commit on `ref` (HEAD's symbolic ref) should be pushed as, or null: only refs/heads/build/<name> in the plain shape.
export const BUILD_BRANCH = /^refs\/heads\/(build\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}){0,2})$/;
export const branchToPush = (ref) => { const m = BUILD_BRANCH.exec(String(ref ?? "").trim()); return m ? m[1] : null; };

// The push, with `git` injected: git(args) returns the output or throws. { pushed, why } says what happened, for the tests; the hook says nothing.
// #C1126 (Checker 2's LOW 2): the hook process reads the commit and the branch right after the commit and hands both to the detached child (`sha` and `ref`), so a branch switch
// or a second commit before the child runs cannot push another commit to this name: the push is `<sha>:refs/heads/<branch>`. With neither given (the tests, --now by hand) it reads HEAD.
export const SHA = /^[0-9a-f]{40,64}$/;
export function wipPush({ git, env = process.env, sha = null, ref = null }) {
  if (env.FB_NO_WIP_PUSH) return { pushed: false, why: "switched off" };
  if (ref == null) { try { ref = git(["symbolic-ref", "-q", "HEAD"]); } catch { return { pushed: false, why: "detached" }; } }
  const branch = branchToPush(ref);
  if (!branch) return { pushed: false, why: "not a build branch" };
  if (sha != null && !SHA.test(String(sha))) return { pushed: false, why: "not a commit" };
  try { git(["remote", "get-url", "origin"]); } catch { return { pushed: false, why: "no origin" }; }
  try { git(["push", "-q", "origin", `${sha ?? "HEAD"}:refs/heads/${branch}`]); } catch { return { pushed: false, why: "push refused" }; }
  return { pushed: true, why: "pushed", branch };
}

// The `--sha=` and `--ref=` the hook process passes to the child.
export function passedFacts(argv) {
  const pick = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
  return { sha: pick("sha"), ref: pick("ref") };
}

const run = (args) => String(execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 120_000 }));

function main() {
  try {
    if (process.argv.includes("--now")) { wipPush({ git: run, ...passedFacts(process.argv) }); return; }
    // Cheap checks first: a commit that is not on a build/ branch spawns nothing.
    if (process.env.FB_NO_WIP_PUSH) return;
    const ref = run(["symbolic-ref", "-q", "HEAD"]);
    if (!branchToPush(ref)) return;
    const sha = run(["rev-parse", "HEAD"]).trim();
    if (process.env.FB_WIP_PUSH_SYNC === "1") { wipPush({ git: run, sha, ref }); return; }
    spawn(process.execPath, [fileURLToPath(import.meta.url), "--now", `--sha=${sha}`, `--ref=${ref.trim()}`], { detached: true, stdio: "ignore", cwd: process.cwd() }).unref();
  } catch { /* the commit is never harmed */ }
}

// #C1167: both sides by their real path (a link to this file must still run it). Inline, not scripts/is-main.mjs: this is a git hook that exits 0 whatever happens and imports nothing of ours.
const isMainFile = () => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMainFile()) { main(); process.exitCode = 0; }
