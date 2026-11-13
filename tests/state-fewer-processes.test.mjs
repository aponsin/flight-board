// #C996 part 3: the probe's state child runs fewer processes. A trailer index (one git log for every card), a per-run read memo (each distinct read once)
// and one batched `gh run list` for the CI readings. Each gives the answer the per-card way gave, and each counts its processes with the same numbers
// for 4 cards as for 40.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState, trailerHead, trailerIndex, TRAILER_INDEX_MAX, memoGit, MEMO_MAX_CHARS, ciReader, CI_BATCH_LIMIT, MAX_CI_CALLS, BACKOFF_MIN_MS } from "../collector/state.mjs";

const sha = (n) => String(n).padStart(40, "0");
const T = 1_800_000_000_000;
// A fake git over a main with these commits (newest first): { sha, at (s), ids: [...] }. Counts every call; answers a log with --grep as the real one does.
function fakeGit(commits, { fail = false } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (fail) throw new Error("git down");
    assert.equal(args[0], "log");
    const grep = args.find((a) => a.startsWith("--grep="))?.slice("--grep=".length) ?? "";
    const max = Number(/^-(\d+)$/.exec(args[1])?.[1] ?? Infinity);
    return commits.map((c) => ({ ...c, message: `subject\n\nbody\n\n${c.ids.map((i) => `Board-Id: ${i}`).join("\n")}\nCo-Authored-By: x` }))
      .filter((c) => c.message.includes(grep)).slice(0, max)
      .map((c) => `${c.sha}\x1f${c.at}\x1f${c.message}\x1e`).join("\n");
  };
  git.calls = calls;
  return git;
}
const repoOf = (commits, extra = {}, opts) => ({ remote: "origin", main: "main", git: fakeGit(commits, opts), ...extra });
const COMMITS = [
  { sha: sha(5), at: 500, ids: ["card-e"] }, { sha: sha(4), at: 400, ids: ["card-d", "card-c"] },
  { sha: sha(3), at: 300, ids: ["card-c"] }, { sha: sha(2), at: 200, ids: ["card-b"] }, { sha: sha(1), at: 100, ids: [] },
];

test("the trailer index gives every card the same head the per-card read gave, in one git process", () => {
  const plain = repoOf(COMMITS), indexed = repoOf(COMMITS, { indexed: true });
  const ids = ["card-a", "card-b", "card-c", "card-d", "card-e", "card-", "card-c\nBoard-Id: x"];
  for (const id of ids) assert.deepEqual(trailerHead(indexed, id), trailerHead(plain, id), JSON.stringify(id));
  assert.equal(indexed.git.calls.length, 1, "one process for every card");
  assert.ok(plain.git.calls.length >= ids.length, "the per-card way asks once per card");
  assert.equal(trailerHead(indexed, "card-c").sha, sha(4), "the newest commit that carries the card's id, among several");
  assert.equal(trailerHead(indexed, "card-a"), null, "a card with no commit is none when the list is whole");
  // The same number of processes for 40 cards as for 4.
  const many = repoOf(COMMITS, { indexed: true });
  for (let n = 0; n < 40; n++) trailerHead(many, `card-${n}`);
  assert.equal(many.git.calls.length, 1);
});

test("the index asks for the whole of main's trailers, never a branch or another depth", () => {
  const r = repoOf(COMMITS, { indexed: true });
  trailerHead(r, "card-b");
  assert.deepEqual(r.git.calls[0], ["log", `-${TRAILER_INDEX_MAX}`, "--fixed-strings", "--grep=Board-Id: ", "--format=%H%x1f%ct%x1f%B%x1e", "origin/main"]);
  // A branch other than main, or a depth other than 400, is the per-card read (the card's own commits on a branch).
  trailerHead(r, "card-b", "build/x", 100);
  assert.ok(r.git.calls.length === 2 && r.git.calls[1].includes("--grep=Board-Id: card-b") && r.git.calls[1].includes("origin/build/x"));
  trailerHead(r, "card-b", "main", 100);
  assert.ok(r.git.calls.length === 3 && r.git.calls[2].includes("-100"), "main at another depth is the per-card read");
  trailerHead(r, "card-b", "build/x", 400);
  assert.ok(r.git.calls.length === 4 && r.git.calls[3].includes("origin/build/x"), "another branch at depth 400 is the per-card read");
  // A repository not marked indexed keeps the per-card read.
  const p = repoOf(COMMITS);
  trailerHead(p, "card-b");
  assert.ok(p.git.calls[0].includes("--grep=Board-Id: card-b"));
});

