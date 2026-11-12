// #C996 part 2: the derive's git processes. On 11-11 one derive started 694 of them one after another (266 `git log`, 290 `git rev-parse`,
// 46 `git notes`, 45 `git merge-base`, ...), 70 to 100 ms each at the machine's load, and took 78 to 94 s. 145 of the `rev-parse` were the
// same shas asked twice (shippedHeads ran twice), 145 `git log -1` read each shipped commit's message alone, and every card with no branch
// started its own `git log --grep`. This counts the processes a derive starts on a fixture, so a call that comes back doubled, or one per card
// or per shipped branch, fails here; and it checks that each batch's fallback (when git cannot answer the batch) gives the same derive.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { collect, trailerOnMain, trailerIndex } from "../collector/collect.mjs";
import { mainLine, shippedHeads, resolveCommits, commitMessages, memoGit } from "../collector/facts.mjs";

const PATTERN = "([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})";

// A repository whose main line shipped `n` branches (deleted since, each named in its release commit and carrying its Board-Id trailer),
// plus one branch in review; `a` and `b` ship in one release commit, so a subject can name two.
function scratch(n) {
  const dir = mkdtempSync(join(tmpdir(), "fb-spawns-"));
  const repo = join(dir, "repo"), bare = join(dir, "origin.git");
  const g = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  const commit = (file, msg) => { writeFileSync(join(repo, file), `${msg}\n`); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  commit("start.md", "start");
  const shas = [];
  for (let i = 0; i < n; i++) {
    g(["checkout", "-qb", `build/ship${i}`, "main"]);
    shas.push(commit(`s${i}.md`, `work ${i}\n\nBoard-Id: ship${i}`));
    g(["checkout", "-q", "main"]); g(["merge", "-q", "--no-ff", "-m", `Merge ship${i}`, `build/ship${i}`]);
    g(["branch", "-q", "-D", `build/ship${i}`]);
    // Every second release names two branches: the pair before it and this one.
    commit(`v${i}.md`, `v1.4.${i}: build/ship${i}@${shas[i].slice(0, 8)}${i % 2 && i > 0 ? `, build/ship${i - 1}@${shas[i - 1].slice(0, 8)}` : ""}`);
  }
  g(["checkout", "-qb", "build/review-one", "main"]); commit("r.md", "ready work\n\nBoard-Id: review-one");
  g(["checkout", "-q", "main"]);
  g(["push", "-q", "origin", "main", "build/review-one"]);
  g(["fetch", "-q", "origin", "+refs/notes/*:refs/notes/flight-board/*"]);
  g(["fetch", "-q", "origin"]);
  return { dir, repo, git: (args) => g(args), shas, main: g(["rev-parse", "main"]).trim() };
}

const cfg = (repo) => fullConfig({ owner: "Sam", collector: { repoPath: repo, notes: { checker: "refs/notes/checker" }, deployWorkflow: "CI", shippedPattern: PATTERN } });
const gh = (main) => (args) => (args.includes("--workflow") ? JSON.stringify([{ headSha: main }]) : "[]");
// Open cards: some shipped (their trailer is on main, their branch is gone), one in review, and some with no branch at all (each of those once
// started its own `git log --grep`, and with a number its own `git log -1` per shipped commit).
const cardsOf = (n) => [
  ...Array.from({ length: n }, (_, i) => ({ id: `ship${i}`, status: "active", phase: "ship", level: "Quick", num: 100 + i })),
  { id: "review-one", status: "active", phase: "build", level: "Quick", num: 200 },
  ...Array.from({ length: 6 }, (_, i) => ({ id: `nothing-${i}`, status: "active", phase: "plan", num: 300 + i })),
];
const counted = (s) => { const calls = []; return { calls, git: (args) => { calls.push(args); return s.git(args); } }; };
const isResolve = (a) => a[0] === "rev-parse" && a.some((x) => String(x).endsWith("^{commit}"));
// A message read alone for a SHIPPED commit (after-ship.mjs reads a card's own tip's message, one per card in review: that one is not these).
const aloneFor = (shas) => (a) => a[0] === "log" && a.includes("-1") && a.includes("--format=%B") && shas.includes(a.at(-1));
const isTrailerLog = (a) => a[0] === "log" && a.some((x) => String(x).startsWith("--grep=Board-Id:"));

test("a derive resolves the shipped shas in one process, reads their messages in one, and looks up every card's trailer in one", () => {
  const s = scratch(8);
  try {
    const c = counted(s);
    const { doc } = collect({ config: cfg(s.repo), cards: cardsOf(8), git: c.git, gh: gh(s.main), now: 1 });
    assert.equal(doc.cards.ship3.phase, "live", "the derive still reads a shipped card as live, from its trailer on main");
    assert.equal(c.calls.filter(isResolve).length, 1, "one `git rev-parse` for all the shipped shas, not two per branch (shippedHeads ran twice)");
    assert.equal(c.calls.filter(aloneFor(s.shas)).length, 0, "no `git log -1` per shipped commit");
    assert.equal(c.calls.filter(isTrailerLog).length, 1, "one `git log --grep` for every card, not one per card with no branch");
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("the processes a derive starts do not grow with the shipped branches or the cards with no branch (a doubled or per-card call fails this)", () => {
  const small = scratch(4), big = scratch(16);
  try {
    const a = counted(small), b = counted(big);
    collect({ config: cfg(small.repo), cards: cardsOf(4), git: a.git, gh: gh(small.main), now: 1 });
    collect({ config: cfg(big.repo), cards: cardsOf(16), git: b.git, gh: gh(big.main), now: 1 });
    const shape = (calls, shas) => ({ resolve: calls.filter(isResolve).length, alone: calls.filter(aloneFor(shas)).length, trailers: calls.filter(isTrailerLog).length, batchLogs: calls.filter((x) => x.includes("--no-walk=unsorted")).length });
    assert.deepEqual(shape(b.calls, big.shas), shape(a.calls, small.shas), "4x the shipped branches and cards starts the same number of those processes");
    assert.deepEqual(shape(b.calls, big.shas), { resolve: 1, alone: 0, trailers: 1, batchLogs: 1 });
    // A shipped card still asks 8 different things of git (4 `merge-base --is-ancestor`, a `rev-list`, a note, three `log`); it was 11 with
    // the repeats (a derive of 12 started 136 processes, now 100). A repeat coming back, or a new per-card question, goes over this.
    const perShipped = (big.shas.length - small.shas.length);
    assert.ok(b.calls.length - a.calls.length <= perShipped * 9, `${b.calls.length - a.calls.length} more processes for ${perShipped} more shipped cards`);
    for (const calls of [a.calls, b.calls]) assert.equal(new Set(calls.map((x) => JSON.stringify(x))).size, calls.length, "no question is asked of git twice in one derive");
  } finally { rmSync(small.dir, { recursive: true, force: true }); rmSync(big.dir, { recursive: true, force: true }); }
});

test("when git cannot answer a batch, each is asked alone and the derive is the same", () => {
  const s = scratch(6);
  try {
    const now = 7, cards = cardsOf(6);
    const normal = collect({ config: cfg(s.repo), cards, git: s.git, gh: gh(s.main), now });
    const refuse = (args) => {
      if (isResolve(args) && args.filter((x) => String(x).endsWith("^{commit}")).length > 1) throw new Error("no batch");
      if (args.includes("--no-walk=unsorted")) throw new Error("no batch");
      if (isTrailerLog(args) && args.includes("--grep=Board-Id: ")) throw new Error("no index");
      return s.git(args);
    };
    const c = { calls: [], git: (args) => { c.calls.push(args); return refuse(args); } };
    const alone = collect({ config: cfg(s.repo), cards, git: c.git, gh: gh(s.main), now });
    assert.deepEqual(alone.doc.cards, normal.doc.cards, "every card reads the same through the per-sha and per-card calls");
    assert.ok(c.calls.filter(aloneFor(s.shas)).length > 0 && c.calls.filter(isResolve).length > 1, "the fallback really ran");
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("resolveCommits: one process for the shas, a sha git cannot resolve is none, a plain-hex-only argument list, and a memo that is not asked twice", () => {
  const s = scratch(3);
  try {
    const calls = [];
    const git = (args) => { calls.push(args); return s.git(args); };
    const memo = new Map();
    resolveCommits(git, [s.shas[0].slice(0, 8), s.shas[1].slice(0, 8), s.shas[2].slice(0, 8)], memo);
    assert.equal(calls.length, 1);
    assert.deepEqual([...memo.values()], s.shas, "each short sha gives its full commit, in order");
    resolveCommits(git, [s.shas[0].slice(0, 8), s.shas[2].slice(0, 8)], memo);
    assert.equal(calls.length, 1, "a sha in the memo starts nothing");
    // One that does not exist stops the batch; the others are then asked alone and the missing one is null.
    const m2 = new Map(), c2 = [];
    resolveCommits((args) => { c2.push(args); return s.git(args); }, [s.shas[0].slice(0, 8), "deadbeef", s.shas[1].slice(0, 8)], m2);
    assert.deepEqual([m2.get(s.shas[0].slice(0, 8)), m2.get("deadbeef"), m2.get(s.shas[1].slice(0, 8))], [s.shas[0], null, s.shas[1]]);
    // Nothing that is not a hex sha is ever an argument (a subject's text must never look like an option).
    const c3 = [];
    resolveCommits((args) => { c3.push(args); return ""; }, ["--upload-pack=x", "ABCDEF1", "abc", "1234567"], new Map());
    assert.ok(c3.every((a) => a.every((x) => !String(x).startsWith("--upload") && !/ABCDEF1/.test(String(x)))));
    const heads = shippedHeads(s.git, mainLine(s.git, "origin", "main"), PATTERN);
    assert.deepEqual(new Set(heads.map((h) => h.sha)), new Set(s.shas), "shippedHeads gives the same heads through the batch");
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("commitMessages: one process for many commits, the same text as asking each alone, an unreadable sha is the empty message", () => {
  const s = scratch(4);
  try {
    const calls = [];
    const memo = commitMessages((args) => { calls.push(args); return s.git(args); }, s.shas, new Map());
    assert.equal(calls.length, 1);
    for (const sha of s.shas) assert.equal(memo.get(sha).trim(), s.git(["log", "-1", "--format=%B", sha]).trim());
    assert.match(memo.get(s.shas[2]), /Board-Id: ship2/);
    const bad = commitMessages(s.git, ["deadbeef00000000000000000000000000000000"], new Map());
    assert.equal(bad.get("deadbeef00000000000000000000000000000000"), "");
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("trailerIndex: each id's newest commit on main, the same head trailerOnMain gives alone; an id that only starts with another's is not it", () => {
  const s = scratch(5);
  try {
    // A later commit with the same trailer (a fix after the first): the newer one is the head. And ids that share a start.
    const g = (args) => execFileSync("git", args, { cwd: s.repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(join(s.repo, "again.md"), "again\n"); g(["add", "-A"]); g(["commit", "-qm", "ship2 again\n\nBoard-Id: ship2"]);
    writeFileSync(join(s.repo, "long.md"), "long\n"); g(["add", "-A"]); g(["commit", "-qm", "a longer id\n\nBoard-Id: ship2-longer"]);
    g(["push", "-q", "origin", "main"]);
    const index = trailerIndex(s.git, "origin", "main");
    for (const id of ["ship0", "ship2", "ship2-longer", "ship4", "review-one", "nobody"]) {
      assert.deepEqual(trailerOnMain(s.git, "origin", "main", id, index), trailerOnMain(s.git, "origin", "main", id), id);
    }
    assert.match(trailerOnMain(s.git, "origin", "main", "ship2", index).message, /ship2 again/, "the newest commit with the trailer");
    assert.equal(trailerOnMain(s.git, "origin", "main", "ship", index), null, "'ship' is no card's trailer: a longer id that starts with it is not it");
    assert.equal(trailerIndex(() => { throw new Error("git down"); }, "origin", "main"), null, "an index git cannot make is none, and each card is then asked alone");
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("memoGit: a repeated read is answered from memory (its error too), and a command that writes is never remembered", () => {
  const calls = [];
  let n = 0;
  const git = (args) => { calls.push(args); if (args[0] === "log" && args.includes("bad")) throw new Error("unknown revision"); return `${args.join(" ")} #${++n}`; };
  const m = memoGit(git);
  assert.equal(m(["merge-base", "--is-ancestor", "a", "b"]), m(["merge-base", "--is-ancestor", "a", "b"]));
  assert.notEqual(m(["merge-base", "--is-ancestor", "a", "b"]), m(["merge-base", "--is-ancestor", "b", "a"]), "other arguments are another question");
  assert.equal(calls.length, 2);
  assert.throws(() => m(["log", "bad"]), /unknown revision/);
  assert.throws(() => m(["log", "bad"]), /unknown revision/, "a failure is the answer too");
  assert.equal(calls.length, 3);
  // notes: only `show` reads. An add, a fetch or anything off the list goes to git every time.
  m(["notes", "--ref=r", "show", "sha"]); m(["notes", "--ref=r", "show", "sha"]);
  assert.equal(calls.length, 4, "a note shown twice is read once");
  m(["notes", "--ref=r", "add", "-m", "x", "sha"]); m(["notes", "--ref=r", "add", "-m", "x", "sha"]);
  m(["fetch", "-q", "origin"]); m(["fetch", "-q", "origin"]);
  assert.equal(calls.length, 8, "writes are never remembered");
  // Two memos are two runs: nothing is shared.
  memoGit(git)(["merge-base", "--is-ancestor", "a", "b"]);
  assert.equal(calls.length, 9);
});
