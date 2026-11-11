// #C859 slice 2: the stack as the probe's evidence. With a repository's switch on, its open cards on one build branch are one stack: each member
// is read at its own commit, a note on the stack tip counts for every card under it, a card on another branch is outside the stack, a card with
// nothing pushed is next. With the switch off, nothing changes. Real git; fictional repository and names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardStates, remoteTips, buildState } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";
import { stackOnNames } from "../collector/stack.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI", repos: [{ name: "boardrepo", path: "/y", notes: NOTES }] } });
const NOW = (T0 + 1000) * 1000;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-stackev-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const commit = (t, id) => { at = T0 + t; appendFileSync(join(work, "f.md"), `${t}\n`); g(["add", "-A"]); g(["commit", "-qm", `work for ${id}\n\nBoard-Id: ${id}`]); return g(["rev-parse", "HEAD"]).trim(); };
  const sign = (sha, text = "PASS") => { for (const ref of Object.values(NOTES)) g(["notes", `--ref=${ref}`, "add", "-f", "-m", text, sha]); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["push", "-q", "origin", "refs/notes/*:refs/notes/*"]); g(["fetch", "-q", "--prune", "origin"]); };
  const repo = () => ({ git: (a) => g(a), remote: "origin", main: "main", notes: NOTES, tips: remoteTips((a) => g(a), "origin"), live: null, versionPattern: null });
  return { g, commit, sign, sync, repo };
}
const cards = [
  { id: "card-a", num: 1, level: "Full", phase: "plan", repo: "boardrepo" },
  { id: "card-b", num: 2, level: "Full", phase: "plan", repo: "boardrepo" },
  { id: "card-c", num: 3, level: "Full", phase: "plan", repo: "boardrepo" },
  { id: "card-d", num: 4, level: "Full", phase: "plan", repo: "boardrepo" },
  { id: "card-e", num: 5, level: "Full", phase: "plan", repo: "boardrepo" },
];
function world() {
  const s = scratch();
  s.g(["checkout", "-qb", "build/the-stack"]);
  const a = s.commit(10, "card-a"), b = s.commit(20, "card-b"), c = s.commit(30, "card-c");
  s.g(["checkout", "-q", "main"]); s.g(["checkout", "-qb", "build/lonely"]);
  const d = s.commit(40, "card-d");
  s.g(["checkout", "-q", "main"]);
  return { s, a, b, c, d };
}

test("switch on: three cards on one branch are one stack, a note on the tip signs all three, another branch is outside, an unpushed card is next", () => {
  const { s, a, b, c, d } = world();
  s.sign(c); s.sync();
  const st = cardStates({ cards, config: cfg, repos: { boardrepo: s.repo() }, now: NOW, stackOn: ["boardrepo"] });
  for (const [id, sha] of [["card-a", a], ["card-b", b], ["card-c", c]]) {
    assert.deepEqual(st[id].stack, { branch: "build/the-stack", size: 3, tip: c.slice(0, 12) }, id);
    assert.equal(st[id].headSha12, sha.slice(0, 12), `${id} is read at its own commit`);
    assert.deepEqual(st[id].signed, ["checker", "security"], `${id}: the tip's notes count`);
  }
  assert.deepEqual(st["card-d"].stack, { outside: "build/lonely" });
  assert.equal(st["card-d"].headSha12, d.slice(0, 12));
  assert.deepEqual(st["card-d"].signed, [], "outside the stack: the tip's notes are not its");
  assert.deepEqual(st["card-e"].stack, { next: 1 });
  // What the probe posts must pass the state schema's allowlist.
  assert.ok(Object.values(st).every((c2) => c2.stack), "every card says where it stands");
  const state = buildState({ id: "TestBoard01", now: NOW, probe: "abcdef012345", pageVersion: null, cards: st, agents: {} });
  assert.deepEqual(stateErrors(state), [], "what the probe posts passes the schema");
  assert.deepEqual(state.cards["card-e"].stack, { next: 1 }, "and the stack survives the allowlist");
});

