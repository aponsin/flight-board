// #C567: "live" is read from origin/main, never the checkout's own main branch. A checkout whose local main is days
// behind (nobody pulled it) must give the same answer as a fresh one. Fictional repo.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { collect } from "../collector/collect.mjs";

const T0 = 1_790_000_000;
const cfg = (dir) => fullConfig({ owner: "Sam", collector: { repoPath: dir, notes: { checker: "refs/notes/checker" }, deployWorkflow: "CI" } });

test("a stale local main with a fresh origin/main reads the card live; the local main is not what is asked", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-stale-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  try {
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
    const commit = (t, msg) => { at = T0 + t; writeFileSync(join(work, "a.md"), msg + "\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
    const start = commit(0, "start");
    g(["checkout", "-qb", "board-a"]);
    const a = commit(10, "a's work\n\nBoard-Id: board-a");
    // origin/main moves to the card's commit and is fetched; the checkout's own main stays where it was.
    g(["push", "-q", "origin", "board-a:main", "board-a"]);
    g(["fetch", "-q", "--prune", "origin"]);
    assert.equal(g(["rev-parse", "main"]).trim(), start, "the local main is behind");
    assert.equal(g(["rev-parse", "origin/main"]).trim(), a);
    const d = collect({ config: cfg(dir), cards: [{ id: "board-a", status: "active", level: "Quick" }], git: g, gh: () => JSON.stringify([{ headSha: a }]), now: 1 }).doc.cards["board-a"];
    assert.equal(d.phase, "live", d.evidence);
    assert.equal(d.head, a);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
