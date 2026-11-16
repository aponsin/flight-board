// #C1114 part 1, the probe's half: the findings on every commit of the branch (not only the tip's) are counted by kind into the card's issueCounts, so a fix
// commit with no note on it does not make the first round vanish, and a second round adds. Real git; fictional repository and names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-counters-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const commit = (name, msg, t, first) => { if (first) g(["checkout", "-qb", name]); else g(["checkout", "-q", name]); at = T0 + t; appendFileSync(join(work, `${name}.md`), "x\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); const sha = g(["rev-parse", "HEAD"]).trim(); g(["checkout", "-q", "main"]); return sha; };
  const note = (sha, who, text, t) => { at = T0 + t; g(["notes", `--ref=${NOTES[who]}`, "add", "-f", "-m", text, sha]); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["push", "-q", "-f", "origin", "refs/notes/*:refs/notes/*"]); g(["fetch", "-q", "--prune", "origin"]); };
  const tips = (name, sha, t, msg) => [{ branch: "main", sha: "x", at: T0, message: "" }, { branch: `origin/${name}`, sha, at: (T0 + t) * 1000, message: msg }];
  const repo = (extra = {}) => ({ git: (args) => g(args), remote: "origin", main: "main", notes: NOTES, live: null, versionPattern: null, tips: [], ...extra });
  return { commit, note, sync, tips, repo };
}
const fits = (id, st) => stateErrors({ v: 1, board: { boardId: "b", at: T0 * 1000, probe: null, pageVersion: null }, cards: { [id]: st }, agents: {} });
const read = (s, id, sha, t, msg) => cardState({ id, num: 820, level: "Full", phase: "plan" }, s.repo({ tips: s.tips(id, sha, t, msg) }), cfg, T0 * 1000);

test("a FINDINGS note with 2 items gives bugs 2, Security's RISKS gives security, and the fix commit keeps the count while a second round adds to it", () => {
  const s = scratch();
  const msg = "Work\n\nBoard-Id: card-c";
  const sha = s.commit("card-c", msg, 10, true);
  s.note(sha, "checker", "FINDINGS Full\nF1 LOW a.mjs:1 one\nF2 LOW b.mjs:2 two", 30);
  s.note(sha, "security", "RISKS Full\nR1 LOW c.mjs:3 one", 40); s.sync();
  const st = read(s, "card-c", sha, 10, msg);
  assert.deepEqual(st.issueCounts, { bugs: 2, security: 1 });
  assert.deepEqual(fits("card-c", st), []);
  // The fix: a new commit with no note. The first round is still counted (it is on the branch).
  const sha2 = s.commit("card-c", msg, 60, false); s.sync();
  assert.deepEqual(read(s, "card-c", sha2, 60, msg).issueCounts, { bugs: 2, security: 1 });
  // A second round on the new tip adds its own.
  s.note(sha2, "checker", "FINDINGS Full\nF1 MEDIUM d.mjs:4 again", 80); s.sync();
  assert.deepEqual(read(s, "card-c", sha2, 60, msg).issueCounts, { bugs: 3, security: 1 });
});

test("a PASS note, or no note, gives no issueCounts; reading the same notes twice gives the same counts", () => {
  const s = scratch();
  const msg = "Work\n\nBoard-Id: card-d";
  const sha = s.commit("card-d", msg, 10, true);
  s.note(sha, "checker", "PASS Full F1 fixed", 30); s.sync();
  assert.ok(!("issueCounts" in read(s, "card-d", sha, 10, msg)));
  s.note(sha, "security", "FINDINGS\nF1 LOW x", 40); s.sync();
  const a = read(s, "card-d", sha, 10, msg), b = read(s, "card-d", sha, 10, msg);
  assert.deepEqual(a.issueCounts, { security: 1 });
  assert.deepEqual(b.issueCounts, a.issueCounts);
});
