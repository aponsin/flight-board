// #C896 (prevention, 2026-11-10: #C883 v2 was signed by both reviewers, then refused at landing because its Board-Id line sat
// in its own paragraph, which git does not read as a trailer). Run by the pre-push hook (.githooks/pre-push) after the scan:
// for each pushed build/ branch, every commit it would land (the branch less <remote>/main) must carry a Board-Id trailer
// naming a card, read exactly as the landing reads it (board-release.mjs: TRAILER_LOG, parseTrailerLog, untrailered).
// A READY can then never fail at landing on its trailer. Other refs (main, notes, tags) and deleted refs are not checked.
// Usage: node scripts/trailer-check.mjs <remote>   (the refs on stdin; exit 1 with one line per commit)
import { realpathSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TRAILER_LOG, parseTrailerLog, untrailered } from "./board-release.mjs";

const ZERO = /^0+$/;
// The commits the push would land per build/ branch, without a good trailer. git(args) -> stdout. [{ ref, sha }]
export function missingTrailers(stdin, git, remoteName) {
  const remote = remoteName && !remoteName.startsWith("-") ? remoteName : "origin";
  const main = `refs/remotes/${remote}/main`;
  let base = true;
  try { git(["rev-parse", "--verify", "-q", main]); } catch { base = false; }
  const out = [];
  for (const line of String(stdin).split("\n")) {
    const [, local, remoteRef] = line.trim().split(/\s+/);
    if (!local || ZERO.test(local) || !/^refs\/heads\/build\//.test(remoteRef ?? "")) continue;
    const range = base ? [local, "--not", main] : [local, "--not", `--remotes=${remote}`];
    const log = git(["log", `--format=${TRAILER_LOG}`, ...range]);
    for (const sha of untrailered(parseTrailerLog(log))) out.push({ ref: remoteRef, sha });
  }
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const bad = missingTrailers(readFileSync(0, "utf8"), git, process.argv[2]);
  for (const b of bad) console.error(`${b.sha.slice(0, 12)} on ${b.ref.replace("refs/heads/", "")}: no Board-Id trailer git can read`);
  if (bad.length) {
    console.error(`Trailer check: ${bad.length} commit(s) without a Board-Id trailer. Nothing pushed. Put "Board-Id: <card id>" in the LAST paragraph of the message, in the same block as Co-Authored-By (no blank line between them), then re-commit. Check: git log -1 "--format=%(trailers:key=Board-Id,valueonly)"`);
    process.exit(1);
  }
}