test("a cut index asks the card alone; a git failure gives no index", () => {
  const cut = Array.from({ length: TRAILER_INDEX_MAX }, (_, n) => ({ sha: sha(n + 10), at: n, ids: [`other-${n}`] }));
  const r = repoOf([...cut, { sha: sha(2), at: 1, ids: ["old-card"] }], { indexed: true });
  assert.equal(trailerIndex(r).complete, false);
  assert.equal(trailerHead(r, "old-card")?.sha, sha(2), "found by the per-card read past the cap");
  assert.equal(r.git.calls.length, 2, "the index, then the one card");
  assert.equal(trailerHead(r, "other-0")?.sha, sha(10), "a card the index holds is not asked again");
  assert.equal(r.git.calls.length, 2);
  const down = repoOf(COMMITS, { indexed: true }, { fail: true });
  assert.equal(trailerIndex(down), null);
  assert.equal(trailerHead(down, "card-b"), null, "a git failure reads as nothing");
});

test("the read memo runs each distinct read once, keeps a failure, and never keeps a write", () => {
  const seen = [];
  const git = (args) => { seen.push(args); if (args[0] === "merge-base" && args.includes("--is-ancestor") && args.includes("no")) throw new Error("exit 1"); return `out:${args.join(" ")}`; };
  const m = memoGit(git);
  assert.equal(m(["rev-list", "-1", "a"]), "out:rev-list -1 a");
  assert.equal(m(["rev-list", "-1", "a"]), "out:rev-list -1 a");
  assert.equal(m(["rev-list", "-1", "b"]), "out:rev-list -1 b");
  assert.equal(seen.length, 2);
  for (let n = 0; n < 2; n++) assert.throws(() => m(["merge-base", "--is-ancestor", "no", "main"]), /exit 1/);
  assert.equal(seen.length, 3, "the failure is kept");
  m(["notes", "--ref=r", "list"]); m(["notes", "--ref=r", "list"]); m(["notes", "--ref=r", "show", "x"]); m(["notes", "--ref=r", "show", "x"]);
  assert.equal(seen.length, 5, "notes list and show are reads");
  for (const w of [["fetch", "-q", "origin"], ["notes", "--ref=r", "add", "-m", "x", "y"], ["update-ref", "r", "x"], ["push", "origin"]]) { m(w); m(w); }
  assert.equal(seen.length, 5 + 8, "fetch, a notes write, update-ref and push run every time");
  assert.deepEqual({ ...m.stats }, { hits: 4, runs: 13 }, "four repeats served from the memo, thirteen processes run");
  // A huge result is not kept; a non-array argument list is passed through.
  let n = 0;
  const big = memoGit(() => { n++; return "x".repeat(MEMO_MAX_CHARS + 1); });
  big(["log", "-1"]); big(["log", "-1"]);
  assert.equal(n, 2);
  assert.equal(memoGit(() => "ok")("not-an-array"), "ok");
});

