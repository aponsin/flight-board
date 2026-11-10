// A card whose branch is gone (merged, then deleted) is read by the probe from the commit on main that carries its Board-Id trailer
// (#C725). Without it the store's board showed #C722 stalled and #C724 queued although both were signed and live: the probe had no
// head, and the Collector's reading that used to stand in for it is not in the store. Real git; fictional repository and names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState, trailerHead } from "../collector/state.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-trailer-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const commit = (t, file, msg) => { at = T0 + t; appendFileSync(join(work, file), `${t}\n`); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  // A card's work on a branch, signed, merged to main with --no-ff, and the branch deleted: only the trailer is left to find it by.
  const shipBranch = (name, trailerId) => {
    g(["checkout", "-qb", name]);
    const sha = commit(10, `${name}.md`, `Work for ${name}\n\nBoard-Id: ${trailerId}`);
    for (const ref of Object.values(NOTES)) g(["notes", `--ref=${ref}`, "add", "-m", "PASS", sha]);
    g(["checkout", "-q", "main"]); at = T0 + 20; g(["merge", "-q", "--no-ff", "-m", `v1.0.0: ${name}`, name]); g(["branch", "-qD", name]);
    return sha;
  };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  const repo = (extra = {}) => ({ git: (args) => g(args), remote: "origin", main: "main", notes: NOTES, tips: [{ branch: "main", sha: "x", at: T0, message: "" }], live: null, versionPattern: null, ...extra });
  return { g, shipBranch, sync, repo, mainSha: () => g(["rev-parse", "main"]).trim() };
}

test("a signed card whose branch is gone is read from its trailer on main: signed, on main, and live once main is deployed", () => {
  const s = scratch();
  const sha = s.shipBranch("portfolio-add-photo", "portfolio-add-photo");
  s.sync();
  const notDeployed = cardState({ id: "portfolio-add-photo", num: 722, level: "Full", phase: "plan" }, s.repo(), cfg, T0 * 1000);
  assert.equal(notDeployed.headSha12, sha.slice(0, 12)); assert.equal(notDeployed.onMain, true); assert.deepEqual(notDeployed.signed, ["checker", "security"]);
  assert.notEqual(notDeployed.phase, "live", "not deployed yet");
  const live = cardState({ id: "portfolio-add-photo", num: 722, level: "Full", phase: "plan" }, s.repo({ live: s.mainSha() }), cfg, T0 * 1000);
  assert.equal(live.phase, "live"); assert.ok(live.seen.includes("security") && live.seen.includes("live"), `seen: ${live.seen}`);
});

test("a card with no branch and no trailer stays as declared; another card's id that only starts the same is not a match", () => {
  const s = scratch();
  s.shipBranch("dark-red-contrast-2", "dark-red-contrast-2");
  s.sync();
  const none = cardState({ id: "dark-red-contrast", num: 724, phase: "plan" }, s.repo(), cfg, T0 * 1000);
  assert.equal(none.headSha12, null); assert.equal(none.onMain, false); assert.equal(none.phase, "plan");
  assert.equal(trailerHead(s.repo(), "dark-red-contrast"), null);
  assert.ok(trailerHead(s.repo(), "dark-red-contrast-2"));
});

test("the id goes to git as a fixed string: a regex or an option in an id finds nothing and runs nothing", () => {
  const s = scratch();
  s.shipBranch("fix-it", "fix-it");
  s.sync();
  for (const id of ["fix-.*", "--all", ".*", "fix-it\nBoard-Id: other"]) assert.equal(trailerHead(s.repo(), id), null, JSON.stringify(id));
  let args;
  assert.equal(trailerHead({ remote: "origin", main: "main", git: (a) => { args = a; throw new Error("git down"); } }, "x"), null, "a git failure reads as nothing");
  assert.ok(args.includes("--fixed-strings"));
});

// Security's three surviving mutations on v3: each of these fails when the code it guards is loosened.
test('only a whole Board-Id line counts: the id mid-line, or after other letters, finds no head', () => {
  const s = scratch();
  s.g(['commit', '--allow-empty', '-qm', 'Notes\n\nsee Board-Id: ctx-card for context']);
  s.g(['commit', '--allow-empty', '-qm', 'Other\n\nxBoard-Id: ctx-card']);
  s.sync();
  assert.equal(trailerHead(s.repo(), 'ctx-card'), null);
  s.g(['commit', '--allow-empty', '-qm', 'Real\n\nBoard-Id: ctx-card']);
  s.sync();
  assert.ok(trailerHead(s.repo(), 'ctx-card'), 'the whole line is found');
});

test('a card that still has a branch tip is read from the tip, not from a trailer commit on main', () => {
  const s = scratch();
  s.shipBranch('card-b', 'card-b');
  s.g(['checkout', '-qb', 'card-b-rework']);
  const tipSha = (() => { s.g(['commit', '--allow-empty', '-qm', 'More work\n\nBoard-Id: card-b']); return s.g(['rev-parse', 'HEAD']).trim(); })();
  s.g(['checkout', '-q', 'main']);
  s.sync();
  const repo = s.repo({ tips: [{ branch: 'main', sha: 'x', at: T0, message: '' }, { branch: 'origin/card-b-rework', sha: tipSha, at: T0 + 30, message: 'More work\n\nBoard-Id: card-b' }] });
  const st = cardState({ id: 'card-b', num: 730, level: 'Full', phase: 'plan' }, repo, cfg, T0 * 1000);
  assert.equal(st.headSha12, tipSha.slice(0, 12), 'the branch tip wins');
});

test('a sha field that is not 40 hex characters gives no head', () => {
  const git = () => 'not-a-sha\x1f123\x1fBoard-Id: bad-sha\n\x1e';
  assert.equal(trailerHead({ remote: 'origin', main: 'main', git }, 'bad-sha'), null);
  const ok = () => 'a'.repeat(40) + '\x1f123\x1fBoard-Id: bad-sha\n\x1e';
  assert.ok(trailerHead({ remote: 'origin', main: 'main', git: ok }, 'bad-sha'));
});
