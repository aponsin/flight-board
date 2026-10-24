// The content scan, run by the pre-push hook (.githooks/pre-push): nothing about the team that uses this board may enter
// the repository. It checks every tracked file for
//   - the words in the team's private list (one per line, case-insensitive; the list lives outside the repository, at the
//     path in `git config flightboard.scanwords` or $FLIGHT_BOARD_SCAN_WORDS; without one the scan refuses, fail closed);
//   - an artifact link, an email address not at example.com/.org/.net, a phone number not on 555, a token-like secret.
// Usage: node scripts/scan.mjs   (exit 1 with one line per hit)
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PATTERNS = [
  ["an artifact link", /claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]{6,}/g],
  ["an email address", /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  ["a phone number", /(?<![\d.])\(?\d{3}\)?[-. ](?!555)\d{3}[-. ]\d{4}(?!\d)/g],
  ["a token", /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g],
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let list = process.env.FLIGHT_BOARD_SCAN_WORDS;
  if (!list) try { list = execFileSync("git", ["config", "flightboard.scanwords"], { encoding: "utf8" }).trim(); } catch { list = ""; }
  if (!list || !existsSync(list)) {
    console.error("Scan refused: no private word list. Run: git config flightboard.scanwords /path/outside/the/repo/words.txt");
    process.exit(1);
  }
  const words = readWords(list);
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  let found = 0;
  for (const f of files) {
    if (!existsSync(f)) continue;
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const h of scanText(text, words)) { console.error(`${f}:${h.line}: ${h.what}`); found++; }
  }
  if (found) { console.error(`Scan: ${found} hit(s). Nothing pushed. Remove them, or fix the list if a word is a false alarm.`); process.exit(1); }
  console.log(`Scan: ${files.length} tracked files clean.`);
}
