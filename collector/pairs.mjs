// #C1020: the deploy pairs in the owner's pair folder, read for the probe (collector/state.mjs) and the dispatch (collector/pair-wait.mjs). Pinned
// probe code imports this file, so it imports nothing of ours: a new import here would re-pin it (tests/release.test.mjs). Read-only, no network.
// A pair is the files scripts/make-pair.mjs writes: board-store-deploy-pc<n>.mjs holding `const SIGNED = "<40 hex>"`, and board-store-deploy-pc<n>.done
// once the deploy step ran (holding the same sha).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The repo words of a card of the board's own repository that gets a deploy pair when it lands (the live board has both: "flight-board" and "board").
export const BOARD_REPO_WORDS = new Set(["flight-board", "board"]);

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
// once per landing.
export function packOf(pairs, landing, git) {
  const out = { packed: false, installed: false };
  if (!/^[0-9a-f]{40}$/.test(String(landing ?? "")) || !Array.isArray(pairs)) return out;
  const asked = new Map();
  for (const p of pairs) {
    if (out.installed) break;
    if (out.packed && !p.ran) continue;
    if (!asked.has(p.sha)) asked.set(p.sha, descends(git, landing, p.sha));
    if (!asked.get(p.sha)) continue;
    out.packed = true;
    if (p.ran) out.installed = true;
  }
  return out;
}
