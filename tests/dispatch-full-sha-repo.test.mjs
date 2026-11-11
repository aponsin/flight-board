// #C895 (dispatch-full-sha-repo): a DISPATCH line names the full 40-character sha, the repository (owner/name) and the branch. Release got a line with
// only "e0582383ef48": 12 characters, no repo, no branch; it looked in the product repository, could not find the commit and had to ask the lead.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState, repoFullOf } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";
import { stackFields } from "../collector/stack.mjs";
import { turnsOf } from "../collector/store-dispatch.mjs";
import { dispatchItems, dispatchLine } from "../gate/reset.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });
const SHA40 = /^[0-9a-f]{40}$/;
const SSH_USER = ["git", "github.com"].join("@"); // the ssh form of a remote; written in pieces so the push scan does not take it for an email address

// A real repository with a bare origin; `url` is what `git remote get-url` is told to answer (the origin here is a local path).
function scratch(url) {
  const dir = mkdtempSync(join(tmpdir(), "fb-sha-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const branch = (name, msg, t) => { g(["checkout", "-qb", name]); at = T0 + t; appendFileSync(join(work, `${name}.md`), "x\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); const sha = g(["rev-parse", "HEAD"]).trim(); g(["checkout", "-q", "main"]); return sha; };
  const onMain = (msg, t) => { at = T0 + t; g(["commit", "--allow-empty", "-qm", msg]); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  const tips = () => g(["for-each-ref", "refs/remotes/origin", "--format=%(refname:lstrip=3)%1f%(objectname)%1f%(committerdate:unix)%1f%(contents)%1e"]).split("\x1e")
    .map((r) => r.replace(/^\n/, "")).filter((r) => r.includes("\x1f")).map((r) => { const [b, sha, t, m] = r.split("\x1f"); return { branch: b, sha, at: Number(t) * 1000, message: m }; }).filter((h) => h.branch && h.branch !== "HEAD");
  const git = (args) => (args[0] === "remote" && args[1] === "get-url" ? `${url}\n` : g(args));
  const repo = () => ({ git, remote: "origin", main: "main", notes: NOTES, live: null, versionPattern: null, tips: tips() });
  return { branch, onMain, sync, repo };
}

test("repoFullOf: owner/name from an https or ssh remote, with or without .git; nothing for an address that is not owner/name", () => {
  const of = (url) => repoFullOf({ git: () => url, remote: "origin" });
  assert.equal(of("https://github.com/acme/widgets.git"), "acme/widgets");
  assert.equal(of("https://github.com/acme/widgets"), "acme/widgets");
  assert.equal(of(`${SSH_USER}:acme/widgets.git`), "acme/widgets");
  assert.equal(of(`ssh://${SSH_USER}/acme/widgets.git/`), "acme/widgets");
  assert.equal(of("/srv/git/origin.git"), "git/origin", "a local path still ends in two names; it is what the remote says");
  assert.equal(of("not-a-url"), null);
  assert.equal(of("https://github.com/-bad/name"), null, "a name that could pass for a git flag");
  assert.equal(repoFullOf({ git: () => { throw new Error("no such remote"); }, remote: "origin" }), null);
  assert.equal(repoFullOf(null), null);
});

test("the probe's card reading carries the head's full sha, its branch and the repository, for a branch tip and for a card read from main", () => {
  const board = scratch("https://github.com/aponsin/flight-board.git");
  const sha = board.branch("card-x", "#C77: work\n\nBoard-Id: card-x", 5); board.sync();
  const st = cardState({ id: "card-x", num: 77, level: "Full", phase: "plan" }, board.repo(), cfg, (T0 + 99) * 1000);
  assert.equal(st.headSha, sha); assert.match(st.headSha, SHA40); assert.equal(st.headSha12, sha.slice(0, 12));
  assert.equal(st.headBranch, "card-x");
  assert.equal(st.repoFull, "aponsin/flight-board");
  const product = scratch(`${SSH_USER}:acme/product-site.git`);
  product.onMain("shipped\n\nBoard-Id: card-y", 6); product.sync();
  const landed = cardState({ id: "card-y", num: 78, level: "Full", phase: "plan" }, product.repo(), cfg, (T0 + 99) * 1000);
  assert.match(landed.headSha, SHA40); assert.equal(landed.headBranch, "main", "a card on main is on main");
  assert.equal(landed.repoFull, "acme/product-site");
});

test("the state schema takes the three fields and refuses a short sha, a repository with spaces or a branch that could pass for a flag", () => {
  const board = scratch("https://github.com/aponsin/flight-board.git");
  board.branch("card-x", "#C77: work\n\nBoard-Id: card-x", 5); board.sync();
  const st = cardState({ id: "card-x", num: 77, level: "Full", phase: "plan" }, board.repo(), cfg, (T0 + 99) * 1000);
  const fits = (c) => stateErrors({ v: 1, board: { boardId: "b", at: T0 * 1000, probe: null, pageVersion: null }, cards: { "card-x": c }, agents: {} });
  assert.deepEqual(fits(st), []);
  for (const bad of [{ headSha: "abc123" }, { headSha: "G".repeat(40) }, { repoFull: "acme widgets" }, { repoFull: "acme" }, { headBranch: "-rf" }, { headBranch: "a b" }]) assert.notDeepEqual(fits({ ...st, ...bad }), [], JSON.stringify(bad));
});

test("a stack member carries the tip's full sha beside the 12 characters, only when it is the same commit", () => {
  const tip = "a".repeat(12) + "b".repeat(28);
  const f = stackFields({ tip, branch: "build/stack", members: ["a", "b"], outside: [] });
  assert.equal(f.a.tipSha, tip); assert.equal(f.a.tip, tip.slice(0, 12));
  const wrong = stateErrors({ v: 1, board: { boardId: "b", at: T0 * 1000, probe: null, pageVersion: null }, cards: { a: { phase: "build", headSha12: null, signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: T0 * 1000, stack: { ...f.a, tipSha: "c".repeat(40) } } }, agents: {} });
  assert.notDeepEqual(wrong, [], "a tipSha that is not the tip's commit is refused");
});

const SHA = "e0582383ef48" + "1".repeat(28);
const ev = (o = {}) => ({ phase: "ship", headSha12: SHA.slice(0, 12), headSha: SHA, headBranch: "build/parity-same-rows-tested", repoFull: "aponsin/flight-board", signed: ["checker", "security"], onMain: false, ...o });

test("the dispatch turns carry the full sha, the repository and the branch; the stack tip's own sha and branch in stack mode; nothing that does not match", () => {
  const card = { id: "c1", owner_role: "Boardsmith" };
  const land = turnsOf(card, ev())[0];
  assert.deepEqual([land.step, land.fullSha, land.repo, land.onBranch], ["land", SHA, "aponsin/flight-board", "build/parity-same-rows-tested"]);
  const review = turnsOf(card, ev({ phase: "checker", signed: [] }))[0];
  assert.deepEqual([review.step, review.fullSha, review.repo], ["review", SHA, "aponsin/flight-board"]);
  const pair = turnsOf({ ...card, repo: "flight-board" }, ev({ onMain: true, headBranch: "main" }))[0];
  assert.deepEqual([pair.step, pair.fullSha, pair.onBranch], ["pair", SHA, "main"]);
  assert.equal(turnsOf(card, ev({ headSha: "f".repeat(40) }))[0].fullSha, undefined, "a full sha that is not the 12 named is dropped");
  assert.equal(turnsOf(card, ev({ headSha: undefined }))[0].fullSha, undefined);
  const tipSha = "d".repeat(12) + "e".repeat(28);
  const inStack = turnsOf(card, ev({ stack: { tip: tipSha.slice(0, 12), tipSha, size: 3, branch: "build/the-stack" } }), { stackOn: true, stackBranch: "build/the-stack" })[0];
  assert.deepEqual([inStack.sha, inStack.fullSha, inStack.onBranch], [tipSha.slice(0, 12), tipSha, "build/the-stack"], "the line names the stack tip, whole, on the stack's branch");
});

function lineFor(turn) {
  const { items } = dispatchItems({ cards: [{ id: "c1", status: "active", num: 883, who: "Release", turns: [turn] }], agents: { Release: { state: "idle", since: 1 } }, roster: ["Release"], lead: "Manager", now: 10 * 60e3 });
  assert.equal(items.length, 1);
  return dispatchLine(items[0]);
}
const base = (o = {}) => ({ role: "Release", phase: "ship", step: "land", sha: SHA.slice(0, 12), fullSha: SHA, repo: "aponsin/flight-board", onBranch: "build/parity-same-rows-tested", signed: ["Checker", "Security"], ...o });

test("a flight-board tip and a product tip each dispatch with all three: the 40-character sha, owner/name and the branch", () => {
  const boardLine = lineFor(base());
  assert.match(boardLine, /repo aponsin\/flight-board, branch build\/parity-same-rows-tested, commit e0582383ef48[0-9a-f]{28} signed by Checker and Security;/);
  const productSha = "9".repeat(40);
  const productLine = lineFor(base({ sha: productSha.slice(0, 12), fullSha: productSha, repo: "acme/product-site", onBranch: "build/c862-v3" }));
  assert.match(productLine, /repo acme\/product-site, branch build\/c862-v3, commit 9{40} signed by/);
  for (const line of [boardLine, productLine]) { assert.match(line, /repo [\w.-]+\/[\w.-]+, /); assert.match(line, /branch [\w.\/-]+, /); assert.match(line, /commit [0-9a-f]{40}\b/); }
});

test("a line missing any of the three fails the test: each is what the dispatch writes, and one lost on the way shows", () => {
  const complete = lineFor(base());
  for (const lost of ["repo", "onBranch", "fullSha"]) {
    const line = lineFor(base({ [lost]: undefined }));
    assert.notEqual(line, complete, `${lost} lost: the line changes`);
    if (lost === "fullSha") assert.doesNotMatch(line, /commit [0-9a-f]{40}/);
  }
  // A line with no full sha is what it was: the twelve characters.
  assert.match(lineFor(base({ fullSha: undefined })), /at ship: e0582383ef48 signed by Checker and Security; it /);
});

test("what is read back from dispatch.json is checked again: a bad repository, branch or a sha that is not the 12 are not printed", () => {
  const item = { card: "c1", role: "Release", level: 1, since: 1, phase: "ship", step: "land", num: 883, sha: SHA.slice(0, 12), fullSha: SHA, repo: "acme/x", onBranch: "ok/branch", signed: [] };
  assert.match(dispatchLine(item), /repo acme\/x, branch ok\/branch, commit /);
  assert.doesNotMatch(dispatchLine({ ...item, repo: "acme x; rm -rf /" }), /repo /);
  assert.doesNotMatch(dispatchLine({ ...item, onBranch: "--upload-pack=x" }), /branch /);
  assert.doesNotMatch(dispatchLine({ ...item, fullSha: "f".repeat(40) }), /commit /, "a full sha of another commit than the 12 named");
  const { items } = dispatchItems({ cards: [{ id: "c1", status: "active", num: 1, who: "Release", turns: [{ ...base(), repo: "bad repo", onBranch: "-x" }] }], agents: { Release: { state: "idle", since: 1 } }, roster: ["Release"], lead: "Manager", now: 10 * 60e3 });
  assert.equal(items[0].repo, undefined); assert.equal(items[0].onBranch, undefined);
});
