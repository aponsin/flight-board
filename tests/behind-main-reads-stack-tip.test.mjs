// #C1207 (11-18: the watch sent the builder "signed but behind main, re-cut on main" for two lower cards of a stack whose tip, fully signed, already had main merged in; a re-cut would have cost
// every signature): a lower card of a stack is never behind main by its own commit. The stack's tip carries the question, once: it is behind main only when the tip itself lacks main.
// A lone card behind main is re-cut as before. Real git.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState, remoteTips } from "../collector/state.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });
const NOW = (T0 + 1000) * 1000;
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-stacktip-"));
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
const lower = { id: "c1-lower", num: 1, level: "Quick" }, top = { id: "c2-top", num: 2, level: "Quick" };
const headOf = (sha, id) => ({ branch: "build/stack", sha, at: (T0 + 10) * 1000, message: `Work\n\nBoard-Id: ${id}` });

// A stack of two cards on one branch, both signed; main moves on after it was cut.
function stack({ mergeMain }) {
  const s = scratch();
  s.g(["checkout", "-qb", "build/stack"]);
  const a = s.commit(10, "a.md", "Work\n\nBoard-Id: c1-lower");
  const b = s.commit(20, "b.md", "Work\n\nBoard-Id: c2-top");
  s.g(["checkout", "-q", "main"]);
  s.commit(30, "m.md", "main moves on");
  let tip = b;
  if (mergeMain) { s.g(["checkout", "-q", "build/stack"]); s.set(40); s.g(["merge", "-q", "--no-ff", "-m", "Merge main\n\nBoard-Id: c2-top", "main"]); tip = s.g(["rev-parse", "HEAD"]).trim(); s.g(["checkout", "-q", "main"]); }
  s.sign(a); s.sign(b); if (tip !== b) s.sign(tip);
  s.sync();
  return { s, a, b, tip };
}

test("a lower card of a stack whose tip has main is not behind main: no re-cut", () => {
  const { s, a, tip } = stack({ mergeMain: true });
  const one = cardState(lower, s.repo(), cfg, NOW, { head: headOf(a, "c1-lower"), cover: tip });
  assert.equal(one.phase, "ship", JSON.stringify(one));
  assert.equal(one.behindMain, undefined);
  const two = cardState(top, s.repo(), cfg, NOW, { cover: tip });
  assert.equal(two.behindMain, undefined);
});

test("a stack whose tip is behind main is re-cut once, for the tip: the lower card is not named, the tip card is", () => {
  const { s, a, b } = stack({ mergeMain: false });
  const one = cardState(lower, s.repo(), cfg, NOW, { head: headOf(a, "c1-lower"), cover: b });
  assert.equal(one.behindMain, undefined, "the lower card carries no re-cut of its own");
  const two = cardState(top, s.repo(), cfg, NOW, { cover: b });
  assert.equal(two.phase, "ship", JSON.stringify(two));
  assert.equal(two.behindMain, true);
});

test("must still hold: a lone card (no stack) signed and behind main is re-cut", () => {
  const s = scratch();
  s.g(["checkout", "-qb", "build/c1-lower"]);
  const own = s.commit(10, "a.md", "Work\n\nBoard-Id: c1-lower");
  s.sign(own);
  s.g(["checkout", "-q", "main"]);
  s.commit(30, "m.md", "main moves on");
  s.sync();
  const r = cardState(lower, s.repo(), cfg, NOW);
  assert.equal(r.phase, "ship");
  assert.equal(r.behindMain, true);
});
