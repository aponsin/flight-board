// #C1209 (Checker 2's LOW on #C1207): a stack whose tip commit carries no card's Board-Id (a fix-up commit) and lacks main got no re-cut nudge at all, because the nudge went only to the card
// that owns the tip. With no card at the tip, the stack's topmost card carries it, once, asked of the stack's tip. Real git.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardStates, remoteTips } from "../collector/state.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });
const NOW = (T0 + 1000) * 1000;
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-untagged-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const commit = (t, file, msg) => { at = T0 + t; appendFileSync(join(work, file), `${t}\n`); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  const repo = () => ({ git: (a) => g(a), remote: "origin", main: "main", notes: NOTES, tips: remoteTips((a) => g(a), "origin"), live: null, versionPattern: null });
  const sign = (sha) => { for (const ref of Object.values(NOTES)) g(["notes", `--ref=${ref}`, "add", "-m", "PASS", sha]); };
  return { g, commit, sync, repo, sign, set: (t) => { at = T0 + t; } };
}
const cards = [{ id: "c1-lower", num: 1, level: "Quick" }, { id: "c2-top", num: 2, level: "Quick" }];
const read = (s) => cardStates({ cards, config: cfg, repos: { "": s.repo() }, now: NOW, stacks: [""] });

// Two cards on one branch, a third untagged commit on top (the stack tip), all signed; main moves on after the cut.
function stack({ tipHasMain, tagged = false }) {
  const s = scratch();
  s.g(["checkout", "-qb", "build/stack"]);
  const a = s.commit(10, "a.md", "Work\n\nBoard-Id: c1-lower");
  const b = s.commit(20, "b.md", "Work\n\nBoard-Id: c2-top");
  s.g(["checkout", "-q", "main"]);
  s.commit(30, "m.md", "main moves on");
  s.g(["checkout", "-q", "build/stack"]);
  let tip;
  if (tipHasMain) { s.set(40); s.g(["merge", "-q", "--no-ff", "-m", tagged ? "Merge main\n\nBoard-Id: c2-top" : "Merge main", "main"]); tip = s.g(["rev-parse", "HEAD"]).trim(); }
  else tip = s.commit(40, "fix.md", tagged ? "Fix\n\nBoard-Id: c2-top" : "Fix-up with no card");
  s.g(["checkout", "-q", "main"]);
  for (const x of [a, b, tip]) s.sign(x);
  s.sync();
  return s;
}

test("an untagged tip behind main nudges the top card once, and the lower card not at all", () => {
  const out = read(stack({ tipHasMain: false }));
  assert.equal(out["c2-top"].phase, "ship", JSON.stringify(out["c2-top"]));
  assert.equal(out["c2-top"].behindMain, true);
  assert.equal(out["c1-lower"].behindMain, undefined);
});

test("a tagged tip behind main still nudges its own card, and only it", () => {
  const out = read(stack({ tipHasMain: false, tagged: true }));
  assert.equal(out["c2-top"].behindMain, true);
  assert.equal(out["c1-lower"].behindMain, undefined);
});

test("an untagged tip that has main nudges nobody, though the top card's own commit lacks main", () => {
  const out = read(stack({ tipHasMain: true }));
  assert.equal(out["c2-top"].behindMain, undefined);
  assert.equal(out["c1-lower"].behindMain, undefined);
});
