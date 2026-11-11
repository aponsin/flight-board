// #C859 slice 2: the stack is read from git (collector/stack.mjs), never typed. A fake history stands in for git: each commit names its parent.
import test from "node:test";
import assert from "node:assert/strict";
import { readStack, stackFields } from "../collector/stack.mjs";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardStates, remoteTips } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";

// parents: { sha: parentSha }. isAncestor(a, b): a is b or on b's first-parent line.
const history = (parents) => (a, b) => { for (let x = b; x; x = parents[x]) if (x === a) return true; return false; };
const P = { c1: "c0", c2: "c1", c3: "c2", c4: "c3", x1: "c0", c0: null };

test("three cards on one chain are one stack under the tip, in id order, with the tip and the size", () => {
  const s = readStack({ heads: { a: "c1", b: "c2", c: "c3" }, tips: [{ branch: "build/c", sha: "c3", at: 3 }, { branch: "build/b", sha: "c2", at: 2 }], isAncestor: history(P) });
  assert.deepEqual(s, { tip: "c3", branch: "build/c", members: ["a", "b", "c"], outside: [] });
  assert.deepEqual(stackFields(s), { a: { tip: "c3", size: 3 }, b: { tip: "c3", size: 3 }, c: { tip: "c3", size: 3 } });
});

test("a branch not cut from the stack tip is outside the stack, whoever built it", () => {
  const s = readStack({ heads: { a: "c1", b: "c2", z: "x1" }, tips: [{ branch: "build/b", sha: "c2", at: 2 }, { branch: "build/z", sha: "x1", at: 9 }], isAncestor: history(P) });
  assert.deepEqual(s.members, ["a", "b"]);
  assert.deepEqual(s.outside, ["z"]);
  assert.deepEqual(stackFields(s).z, { outside: true });
});

test("a tie goes to the newest tip, then the branch name; the same input gives the same answer", () => {
  const heads = { a: "c1", z: "x1" };
  const tips = [{ branch: "build/z", sha: "x1", at: 5 }, { branch: "build/a", sha: "c1", at: 5 }];
  const one = readStack({ heads, tips, isAncestor: history(P) });
  assert.equal(one.branch, "build/a");
  assert.deepEqual(readStack({ heads, tips: [...tips].reverse(), isAncestor: history(P) }), one);
  assert.equal(readStack({ heads, tips: [{ ...tips[0], at: 9 }, tips[1]], isAncestor: history(P) }).branch, "build/z");
});

test("a stack of one card is no stack, and no heads or no tips is no stack", () => {
  assert.deepEqual(stackFields(readStack({ heads: { a: "c1" }, tips: [{ branch: "b", sha: "c1", at: 1 }], isAncestor: history(P) })), {});
  assert.equal(readStack({ heads: {}, tips: [{ branch: "b", sha: "c1", at: 1 }], isAncestor: history(P) }), null);
  assert.equal(readStack({ heads: { a: "c1" }, tips: [], isAncestor: history(P) }), null);
  assert.equal(readStack({ heads: { a: "c4" }, tips: [{ branch: "b", sha: "c1", at: 1 }], isAncestor: history(P) }), null, "a head newer than every tip is under none");
});

test("the card field has the schema's shape: { tip, size } with size 2 or more, or { outside: true }, and nothing else", () => {
  const ok = (stack) => !stateErrors(stateWith(stack)).some((e) => /stack/.test(e));
  assert.ok(ok({ tip: "abcdef012345", size: 3 }));
  assert.ok(ok({ outside: true }));
  for (const bad of [{ tip: "abcdef012345", size: 1 }, { tip: "abcdef01", size: 3 }, { outside: false }, { tip: "abcdef012345", size: 3, outside: true }, {}, "x", null]) assert.ok(!ok(bad), JSON.stringify(bad));
});

function stateWith(stack) {
  return { v: 1, id: "t", cards: { k: { num: 1, phase: null, headSha12: null, signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: 1, stack } } };
}

// Real git: three cards chained on one branch (the middle one is neither at the tip nor the branch's name), and a fourth cut from main.
const T0 = 1_790_000_000;
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, deployWorkflow: "CI" } });
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-stack-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const commit = (t, file, id) => { at = T0 + t; appendFileSync(join(work, file), `${t}\n`); g(["add", "-A"]); g(["commit", "-qm", `Work on ${id}\n\nBoard-Id: ${id}`]); return g(["rev-parse", "HEAD"]).trim(); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  const repo = () => ({ git: (args) => g(args), remote: "origin", main: "main", notes: cfg.collector.notes, tips: remoteTips((a) => g(a), "origin"), live: null, versionPattern: null });
  return { g, commit, sync, repo };
}

test("cardStates adds no stack field for a switch that is off, and reads the chain and the outsider for one that is on", () => {
  const s = scratch();
  s.g(["checkout", "-qb", "build/stack"]);
  s.commit(10, "a.md", "card-one"); s.commit(20, "b.md", "card-two"); const three = s.commit(30, "c.md", "card-three");
  s.g(["checkout", "-q", "main"]); s.g(["checkout", "-qb", "build/card-four"]);
  s.commit(40, "d.md", "card-four");
  s.g(["checkout", "-q", "main"]);
  s.sync();
  const cards = ["card-one", "card-two", "card-three", "card-four"].map((id) => ({ id }));
  const run = (stacks) => cardStates({ cards, config: cfg, repos: { "": s.repo() }, now: (T0 + 100) * 1000, stacks });
  for (const id of Object.keys(run([]))) assert.equal(run([])[id].stack, undefined, `${id}: the switch off is today's reading`);
  const on = run([""]);
  for (const id of ["card-one", "card-two", "card-three"]) assert.deepEqual(on[id].stack, { tip: three.slice(0, 12), size: 3 }, id);
  assert.deepEqual(on["card-four"].stack, { outside: true });
  assert.deepEqual(stateErrors({ v: 1, id: "t", cards: { k: { ...on["card-two"] } } }).filter((e) => /stack/.test(e)), [], "the field passes the schema");
});

test("a repository the switch names but the probe has no clone for is skipped, and a stack of one card carries nothing", () => {
  const s = scratch();
  s.g(["checkout", "-qb", "build/solo"]);
  s.commit(10, "a.md", "solo");
  s.g(["checkout", "-q", "main"]);
  s.sync();
  const out = cardStates({ cards: [{ id: "solo" }], config: cfg, repos: { "": s.repo() }, now: (T0 + 100) * 1000, stacks: ["", "nowhere"] });
  assert.equal(out.solo.stack, undefined);
});
