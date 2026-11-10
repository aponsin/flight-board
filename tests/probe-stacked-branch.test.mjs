// #C735: a card whose branch has another card's commit stacked on top (#C728's branch carried #C730's commit) was read at that
// tip: no reviews (they were signed on the card's own commit) and, until the later card landed, not on main. The probe now reads
// the card at its own newest commit on the branch. Real git; fictional repository and names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState, cardStates, remoteTips, ownHead } from "../collector/state.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI", repos: [{ name: "boardrepo", path: "/y", notes: NOTES }] } });

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-stacked-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const commit = (t, file, msg) => { at = T0 + t; appendFileSync(join(work, file), `${t}\n`); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  const sign = (sha) => { for (const ref of Object.values(NOTES)) g(["notes", `--ref=${ref}`, "add", "-m", "PASS", sha]); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  const repo = (extra = {}) => ({ git: (args) => g(args), remote: "origin", main: "main", notes: NOTES, tips: remoteTips((a) => g(a), "origin"), live: null, versionPattern: null, ...extra });
  return { g, commit, sign, sync, repo, mainSha: () => g(["rev-parse", "main"]).trim() };
}

// Card c728-parity: its own commit (signed), then card c730-fixes stacked on the same branch.
function stacked() {
  const s = scratch();
  s.g(["checkout", "-qb", "build/c728-parity"]);
  const own = s.commit(10, "a.md", "#C728: the parity work\n\nBoard-Id: c728-parity");
  s.sign(own);
  const top = s.commit(20, "b.md", "#C730: fixes on top\n\nBoard-Id: c730-fixes");
  s.g(["checkout", "-q", "main"]);
  return { s, own, top };
}

test("a stacked branch: the card is read at its own commit, with its reviews, not at another card's tip", () => {
  const { s, own, top } = stacked();
  s.sync();
  const card = { id: "c728-parity", num: 728, level: "Full", phase: "plan" };
  const st = cardState(card, s.repo(), cfg, (T0 + 100) * 1000);
  assert.equal(st.headSha12, own.slice(0, 12), `read at ${st.headSha12}, the stacked tip is ${top.slice(0, 12)}`);
  assert.deepEqual(st.signed, ["checker", "security"]);
  assert.equal(st.onMain, false, "the card is not on main yet, and says so");
  assert.notEqual(st.phase, "plan");
});

test("a stacked branch that reached main under the later card: the card reads on main (the branch tip is an ancestor of main)", () => {
  const { s, own } = stacked();
  s.g(["merge", "-q", "--ff-only", "build/c728-parity"]);
  s.sync();
  const st = cardState({ id: "c728-parity", num: 728, level: "Full", phase: "plan" }, s.repo(), cfg, (T0 + 100) * 1000);
  assert.equal(st.headSha12, own.slice(0, 12)); assert.equal(st.onMain, true); assert.deepEqual(st.signed, ["checker", "security"]);
});

test("the later card keeps its own tip; a card with no commit of its own on the branch keeps the tip it had; odd branch names and ids reach git as nothing", () => {
  const { s, top } = stacked();
  s.sync();
  const tipOf = (name) => remoteTips((a) => s.g(a), "origin").find((t) => t.branch === name);
  const tip = tipOf("build/c728-parity");
  assert.equal(ownHead(s.repo(), { id: "c730-fixes" }, tip).sha, top, "its own trailer: no change");
  assert.equal(ownHead(s.repo(), { id: "c999-none" }, tip), tip, "no commit of its own on the branch: the tip stays");
  let asked = false;
  const watch = { ...s.repo(), git: () => { asked = true; return ""; } };
  assert.equal(ownHead(watch, { id: "c728-parity" }, { ...tip, branch: "--all" }).sha, tip.sha);
  assert.equal(asked, false, "a branch name starting with - is never passed to git");
  assert.equal(ownHead(s.repo(), { id: "c728-parity" }, { ...tip, message: "no trailer" }).message, "no trailer", "a tip with no trailer of another card is left alone");
});

test("through cardStates: a card with repo flight-board-style routing reads the board repository's notes", () => {
  const { s, own } = stacked();
  s.sync();
  const out = cardStates({ cards: [{ id: "c728-parity", num: 728, level: "Full", repo: "boardrepo" }], config: cfg, repos: { boardrepo: s.repo(), "": { ...s.repo(), tips: [] } }, now: (T0 + 100) * 1000 });
  assert.equal(out["c728-parity"].headSha12, own.slice(0, 12)); assert.deepEqual(out["c728-parity"].signed, ["checker", "security"]);
});
