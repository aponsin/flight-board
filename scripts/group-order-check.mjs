// #C1103 (the owner, 2026-11-16: Boardsmith worked g13 while g3, g10 and g6 waited, because Manager sent the work by hand). Run by the pre-push hook
// (.githooks/pre-push) after the scan and the trailer check: the FIRST push of a build/ branch (the remote has no such branch yet, which is what starts a card on the
// board) is refused when its card's group sits below a group that has an open card of the same role waiting for that role (groupOrderBlock, worker/board-rules.mjs,
// the same rule the store's "being worked out of order" line uses). The order is the owner's: a group he moved up is simply first. Read from the dispatch job's
// <stateDir>/<board>/stack-queue.json (config: $BOARD_CONFIG, as stack-ready), and only when that file is fresh: no config, no file, a stale one, a card the queue
// does not list or a push with no Board-Id checks nothing (never a deadlock). A guard, not a guarantee: git push --no-verify skips it, and the store names the work anyway.
// Usage: node scripts/group-order-check.mjs <remote>   (the refs on stdin; exit 1 with one line per refused branch)
import { realpathSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { groupOrderBlock } from "../worker/board-rules.mjs";
import { readQueue, findConfigPath, QUEUE_FRESH_MS } from "./stack-ready.mjs";

const ZERO = /^0+$/;
// The refused first pushes: [{ ref, id, num, group, role, block: { id, num, group } }]. git(args) -> stdout. queue: the parsed stack-queue.json or null.
export function outOfOrderPushes(stdin, git, queue, now = Date.now()) {
  if (!queue || !Array.isArray(queue.cards) || !Number.isFinite(queue.at) || queue.at > now + 60e3 || now - queue.at > QUEUE_FRESH_MS) return [];
  const cards = queue.cards.filter((c) => c && typeof c.id === "string").map((c) => ({ id: c.id, num: c.num, owner_role: c.owner_role, group: c.batch, held: !!c.held, turn: c.turn === true }));
  const out = [];
  for (const line of String(stdin).split("\n")) {
    const [, local, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (!local || ZERO.test(local) || !/^refs\/heads\/build\//.test(remoteRef ?? "") || !ZERO.test(remoteSha ?? "")) continue;
    let id = null;
    try { id = git(["log", "-1", "--format=%(trailers:key=Board-Id,valueonly)", local]).split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? null; } catch { continue; }
    const mine = cards.find((c) => c.id === id);
    if (!mine) continue;
    const block = groupOrderBlock(mine, cards, Array.isArray(queue.groups) ? queue.groups : []);
    if (block) out.push({ ref: remoteRef, id, num: mine.num, group: mine.group, role: mine.owner_role, block });
  }
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  const queue = await readQueue({ configPath: findConfigPath({ args: [], env: process.env }) });
  const bad = outOfOrderPushes(readFileSync(0, "utf8"), git, queue);
  for (const b of bad) console.error(`${b.ref.replace("refs/heads/", "")}: #C${b.num} is in ${b.group || "no group"}, and #C${b.block.num} of ${b.block.group}, a higher group, is waiting for ${b.role}`);
  if (bad.length) {
    console.error("Group order: nothing pushed. Start the higher card first, or ask the owner to move this card's group up (the order is his). To push anyway: git push --no-verify.");
    process.exit(1);
  }
}