test("the CI reader with batch asks gh once for every card and still asks a commit alone that the list lacks", () => {
  const run = (s, status = "completed", conclusion = "success") => ({ headSha: s, status, conclusion, createdAt: new Date(T - 5 * 60e3).toISOString(), updatedAt: new Date(T - 2 * 60e3).toISOString() });
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args.includes("--commit")) return JSON.stringify([run(args[args.indexOf("--commit") + 1], "in_progress", "")]);
    return JSON.stringify([run(sha(1)), run(sha(2), "completed", "failure"), run(sha(1), "completed", "failure"), run(sha(3), "in_progress", "")]);
  };
  const cache = {}, read = ciReader(gh, T, cache, undefined, { batch: true });
  assert.deepEqual(read(sha(1)), { ci: "passed", ciMin: 3 }, "the newest run of a commit is the first in the list");
  assert.equal(read(sha(2)).ci, "failed");
  assert.equal(read(sha(3)).ci, "running");
  assert.equal(calls.length, 1, "one gh process for three cards");
  assert.deepEqual(calls[0], ["run", "list", "--limit", String(CI_BATCH_LIMIT), "--json", "headSha,status,conclusion,createdAt,updatedAt"]);
  assert.deepEqual(Object.keys(cache).sort(), [sha(1), sha(2)], "finished readings are kept, a running one is not");
  assert.equal(read(sha(9)).ci, "running", "a commit the list lacks is asked alone");
  assert.equal(calls.length, 2); assert.ok(calls[1].includes("--commit") && calls[1].includes(sha(9)));
  // The same number of gh processes for 40 cards as for 4 (all in the list).
  const many = [], list = Array.from({ length: 40 }, (_, n) => run(sha(n + 100)));
  const read40 = ciReader((a) => { many.push(a); return JSON.stringify(list); }, T, {}, undefined, { batch: true });
  for (let n = 0; n < 40; n++) assert.equal(read40(sha(n + 100)).ci, "passed");
  assert.equal(many.length, 1);
  // A run whose cards are all cached asks nothing.
  const none = [];
  const cached = ciReader((a) => { none.push(a); return "[]"; }, T, { [sha(1)]: { ci: "passed", ciMin: 1 } }, undefined, { batch: true });
  assert.equal(cached(sha(1)).ci, "passed"); assert.equal(none.length, 0);
});

test("a failed batch list starts the back-off and gives no card a reading; a good one clears it; the single-commit way is unchanged without batch", () => {
  const backoff = { until: 0, wait: BACKOFF_MIN_MS };
  const calls = [];
  const bad = ciReader((a) => { calls.push(a); throw new Error("rate limit"); }, T, {}, backoff, { batch: true });
  assert.deepEqual(bad(sha(1)), { ci: "none", ciMin: null });
  assert.deepEqual(bad(sha(2)), { ci: "none", ciMin: null });
  assert.equal(calls.length, 1, "one failed call, not one per card");
  assert.equal(backoff.until, T + BACKOFF_MIN_MS); assert.equal(backoff.wait, 2 * BACKOFF_MIN_MS);
  // While the back-off lasts nothing is asked.
  const waiting = []; const held = ciReader((a) => { waiting.push(a); return "[]"; }, T + 1000, {}, backoff, { batch: true });
  assert.equal(held(sha(3)).ci, "none"); assert.equal(waiting.length, 0);
  // A good list clears the back-off.
  const ok = { until: 0, wait: 4 * BACKOFF_MIN_MS };
  ciReader(() => JSON.stringify([{ headSha: sha(1), status: "completed", conclusion: "success", createdAt: new Date(T).toISOString(), updatedAt: new Date(T).toISOString() }]), T, {}, ok, { batch: true })(sha(1));
  assert.deepEqual(ok, { until: 0, wait: BACKOFF_MIN_MS });
  // The list is one call against MAX_CI_CALLS: with a list that holds none of the commits, the cap on gh processes is the same as without batch.
  const capped = [];
  const lacking = ciReader((a) => { capped.push(a); return a.includes("--commit") ? JSON.stringify([{ status: "in_progress", conclusion: "", createdAt: new Date(T).toISOString() }]) : "[]"; }, T, {}, undefined, { batch: true });
  for (let n = 0; n < MAX_CI_CALLS + 5; n++) lacking(sha(n + 1));
  assert.equal(capped.length, MAX_CI_CALLS, "the list and the single reads together stay within the cap");
  // Without batch: one gh call per commit, as before, and the call cap holds.
  const per = [];
  const single = ciReader((a) => { per.push(a); return JSON.stringify([{ status: "completed", conclusion: "success", createdAt: new Date(T).toISOString(), updatedAt: new Date(T).toISOString() }]); }, T, {});
  for (let n = 0; n < MAX_CI_CALLS + 5; n++) single(sha(n + 1));
  assert.equal(per.length, MAX_CI_CALLS);
  assert.ok(per.every((a) => a.includes("--commit")));
});

