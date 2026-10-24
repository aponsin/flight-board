// The content scan, run by the pre-push hook (.githooks/pre-push): nothing about the team that uses this board may enter
// the repository. It checks every tracked file for
//   - the words in the team's private list (one per line, case-insensitive; the list lives outside the repository, at the
//     path in `git config flightboard.scanwords` or $FLIGHT_BOARD_SCAN_WORDS; without one the scan refuses, fail closed);
//   - an artifact link, an email address not at example.com/.org/.net (no-reply ones pass), a phone number not on 555 (also written as
//     +13035550100 digits), a token-like secret.
// What is scanned is what leaves: in the pre-push hook (--pre-push, the refs on stdin), every file each pushed commit adds
// or changes, and each commit's message, so a word committed and removed in the same push is still caught. Run by hand
// (no flag), it scans HEAD's files and every commit no remote has yet. A hook can be skipped (git push --no-verify):
// the scan is a guard, not a guarantee.
// --all scans every commit the repository has ever had (run it before making the repository public).
// Usage: node scripts/scan.mjs [--pre-push | --all]   (exit 1 with one line per hit)
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PATTERNS = [
  ["an artifact link", /claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]{6,}/g],
  ["an email address", /(?<![A-Za-z0-9._%+-])(?!no-?reply@)[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b|users\.noreply\.github\.com\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  ["a phone number", /(?<![\d.])\(?\d{3}\)?[-. ](?!555)\d{3}[-. ]\d{4}(?!\d)/g],
  ["a phone number", /(?<![\d.])\+?1?\d{3}(?!555)\d{7}(?![\d.])/g],
  ["a token", /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|re_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{40,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g],
];

// Hits in one file's text: [{ line, what }]. words: the private list, already lower case.
export function scanText(text, words) {
  const hits = [];
  text.split("\n").forEach((line, n) => {
    const low = line.toLowerCase();
    for (const w of words) if (w && low.includes(w)) hits.push({ line: n + 1, what: `a listed word ("${w}")` });
    for (const [what, re] of PATTERNS) if (line.match(re)) hits.push({ line: n + 1, what });
  });
  return hits;
}

export function readWords(path) {
  return readFileSync(path, "utf8").split("\n").map((w) => w.trim().toLowerCase()).filter((w) => w && !w.startsWith("#"));
}

// What a push sends: the commits each pushed ref adds ("<local ref> <local sha> <remote ref> <remote sha>" lines on stdin).
export function pushedCommits(stdin, git) {
  const zero = /^0+$/;
  const out = new Set();
  for (const line of String(stdin).split("\n")) {
    const [, local, , remote] = line.trim().split(/\s+/);
    if (!local || zero.test(local)) continue; // a deleted ref sends nothing
    const range = !remote || zero.test(remote) ? [local, "--not", "--remotes"] : [`${remote}..${local}`];
    for (const c of git(["rev-list", ...range]).split("\n").filter(Boolean)) out.add(c);
  }
  return [...out];
}

// Hits in one commit: every file it adds or changes (text only), and its message. [{ where, line, what }]
export function scanCommit(commit, words, git) {
  const hits = [];
  const paths = git(["diff-tree", "-r", "--root", "--no-commit-id", "--name-only", "--diff-filter=ACMRT", "-z", commit]).split("\0").filter(Boolean);
  for (const path of paths) {
    const text = git(["cat-file", "blob", `${commit}:${path}`]);
    if (text.includes("\0")) continue;
    for (const h of scanText(text, words)) hits.push({ where: `${commit.slice(0, 8)}:${path}`, ...h });
  }
  for (const h of scanText(git(["log", "-1", "--format=%B", commit]), words)) hits.push({ where: `${commit.slice(0, 8)} (message)`, ...h });
  return hits;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let list = process.env.FLIGHT_BOARD_SCAN_WORDS;
  if (!list) try { list = git(["config", "flightboard.scanwords"]).trim(); } catch { list = ""; }
  if (!list || !existsSync(list)) {
    console.error("Scan refused: no private word list. Run: git config flightboard.scanwords /path/outside/the/repo/words.txt");
    process.exit(1);
  }
  const words = readWords(list);
  if (!words.length) { console.error(`Scan refused: the word list at ${list} has no words.`); process.exit(1); }
  const hits = [];
  let what;
  if (process.argv.includes("--pre-push")) {
    const commits = pushedCommits(readFileSync(0, "utf8"), git);
    for (const c of commits) hits.push(...scanCommit(c, words, git));
    what = `${commits.length} pushed commit(s)`;
  } else if (process.argv.includes("--all")) {
    // Before the repository goes public: every commit it has ever had.
    const commits = git(["rev-list", "--all"]).split("\n").filter(Boolean);
    for (const c of commits) hits.push(...scanCommit(c, words, git));
    what = `all ${commits.length} commit(s)`;
  } else {
    const files = git(["ls-tree", "-r", "-z", "--name-only", "HEAD"]).split("\0").filter(Boolean);
    for (const f of files) {
      const text = git(["cat-file", "blob", `HEAD:${f}`]);
      if (!text.includes("\0")) for (const h of scanText(text, words)) hits.push({ where: f, ...h });
    }
    const unpushed = git(["rev-list", "HEAD", "--not", "--remotes"]).split("\n").filter(Boolean);
    for (const c of unpushed) hits.push(...scanCommit(c, words, git));
    what = `HEAD's ${files.length} files and ${unpushed.length} unpushed commit(s)`;
  }
  for (const h of hits) console.error(`${h.where}:${h.line}: ${h.what}`);
  if (hits.length) { console.error(`Scan: ${hits.length} hit(s). Nothing pushed. Remove them (a commit in the push still holds them), or fix the list if a word is a false alarm.`); process.exit(1); }
  console.log(`Scan: ${what} clean.`);
}
