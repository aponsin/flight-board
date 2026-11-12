// #C1044: a group branch holds one commit per member card but its tip names only the last, so the other members never got a head, read as not built, and
// stack-ready and the dispatch's batch hold waited forever. For a branch whose tip's card has a batch, every commit's Board-Id in main..tip gives its card the
// head. A single-card branch, a card with no batch, and a card with a head of its own are unchanged. Real git; fictional names.
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
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI", repos: [{ name: "boardrepo", path: "/y", notes: NOTES }] } });

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-group-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const commit = (t, file, msg) => { at = T0 + t; appendFileSync(join(work, file), `${t}\n`); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  const note = (sha, text) => { for (const ref of Object.values(NOTES)) g(["notes", `--ref=${ref}`, "add", "-f", "-m", text, sha]); };
  const repo = () => ({ git: (args) => g(args), remote: "origin", main: "main", notes: NOTES, tips: remoteTips((a) => g(a), "origin"), live: null, versionPattern: null });
  return { g, commit, sync, repo, note };
}

const card = (id, num, batch) => ({ id, num, level: "Quick", phase: "plan", ...(batch ? { batch } : {}) });
const read = (s, cards) => cardStates({ cards, config: cfg, repos: { "": s.repo() }, now: (T0 + 1000) * 1000 });

test("a five-commit group branch: all five cards read as built, each at its own commit", () => {
  const s = scratch();
  s.g(["checkout", "-qb", "build/g-demo"]);
  const shas = ["a", "b", "c", "d", "e"].map((x, i) => s.commit(10 * (i + 1), `${x}.md`, `${x} work\n\nBoard-Id: card-${x}`));
  s.g(["checkout", "-q", "main"]); s.sync();
  const out = read(s, ["a", "b", "c", "d", "e"].map((x, i) => card(`card-${x}`, 900 + i, "g-demo")));
  ["a", "b", "c", "d", "e"].forEach((x, i) => assert.equal(out[`card-${x}`].headSha12, shas[i].slice(0, 12), `card-${x}`));
  for (const x of ["a", "b", "c", "d", "e"]) assert.notEqual(out[`card-${x}`].phase, "plan", `card-${x} is past plan`);
});

test("a member with no batch in the middle of a branch is not given a head; a single-card branch is unchanged", () => {
  const s = scratch();
  s.g(["checkout", "-qb", "build/g-demo"]);
  s.commit(10, "a.md", "a work\n\nBoard-Id: card-a");
  const mid = s.commit(20, "b.md", "b work\n\nBoard-Id: card-b");
  s.commit(30, "c.md", "c work\n\nBoard-Id: card-c");
  s.g(["checkout", "-q", "main"]);
  s.g(["checkout", "-qb", "build/card-solo"]);
  const solo = s.commit(40, "s.md", "solo\n\nBoard-Id: card-solo");
  s.g(["checkout", "-q", "main"]); s.sync();
  const out = read(s, [card("card-a", 901, "g-demo"), card("card-b", 902), card("card-c", 903, "g-demo"), card("card-solo", 904)]);
  assert.equal(out["card-b"].headSha12, null, "no batch: not looked for under the tip");
  assert.notEqual(out["card-b"].headSha12, mid.slice(0, 12));
  assert.equal(out["card-solo"].headSha12, solo.slice(0, 12));
  assert.ok(out["card-a"].headSha12 && out["card-c"].headSha12);
});

test("a batched card whose tip is not a batched card's is not searched for", () => {
  const s = scratch();
  s.g(["checkout", "-qb", "build/plain"]);
  s.commit(10, "a.md", "a work\n\nBoard-Id: card-a");
  s.commit(20, "p.md", "plain\n\nBoard-Id: card-plain");
  s.g(["checkout", "-q", "main"]); s.sync();
  const out = read(s, [card("card-a", 901, "g-demo"), card("card-plain", 905)]);
  assert.equal(out["card-a"].headSha12, null, "the tip's card has no batch: the branch is not a group branch");
});

// Checker 2's F1 on 63437c45: the group tip's notes cover every member under it (one review per group, #C1032), the same cover the stack path passes.
function group3() {
  const s = scratch();
  s.g(["checkout", "-qb", "build/g-demo"]);
  const a = s.commit(10, "a.md", "a work\n\nBoard-Id: card-a");
  const b = s.commit(20, "b.md", "b work\n\nBoard-Id: card-b");
  const c = s.commit(30, "c.md", "c work\n\nBoard-Id: card-c");
  s.g(["checkout", "-q", "main"]);
  return { s, a, b, c, cards: [card("card-a", 901, "g-demo"), card("card-b", 902, "g-demo"), card("card-c", 903, "g-demo")] };
}

test("notes only on the group tip: every member reads as signed and past the reviews, not only the tip's card", () => {
  const { s, c, cards } = group3();
  s.note(c, "PASS"); s.sync();
  const out = read(s, cards);
  for (const id of ["card-a", "card-b", "card-c"]) {
    assert.deepEqual(out[id].signed, ["checker", "security"], id);
    assert.notEqual(out[id].phase, "checker", `${id} is past the checker review`);
  }
});

test("a FINDINGS on the group tip reaches the members below it", () => {
  const { s, c, cards } = group3();
  s.note(c, "FINDINGS"); s.sync();
  const out = read(s, cards);
  for (const id of ["card-a", "card-b", "card-c"]) assert.deepEqual(out[id].findings, ["checker", "security"], id);
});
