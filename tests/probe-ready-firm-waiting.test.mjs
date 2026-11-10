// #C731 B4b: the probe reads what derive.mjs gave the old page for a card's ETA and review lines: readyAt (the READY commit's time),
// firm (false while the card has only a head, no trailer or sign-off) and waitingFor (the reviews still unsigned on the tip), and the
// store's compat view passes them to derived/all. Real git; fictional repository and names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";
import { derivedDoc } from "../worker/compat-view.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-ready-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const branch = (name, msg, t) => { g(["checkout", "-qb", name]); at = T0 + t; appendFileSync(join(work, `${name}.md`), "x\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); const sha = g(["rev-parse", "HEAD"]).trim(); g(["checkout", "-q", "main"]); return sha; };
  const sign = (sha, who) => g(["notes", `--ref=${NOTES[who]}`, "add", "-m", "PASS", sha]);
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["push", "-q", "origin", "refs/notes/*:refs/notes/*"]); g(["fetch", "-q", "--prune", "origin"]); };
  const tipsOf = (name, sha, t, msg) => [{ branch: "main", sha: "x", at: T0, message: "" }, { branch: `origin/${name}`, sha, at: (T0 + t) * 1000, message: msg }];
  const repo = (extra = {}) => ({ git: (args) => g(args), remote: "origin", main: "main", notes: NOTES, live: null, versionPattern: null, ...extra });
  return { g, branch, sign, sync, tipsOf, repo };
}

test("a branch with a head but no trailer or sign-off is not firm and has no readyAt", () => {
  const s = scratch();
  const sha = s.branch("card-a", "Some work", 10); s.sync();
  const st = cardState({ id: "card-a", num: 731, level: "Full", phase: "plan" }, s.repo({ tips: s.tipsOf("card-a", sha, 10, "Some work") }), cfg, T0 * 1000);
  assert.equal(st.phase, "build"); assert.equal(st.firm, false);
  assert.ok(!("readyAt" in st) && !("waitingFor" in st));
});

test("a READY tip with one review signed has readyAt and waits for the other", () => {
  const s = scratch();
  const msg = "Work\n\nBoard-Id: card-b";
  const sha = s.branch("card-b", msg, 10); s.sign(sha, "checker"); s.sync();
  const st = cardState({ id: "card-b", num: 732, level: "Full", phase: "plan" }, s.repo({ tips: s.tipsOf("card-b", sha, 10, msg) }), cfg, T0 * 1000);
  assert.equal(st.phase, "security"); assert.equal(st.readyAt, (T0 + 10) * 1000); assert.deepEqual(st.waitingFor, ["security"]);
  assert.ok(!("firm" in st), "firm is only ever written as false");
  assert.deepEqual(stateErrors({ v: 1, board: { boardId: "b", at: T0 * 1000 }, cards: { "card-b": st }, agents: {} }).filter((e) => /readyAt|waitingFor|firm/.test(e)), []);
});

test("a fully signed tip has readyAt and no waitingFor", () => {
  const s = scratch();
  const msg = "Work\n\nBoard-Id: card-c";
  const sha = s.branch("card-c", msg, 10); s.sign(sha, "checker"); s.sign(sha, "security"); s.sync();
  const st = cardState({ id: "card-c", num: 733, level: "Full", phase: "plan" }, s.repo({ tips: s.tipsOf("card-c", sha, 10, msg) }), cfg, T0 * 1000);
  assert.equal(st.phase, "ship"); assert.equal(st.readyAt, (T0 + 10) * 1000); assert.ok(!("waitingFor" in st));
});

test("derived/all carries readyAt, firm false and waitingFor, and leaves them out otherwise", () => {
  const view = { now: 5, evidence: {
    "cards.a": { readAt: 1, value: { phase: "security", headSha12: "a".repeat(12), readyAt: 1_790_000_010_000, waitingFor: ["security"] } },
    "cards.b": { readAt: 1, value: { phase: "build", headSha12: "b".repeat(12), firm: false } },
    "cards.c": { readAt: 1, value: { phase: "plan", headSha12: null } },
  } };
  const d = derivedDoc(view).cards;
  assert.equal(d.a.readyAt, 1_790_000_010_000); assert.deepEqual(d.a.waitingFor, ["security"]); assert.ok(!("firm" in d.a));
  assert.equal(d.b.firm, false); assert.ok(!("readyAt" in d.b));
  assert.ok(!("readyAt" in d.c) && !("firm" in d.c) && !("waitingFor" in d.c));
});

// Designer's gap 2 (#C722, #C724): a card in another repository, on main and deployed, resolves its live version once the repository
// reads versions by a pattern; the probe now hands those repositories the collector's versionPattern, not null.
test("a merged and deployed card in another repository reads its live version", async () => {
  const { readFileSync } = await import("node:fs");
  const s = scratch();
  const msg = "Work\n\nBoard-Id: card-d";
  const sha = s.branch("card-d", msg, 10); s.sign(sha, "checker"); s.sign(sha, "security");
  s.g(["merge", "-q", "--no-ff", "-m", "v1.209.1: card-d", "card-d"]); s.g(["branch", "-qD", "card-d"]); s.sync();
  const live = s.g(["rev-parse", "main"]).trim();
  const card = { id: "card-d", num: 734, level: "Full", phase: "plan" };
  const tips = [{ branch: "main", sha: "x", at: T0, message: "" }];
  const none = cardState(card, s.repo({ tips, live, versionPattern: null }), cfg, T0 * 1000);
  assert.equal(none.phase, "live"); assert.equal(none.liveVersion, null);
  const st = cardState(card, s.repo({ tips, live, versionPattern: cfg.collector.versionPattern }), cfg, T0 * 1000);
  assert.equal(st.phase, "live"); assert.equal(st.liveVersion, "1.209.1");
  assert.match(readFileSync(new URL("../collector/state.mjs", import.meta.url), "utf8"), /live: installed, versionPattern: c\.versionPattern \|\| null/, "the probe passes the pattern to other repositories");
});