test("the schema takes exactly three shapes of stack and refuses the rest", () => {
  const good = buildState({ id: "TestBoard01", now: NOW, probe: "abcdef012345", pageVersion: null, cards: { "card-a": { phase: "plan", headSha12: null, signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: NOW, num: 1 } }, agents: {} });
  const withStack = (stack) => ({ ...good, cards: { "card-a": { ...good.cards["card-a"], stack } } });
  for (const ok of [{ branch: "build/x", size: 3, tip: "abcdef012345" }, { outside: "build/y" }, { next: 2 }]) assert.deepEqual(stateErrors(withStack(ok)), [], JSON.stringify(ok));
  for (const bad of [null, [], "x", {}, { outside: "-evil" }, { outside: "a b" }, { next: 0 }, { next: 1.5 }, { next: 5000 }, { branch: "build/x", size: 0, tip: "abcdef012345" }, { branch: "build/x", size: 3, tip: "XYZ" }, { branch: "build/x", size: 3, tip: "abcdef012345", extra: 1 }, { outside: "build/y", next: 1 }]) {
    assert.notDeepEqual(stateErrors(withStack(bad)), [], JSON.stringify(bad));
  }
});

test("switch off: no stack key, no borrowed sign-offs, a card on a branch not named for it has no head, exactly as before", () => {
  const { s, c } = world();
  s.sign(c); s.sync();
  const st = cardStates({ cards, config: cfg, repos: { boardrepo: s.repo() }, now: NOW, stackOn: [] });
  for (const id of Object.keys(st)) assert.equal(st[id].stack, undefined, id);
  assert.deepEqual(st["card-a"].signed, [], "card-a's own commit carries no note");
  assert.equal(st["card-a"].headSha12, null, "a branch named for no card gives no head");
});

test("a FINDINGS note on the stack tip sends every member back; a note on a lower commit stays its own", () => {
  const { s, a, c } = world();
  s.sign(c, "FINDINGS F1 something"); s.sign(a, "PASS"); s.sync();
  const st = cardStates({ cards, config: cfg, repos: { boardrepo: s.repo() }, now: NOW, stackOn: ["boardrepo"] });
  for (const id of ["card-a", "card-b", "card-c"]) assert.deepEqual(st[id].findings, ["checker", "security"], id);
  assert.deepEqual(st["card-a"].signed, ["checker", "security"], "card-a's own PASS stays");
  assert.deepEqual(st["card-b"].signed, [], "card-b has none of its own, and the tip's is a finding");
});

test("the switch names map to repository names: product is the team's own (the empty name), any other is itself; only true counts", () => {
  assert.deepEqual(stackOnNames({ "flight-board": true, product: true, "site-one": false }).sort(), ["", "flight-board"]);
  assert.deepEqual(stackOnNames({ product: false }), []);
  assert.deepEqual(stackOnNames(null), []);
  assert.deepEqual(stackOnNames({ a: "yes", b: 1 }), [], "only a true counts");
});

test("a stack branch that cannot be read leaves every card as it was (git failing, a repository with no git)", () => {
  const { s, c } = world();
  s.sign(c); s.sync();
  const broken = { ...s.repo(), git: (a) => { if (a[0] === "log" && a.includes("--reverse")) throw new Error("boom"); return s.g(a); } };
  const st = cardStates({ cards, config: cfg, repos: { boardrepo: broken }, now: NOW, stackOn: ["boardrepo"] });
  for (const id of Object.keys(st)) assert.equal(st[id].stack?.size, undefined, id);
  const none = cardStates({ cards, config: cfg, repos: { boardrepo: { ...s.repo(), git: undefined } }, now: NOW, stackOn: ["boardrepo", "missing"] });
  assert.ok(none["card-a"]);
});
