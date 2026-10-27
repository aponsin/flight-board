// #C358: a card whose own branch is on main and deployed reads live, though a later commit carrying its Board-Id sits on
// another card's branch stacked on top (#C353's Designer nit rode on #C354's branch; the collector read #C353 as ship,
// "2 branches, board-ctx-refresh is behind", and the gate wouldn't let the lead close it). That commit ships with the
// card whose branch it is on. A rework on a branch of no card's own (#C237's fix/… case) still holds the card back.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { collect, inRepo } from "../collector/collect.mjs";

const T0 = 1_790_000_000;
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "fb-stack-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  const commit = (t, file, msg) => { at = T0 + t; writeFileSync(join(work, file), msg + "\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  const sync = () => { g(["push", "-q", "--all", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  commit(0, "a.md", "start");
  return { dir, g, commit, sync, git: (args) => g(args) };
}
const cfg = (r) => fullConfig({ owner: "Sam", collector: { repoPath: r.dir, notes: { checker: "refs/notes/checker" }, deployWorkflow: "CI" } });
const deployedAt = (sha) => () => JSON.stringify([{ headSha: sha }]);
const card = (id) => ({ id, status: "active", level: "Quick" });

// card-a's branch, then card-b's branch stacked on it with card-b's work and then a follow-up for card-a on top; card-a's
// branch alone fast-forwards main and is deployed.
function stacked() {
  const r = repo();
  r.g(["checkout", "-qb", "board-a"]);
  const a = r.commit(10, "a.md", "a's work\n\nBoard-Id: board-a");
  r.g(["checkout", "-qb", "board-b"]);
  r.commit(20, "b.md", "b's work\n\nBoard-Id: board-b");
  const nit = r.commit(30, "a.md", "a follow-up for a, on b's branch\n\nBoard-Id: board-a");
  r.g(["checkout", "-q", "main"]); r.g(["merge", "-q", "--ff-only", "board-a"]);
  r.sync();
  return { r, a, nit };
}

test("the team's repository: a card's own branch on main and deployed reads live; the stacked follow-up rides with board-b", () => {
  const { r, a } = stacked();
  try {
    const { doc, conflicts } = collect({ config: cfg(r), cards: [card("board-a"), card("board-b")], git: r.git, gh: deployedAt(a), now: 1 });
    const d = doc.cards["board-a"];
    assert.equal(d.phase, "live", d.evidence);
    assert.equal(d.head, a);
    assert.match(d.evidence, /board-b carries a later commit for it: that ships with board-b's card/);
    assert.ok(!conflicts.some((l) => l.startsWith("board-a: 2 branches")), "no 'split the rework' line for a stacked follow-up");
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("another repository (collector.repos): the same, against what is installed", () => {
  const { r, a } = stacked();
  try {
    const config = fullConfig({ owner: "Sam", collector: { repos: [{ name: "board", path: r.dir, notes: { checker: "refs/notes/checker" }, idPrefixes: ["board-"] }] } });
    const repoCfg = config.collector.repos[0];
    const d = inRepo(card("board-a"), repoCfg, { git: r.git, installed: a }, config, 1, new Set(["board-a", "board-b"]));
    assert.equal(d.phase, "live", d.evidence);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("not live while its own branch isn't: a stacked follow-up only stops holding it back once the card's own branch is live", () => {
  const r = repo();
  try {
    r.g(["checkout", "-qb", "board-a"]);
    r.commit(10, "a.md", "a's work\n\nBoard-Id: board-a");
    r.g(["checkout", "-qb", "board-b"]);
    r.commit(30, "a.md", "a follow-up\n\nBoard-Id: board-a");
    r.g(["checkout", "-q", "main"]);
    r.sync();
    const main = r.g(["rev-parse", "main"]).trim();
    const d = collect({ config: cfg(r), cards: [card("board-a"), card("board-b")], git: r.git, gh: deployedAt(main), now: 1 }).doc.cards["board-a"];
    assert.notEqual(d.phase, "live");
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});
