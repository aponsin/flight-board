// #C1357 (11-20 ~9 am MT: the dispatch told Steward that #C1349 (build/queue-css-own-file-v2 at 07733e48) was "outside the stack" and must be re-cut on the group head's tip,
// but that head already merges 07733e48; a re-cut would have voided three signatures for nothing): a card whose commit the stack head holds through a MERGE is inside the stack.
// A card neither under nor merged into the head is still outside, and a fold card stays alone (#C1337). Real git: the merge is a merge commit.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardStates, remoteTips } from "../collector/state.mjs";

const T0 = 1_790_000_000;
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, deployWorkflow: "CI" } });
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-merged-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const commit = (t, file, id) => { at = T0 + t; appendFileSync(join(work, file), `${t}\n`); g(["add", "-A"]); g(["commit", "-qm", `Work on ${id}\n\nBoard-Id: ${id}`]); return g(["rev-parse", "HEAD"]).trim(); };
  const merge = (t, branch) => { at = T0 + t; g(["merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch]); return g(["rev-parse", "HEAD"]).trim(); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  const repo = () => ({ git: (args) => g(args), remote: "origin", main: "main", notes: cfg.collector.notes, tips: remoteTips((a) => g(a), "origin"), live: null, versionPattern: null });
  return { g, commit, merge, sync, repo };
}
const run = (s, ids) => cardStates({ cards: ids.map((id) => ({ id })), config: cfg, repos: { "": s.repo() }, now: (T0 + 1000) * 1000, stacks: [""] });

// The group head (build/group) holds g-one and g-two by its own commits and `merged` by a merge commit; `merged` has its own branch, cut from main.
function world(extra = () => {}) {
  const s = scratch();
  s.g(["checkout", "-qb", "build/merged"]);
  const mergedSha = s.commit(5, "m.md", "merged");
  s.g(["checkout", "-q", "main"]); s.g(["checkout", "-qb", "build/group"]);
  s.commit(10, "a.md", "g-one"); s.commit(20, "b.md", "g-two");
  s.merge(30, "build/merged");
  extra(s);
  s.g(["checkout", "-q", "main"]);
  s.sync();
  return { s, mergedSha };
}

test("a card the group head merges through a merge commit is inside the stack, not told to re-cut", () => {
  const { s, mergedSha } = world();
  const on = run(s, ["g-one", "g-two", "merged"]);
  assert.equal(on.merged.stack?.outside, undefined, JSON.stringify(on.merged.stack));
  assert.equal(on.merged.stack?.size, 3);
  assert.equal(on.merged.headSha12, mergedSha.slice(0, 12));
});

test("must still refuse: a card neither under nor merged into the head is outside the stack", () => {
  const { s } = world((w) => { w.g(["checkout", "-q", "main"]); w.g(["checkout", "-qb", "build/loose"]); w.commit(40, "z.md", "loose"); });
  assert.deepEqual(run(s, ["g-one", "g-two", "merged", "loose"]).loose.stack, { outside: true, branch: "build/group" });
});

test("must still allow: a fold card in its own group is never outside (#C1337)", () => {
  const { s } = world((w) => { w.g(["checkout", "-q", "main"]); w.g(["checkout", "-qb", "build/fold-data-fragments-x"]); w.commit(40, "f.md", "fold-data-fragments-x"); });
  assert.equal(run(s, ["g-one", "g-two", "merged", "fold-data-fragments-x"])["fold-data-fragments-x"].stack, undefined);
});
