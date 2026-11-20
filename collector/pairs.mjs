// #C1020: the deploy pairs in the owner's pair folder, read for the probe (collector/state.mjs) and the dispatch (collector/pair-wait.mjs). Pinned
// probe code imports this file, so it imports nothing of ours: a new import here would re-pin it (tests/release.test.mjs). Read-only, no network.
// A pair is the files scripts/make-pair.mjs writes: board-store-deploy-pc<n>.mjs holding `const SIGNED = "<40 hex>"`, and board-store-deploy-pc<n>.done
// once the deploy step ran (holding the same sha).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The repo words of a card of the board's own repository that gets a deploy pair when it lands (the live board has both: "flight-board" and "board").
export const BOARD_REPO_WORDS = new Set(["flight-board", "board"]);
// #C1166 (2): one reading of "is this the board's own repository", for the probe, the dispatch and (as a copy in worker/board-rules.mjs, which imports
// nothing of the collector; tests/small-duplicate-readings.test.mjs holds the two equal). A word is read as one repository's name, not as typed (#C1145):
// case, spaces, an `<owner>/` front and a `.git` end do not make another repository.
export const repoKey = (r) => (typeof r === "string" ? r.trim().toLowerCase().replace(/^.*\//, "").replace(/\.git$/, "") : "");
// A repo WORD that names the board's own repository (a card with no word is unknown here: the pair step needs the word, the probe writes it, #C742).
export const isBoardRepo = (word) => BOARD_REPO_WORDS.has(repoKey(word));
// A CARD of the board's own repository: no repo word at all, or one that names it. Stack mode, the dependency checks and the reviewer key ask this.
export const isBoardCard = (card) => !card?.repo || isBoardRepo(card.repo);

// Whether the commit `landing` is the pair's pin or an ancestor of it (the pin descends from the landing). git(args) -> { status }; an answer it cannot give is false.
export function descends(git, landing, pin) {
  if (!/^[0-9a-f]{40}$/.test(landing ?? "") || !/^[0-9a-f]{40}$/.test(pin ?? "")) return false;
  if (landing === pin) return true;
  try { return git(["merge-base", "--is-ancestor", landing, pin]).status === 0; } catch { return false; }
}

// Every pair in the folder, newest first: [{ n, sha, ran }]. A deploy file with no pin is no pair; ran is true when its .done marker holds the pair's
// own pin (the deploy step writes it), so a stray or empty marker is no install. No folder, or an unreadable one: none.
export const MAX_PAIRS = 200;
export function pairsIn(folder) {
  if (typeof folder !== "string" || !folder || !existsSync(folder)) return [];
  let names;
  try { names = readdirSync(folder); } catch { return []; }
  const nums = names.map((f) => /^board-store-deploy-pc(\d{1,6})\.mjs$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => b - a).slice(0, MAX_PAIRS);
  const out = [];
  for (const n of nums) {
    let sha;
    try { sha = /const SIGNED = "([0-9a-f]{40})"/.exec(readFileSync(join(folder, `board-store-deploy-pc${n}.mjs`), "utf8"))?.[1]; } catch { continue; }
    if (!sha) continue;
    let ran = false;
    try { ran = names.includes(`board-store-deploy-pc${n}.done`) && readFileSync(join(folder, `board-store-deploy-pc${n}.done`), "utf8").trim() === sha; } catch { /* not run */ }
    out.push({ n, sha, ran });
  }
  return out;
}

// What the pairs show for a landed board card's commit: packed when a pair's pin is the landing or descends from it (a pair built from a main that
// holds the card), installed when such a pair ran (its .done holds the pin). A pair below the landing shows nothing. Only the files and git decide:
// nothing a card or a note says is read. Security's SAFE is not read (Manager's pick A on #C1020): packed means built, not signed. Each pin is asked
// once per landing. #C1034 (Checker 2's LOW on #C1020): pins are main commits and pairs come newest first, so once a pin does not hold the landing
// no older pin does: the walk stops there. A landed card no pair holds yet costs one git question, not one per pair.
// #C1309 (the owner, t-1795149842663): `pack` is the number of the OLDEST pair that holds the landing, the pack the card first rode in ("pc111"), so the Install
// tile can name it. Pins are main commits and pairs come newest first, so the pairs that hold the landing are a prefix of the list: the oldest one is found by a
// galloping search from the newest pair (1, 2, 4, ... pairs back, then a binary search inside the last gap: a landing a pack or two old costs two git questions, an old
// one stays logarithmic in the pairs, never one per pair), and the card is installed when any pair in that prefix ran.
export function packOf(pairs, landing, git) {
  const out = { packed: false, installed: false };
  if (!/^[0-9a-f]{40}$/.test(String(landing ?? "")) || !Array.isArray(pairs) || !pairs.length) return out;
  const asked = new Map();
  const holds = (p) => { if (!asked.has(p.sha)) asked.set(p.sha, descends(git, landing, p.sha)); return asked.get(p.sha); };
  if (!holds(pairs[0])) return out;
  let lo = 0, hi, step = 1; // pairs[lo] holds the landing; find the last index that does
  for (;;) {
    const j = lo + step;
    if (j >= pairs.length) { hi = pairs.length - 1; break; }
    if (holds(pairs[j])) { lo = j; step *= 2; } else { hi = j - 1; break; }
  }
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (holds(pairs[mid])) lo = mid; else hi = mid - 1; }
  out.packed = true;
  if (Number.isInteger(pairs[lo].n) && pairs[lo].n > 0 && pairs[lo].n < 1e6) out.pack = pairs[lo].n;
  out.installed = pairs.slice(0, lo + 1).some((p) => p.ran);
  return out;
}