// Real git: a main with several shipped cards (branches merged and deleted, so only the trailer finds them) and an open one on a branch. The card
// states with the index and the memo equal the per-card way's, with far fewer git processes, and the same number of reads for 3 shipped cards as 9.
test("real git: card states with the index and the memo equal the per-card way's, in fewer processes", () => {
  const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
  const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });
  const T0s = 1_790_000_000;
  const dir = mkdtempSync(join(tmpdir(), "fb-fewer-")), work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0s;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]); execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const ship = (name) => {
    g(["checkout", "-qb", name]); at += 10; appendFileSync(join(work, `${name}.md`), "x\n"); g(["add", "-A"]); g(["commit", "-qm", `Work ${name}\n\nBoard-Id: ${name}`]);
    const s = g(["rev-parse", "HEAD"]).trim();
    for (const ref of Object.values(NOTES)) g(["notes", `--ref=${ref}`, "add", "-m", "PASS", s]);
    g(["checkout", "-q", "main"]); at += 10; g(["merge", "-q", "--no-ff", "-m", `v1.0.0: ${name}`, name]); g(["branch", "-qD", name]);
  };
  const shipped = ["card-one", "card-two", "card-three", "card-four", "card-five", "card-six", "card-seven", "card-eight", "card-nine"];
  for (const n of shipped) ship(n);
  g(["checkout", "-qb", "build/card-open"]); at += 10; appendFileSync(join(work, "open.md"), "x\n"); g(["add", "-A"]); g(["commit", "-qm", "Open work\n\nBoard-Id: card-open"]); g(["checkout", "-q", "main"]);
  g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]);
  const openTip = { branch: "build/card-open", sha: g(["rev-parse", "origin/build/card-open"]).trim(), at: (T0s + 500) * 1000, message: "Open work\n\nBoard-Id: card-open" };
  const cardsOf = (ids) => ids.map((id, n) => ({ id, num: 800 + n, level: "Full", phase: "plan" }));
  const readAll = (ids, fast) => {
    let spawned = 0;
    const raw = (args) => { spawned++; return g(args); };
    const git = fast ? memoGit(raw) : raw;
    const repo = { git, remote: "origin", main: "main", notes: NOTES, tips: [{ branch: "main", sha: "x", at: T0s * 1000, message: "" }, openTip], live: null, versionPattern: null, ...(fast ? { indexed: true } : {}) };
    const states = cardsOf(ids).map((c) => cardState(c, repo, cfg, (T0s + 1000) * 1000));
    return { states, spawned };
  };
  const ids = [...shipped, "card-open", "card-nowhere"];
  const slow = readAll(ids, false), fast = readAll(ids, true);
  assert.deepEqual(fast.states, slow.states, "the same card states");
  assert.ok(fast.states.slice(0, 9).every((s) => s.onMain === true && s.signed.length === 2), "each shipped card is found by its trailer");
  assert.ok(fast.spawned < slow.spawned, `fewer git processes: ${fast.spawned} against ${slow.spawned}`);
  // Processes grow with the cards the per-card way, far less with the index: three shipped cards cost less than nine, and each added card costs fewer.
  const few = readAll([...shipped.slice(0, 3), "card-open", "card-nowhere"], true).spawned, base = readAll(["card-open", "card-nowhere"], true).spawned;
  const perCardFast = (fast.spawned - base) / 9, perCardSlow = (slow.spawned - readAll(["card-open", "card-nowhere"], false).spawned) / 9;
  assert.ok(perCardFast < perCardSlow, `per shipped card: ${perCardFast} against ${perCardSlow}`);
  assert.ok(few <= fast.spawned);
});
