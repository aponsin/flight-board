// #C859 slice 2: the stack is read from git (collector/stack.mjs), never typed. A fake history stands in for git: each commit names its parent.
import test from "node:test";
import assert from "node:assert/strict";
import { readStack, stackFields } from "../collector/stack.mjs";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardStates, remoteTips, readStacks, stackHeads, mergedBranches, readStackCache, STACK_CACHE_FILE } from "../collector/state.mjs";
import { stacksOn } from "../collector/store-cards.mjs";
import { stateErrors } from "../collector/state-schema.mjs";

// parents: { sha: parentSha }. isAncestor(a, b): a is b or on b's first-parent line.
const history = (parents) => (a, b) => { for (let x = b; x; x = parents[x]) if (x === a) return true; return false; };
const P = { c1: "c0", c2: "c1", c3: "c2", c4: "c3", x1: "c0", c0: null };

test("three cards on one chain are one stack under the tip, in id order, with the tip and the size", () => {
  const s = readStack({ heads: { a: "c1", b: "c2", c: "c3" }, tips: [{ branch: "build/c", sha: "c3", at: 3 }, { branch: "build/b", sha: "c2", at: 2 }], isAncestor: history(P) });
  assert.deepEqual(s, { tip: "c3", branch: "build/c", members: ["a", "b", "c"], outside: [] });
  assert.deepEqual(stackFields(s), { a: { tip: "c3", size: 3, branch: "build/c" }, b: { tip: "c3", size: 3, branch: "build/c" }, c: { tip: "c3", size: 3, branch: "build/c" } });
  assert.deepEqual(stackFields({ ...s, branch: "--all" }).a, { tip: "c3", size: 3 }, "a branch name git could take for a flag is not carried");
});

test("a branch not cut from the stack tip is outside the stack, whoever built it", () => {
  const s = readStack({ heads: { a: "c1", b: "c2", z: "x1" }, tips: [{ branch: "build/b", sha: "c2", at: 2 }, { branch: "build/z", sha: "x1", at: 9 }], isAncestor: history(P) });
  assert.deepEqual(s.members, ["a", "b"]);
  assert.deepEqual(s.outside, ["z"]);
  assert.deepEqual(stackFields(s).z, { outside: true, branch: "build/b" });
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
  for (const id of ["card-one", "card-two", "card-three"]) assert.deepEqual(on[id].stack, { tip: three.slice(0, 12), tipSha: three, size: 3, branch: "build/stack" }, id); // tipSha: #C895, the whole sha for the DISPATCH line
  assert.deepEqual(on["card-four"].stack, { outside: true, branch: "build/stack" });
  assert.deepEqual(["card-one", "card-two", "card-three"].map((id) => on[id].headSha12 !== null), [true, true, true], "the middle card is read at its own commit too");
  assert.deepEqual(stateErrors({ v: 1, id: "t", cards: { k: { ...on["card-two"] } } }).filter((e) => /stack/.test(e)), [], "the field passes the schema");
});

test("the switch reaches the probe through stacks.json: the board row on is [\"\"], anything else is off, and a stale or odd file is off", () => {
  assert.deepEqual(stacksOn([{ repo: "board", stack: true }, { repo: "product", stack: false }]), [""], "the view's rows carry a boolean");
  assert.deepEqual(stacksOn([{ repo: "board", stack: false }, { repo: "product", stack: true }]), [], "the product's switch is its own card");
  assert.deepEqual(stacksOn(undefined), []);
  const NOW2 = 5_000_000;
  const file = (f) => () => ({ whole: true, text: JSON.stringify(f) });
  assert.deepEqual(readStacks("d", NOW2, file({ at: NOW2 - 1000, stacks: [""] })), [""]);
  assert.deepEqual(readStacks("d", NOW2, file({ at: NOW2 - 31 * 60e3, stacks: [""] })), [], "older than 30 minutes");
  assert.deepEqual(readStacks("d", NOW2, file({ at: NOW2, stacks: "x" })), []);
  assert.deepEqual(readStacks("d", NOW2, () => null), []);
  assert.deepEqual(readStacks("d", NOW2, () => { throw new Error("none"); }), []);
});

function chain() {
  const s = scratch();
  s.g(["checkout", "-qb", "build/stack"]);
  const one = s.commit(10, "a.md", "card-one"); s.commit(20, "b.md", "card-two"); const three = s.commit(30, "c.md", "card-three");
  s.g(["checkout", "-q", "main"]);
  s.sync();
  const run = () => cardStates({ cards: ["card-one", "card-two", "card-three"].map((id) => ({ id })), config: cfg, repos: { "": s.repo() }, now: (T0 + 100) * 1000, stacks: [""] });
  return { s, one, three, run };
}

test("a note on the stack tip signs every card under it (design 4); without the switch the notes stay the card's own", () => {
  const { s, three, run } = chain();
  for (const [phase, ref] of Object.entries(cfg.collector.notes)) s.g(["notes", `--ref=${ref}`, "add", "-m", phase === "security" ? "SECURE" : "PASS", three]); // #C1163: each role signs with its own word
  const on = run();
  for (const id of ["card-one", "card-two", "card-three"]) assert.deepEqual(on[id].signed, ["checker", "security"], id);
  const off = cardStates({ cards: ["card-one", "card-two", "card-three"].map((id) => ({ id })), config: cfg, repos: { "": s.repo() }, now: (T0 + 100) * 1000 });
  assert.deepEqual(off["card-three"].signed, ["checker", "security"], "the tip's own card");
  assert.deepEqual(off["card-one"].signed, [], "a card under it, switch off: not covered");
});

test("FINDINGS on the tip beats a PASS on a card's own commit: no card under the tip reads as signed by that review", () => {
  const { s, one, three, run } = chain();
  s.g(["notes", "--ref=refs/notes/checker", "add", "-m", "PASS", one]);
  s.g(["notes", "--ref=refs/notes/checker", "add", "-m", "FINDINGS F1 something", three]);
  const on = run();
  assert.deepEqual(on["card-one"].signed, [], "card-one's own PASS is overruled");
  assert.deepEqual(on["card-two"].findings, ["checker"]);
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

// #C1311 (Manager, 11-19: the stack read took 15 s quiet and 38 s with a suite, one git call per branch tip and per head): the answer is the same, with far fewer calls.
function counted(s) {
  const calls = [];
  const repo = () => ({ ...s.repo(), git: (args) => { calls.push(args.join(" ")); return s.g(args); } });
  const n = (re) => calls.filter((c) => re.test(c)).length;
  return { calls, repo, n, clear: () => { calls.length = 0; } };
}
function manyBranches() {
  const s = scratch();
  s.g(["checkout", "-qb", "build/old"]);
  s.commit(5, "o.md", "card-old");
  s.g(["checkout", "-q", "main"]); s.g(["merge", "-q", "--ff-only", "build/old"]); // merged into main: its log beyond main is empty
  s.g(["checkout", "-qb", "build/stack"]);
  s.commit(10, "a.md", "card-one"); s.commit(20, "b.md", "card-two"); const three = s.commit(30, "c.md", "card-three");
  s.g(["checkout", "-q", "main"]); s.g(["checkout", "-qb", "build/card-four"]);
  s.commit(40, "d.md", "card-four");
  s.g(["checkout", "-q", "main"]);
  s.sync();
  return { s, three };
}
const OPEN = new Set(["card-one", "card-two", "card-three", "card-four"]);
const tipsOf = (repo) => repo.tips.filter((t) => t.branch !== repo.main);

test("a branch merged into main is never asked for its log; the heads are the same as when every branch is asked", () => {
  const { s } = manyBranches();
  const c = counted(s);
  const repo = c.repo();
  assert.ok(mergedBranches(repo).has("build/old"), "the merged branch is found");
  assert.ok(!mergedBranches(repo).has("build/stack"), "an unmerged one is not");
  c.clear();
  const heads = stackHeads(repo, tipsOf(repo), OPEN);
  assert.equal(c.n(/^log .*origin\/build\/old /), 0, "no log for the merged branch");
  assert.equal(c.n(/^log /), 2, "one log per unmerged branch (build/stack and build/card-four)");
  // the same answer as an unfiltered read: a git that cannot list merged branches asks them all
  const plain = stackHeads({ ...repo, git: (a) => { if (a[0] === "for-each-ref" && a.includes("--merged")) throw new Error("no"); return s.g(a); } }, tipsOf(repo), OPEN);
  assert.deepEqual(heads, plain);
  assert.deepEqual(Object.keys(heads).sort(), ["card-four", "card-one", "card-three", "card-two"]);
});

test("the cache: a branch that has not moved is not asked again; a moved tip, a moved main and a gone branch each act on their own", () => {
  const { s } = manyBranches();
  const c = counted(s);
  let cache = { old: {}, next: {} };
  const run = () => { const repo = c.repo(); c.clear(); const h = stackHeads(repo, tipsOf(repo), OPEN, cache); cache = { old: cache.next, next: {} }; return h; };
  const first = run();
  assert.equal(c.n(/^log /), 2, "cold: both unmerged branches are asked");
  assert.deepEqual(run(), first, "warm: the same heads");
  assert.equal(c.n(/^log /), 0, "warm: nothing is asked");
  // a tip that moved is asked, the other is not
  s.g(["checkout", "-q", "build/card-four"]); s.commit(50, "d.md", "card-four"); s.g(["checkout", "-q", "main"]); s.sync();
  const moved = run();
  assert.equal(c.n(/^log .*origin\/build\/card-four /), 1, "the moved tip is asked");
  assert.equal(c.n(/^log .*origin\/build\/stack /), 0, "the one that did not move is not");
  assert.notEqual(moved["card-four"].sha, first["card-four"].sha, "the newer commit is the head");
  // main moved: the log beyond main can change, so every unmerged branch is asked again
  s.commit(60, "m.md", "card-main"); s.sync();
  run();
  assert.equal(c.n(/^log /), 2, "main moved: both are asked again");
  // a branch that is gone drops out of the cache
  s.g(["push", "-q", "origin", "--delete", "build/card-four"]); s.g(["fetch", "-q", "--prune", "origin"]);
  run();
  assert.deepEqual(Object.keys(cache.old).sort(), ["build/stack"], "the gone branch is no longer kept");
});

test("through cardStates the cache gives the same readings as no cache, and the second run asks git for no log", () => {
  const { s } = manyBranches();
  const c = counted(s);
  const cards = [...OPEN].map((id) => ({ id }));
  const run = (stackCache) => cardStates({ cards, config: cfg, repos: { "": c.repo() }, now: (T0 + 100) * 1000, stacks: [""], ...(stackCache ? { stackCache } : {}) });
  const bare = run(null);
  const cache = { old: {}, next: {} };
  assert.deepEqual(run(cache), bare, "cold cache: the same");
  c.clear();
  const warm = { old: cache.next, next: {} };
  assert.deepEqual(run(warm), bare, "warm cache: the same");
  assert.equal(c.n(/^log .*--not /), 0, "warm: no branch log");
  assert.deepEqual(Object.keys(warm.next[""]).sort(), ["build/card-four", "build/stack"], "the file's content for the repository: each branch read");
  // a branch that is gone is dropped from what the run keeps
  s.g(["push", "-q", "origin", "--delete", "build/card-four"]); s.g(["fetch", "-q", "--prune", "origin"]);
  const after = { old: warm.next, next: {} };
  run(after);
  assert.deepEqual(Object.keys(after.next[""]), ["build/stack"], "the gone branch is not kept");
});

test("the stack asks git for the branches that hold a head once per head: more branch tips add no merge-base and no --contains call", () => {
  const { s } = manyBranches();
  const cards = [...OPEN].map((id) => ({ id }));
  const mergeBases = (stacks) => { const c = counted(s); cardStates({ cards, config: cfg, repos: { "": c.repo() }, now: (T0 + 100) * 1000, stacks }); return { mb: c.n(/^merge-base --is-ancestor/), contains: c.n(/^for-each-ref --contains /) }; };
  const few = mergeBases([""]);
  assert.ok(few.contains >= 1 && few.contains <= OPEN.size, "one --contains per head at most");
  // six more branches (tips) from main with other cards' commits: the old reading asked merge-base once per tip per head, so it grew with them
  for (let i = 1; i <= 6; i++) { s.g(["checkout", "-qb", `build/other-${i}`]); s.commit(100 + i, `o${i}.md`, `other-${i}`); s.g(["checkout", "-q", "main"]); }
  s.sync();
  const many = mergeBases([""]);
  assert.equal(many.mb, few.mb, "more branch tips add no merge-base call");
  assert.equal(many.contains, few.contains, "nor a --contains call");
});

test("a held card is checked against the stack-ready notes in one rev-list: more noted commits add no merge-base call, and a covered card is not held", () => {
  const LATE = 4_500_000; // seconds after T0: past STACK_HOLD_FROM, so a pushed card with no signal is held
  const s = scratch();
  const c = counted(s);
  const note = (sha) => s.g(["notes", "--ref=refs/notes/flight-board/stack-ready", "add", "-f", "-m", "stack-ready\n2026-11-20T00:00:00Z", sha]);
  const branch = (name, id, t) => { s.g(["checkout", "-qb", name]); const sha = s.commit(LATE + t, `${id}.md`, id); s.g(["checkout", "-q", "main"]); return sha; };
  branch("build/one", "card-one", 1); branch("build/two", "card-two", 2);
  // each other branch has a second commit, so the noted (first) one is under a tip and no tip itself: asked of git as a commit, not of the tips
  const others = ["x1", "x2", "x3", "x4", "x5", "x6"].map((id, i) => { s.g(["checkout", "-qb", `build/${id}`]); const sha = s.commit(LATE + 10 + i, `${id}.md`, id); s.commit(LATE + 20 + i, `${id}b.md`, id); s.g(["checkout", "-q", "main"]); return sha; });
  s.sync();
  const cards = [{ id: "card-one" }, { id: "card-two" }];
  const run = () => { c.clear(); const out = cardStates({ cards, config: cfg, repos: { "": c.repo() }, now: (T0 + LATE + 100) * 1000, stacks: [""] }); return { out, mb: c.n(/^merge-base --is-ancestor/) }; };
  const none = run();
  assert.equal(none.out["card-one"].stackHold, true, "control: with no note anywhere the pushed card is held");
  for (const sha of others) note(sha);
  const six = run();
  assert.equal(six.out["card-one"].stackHold, true, "six notes on other cards' commits do not cover it");
  assert.ok(six.mb <= none.mb, `six more noted commits add no merge-base call (${none.mb} then ${six.mb})`);
  note(s.g(["rev-parse", "origin/build/one"]).trim());
  assert.equal(run().out["card-one"].stackHold, undefined, "a note on the card's own commit covers it");
  assert.equal(run().out["card-two"].stackHold, true, "and not the card beside it");
});

// Checker 2's F1 on 5883807e: a stack-ready note stays on a build branch's head after the branch is re-cut (-v2, -v3), deleted and pruned, so a noted commit git no longer
// has is the common case. One such commit used to fail the whole rev-list; the fallback (a question per noted commit) was untested.
test("a noted commit git no longer has does not stop the check: a head under another noted commit is still covered, on the fast path and on the fallback", () => {
  const LATE = 4_500_000;
  const s = scratch();
  const note = (sha) => s.g(["notes", "--ref=refs/notes/flight-board/stack-ready", "add", "-f", "-m", "stack-ready\n2026-11-20T00:00:00Z", sha]);
  const branch = (name, id, t) => { s.g(["checkout", "-qb", name]); const sha = s.commit(LATE + t, `${id}.md`, id); s.g(["checkout", "-q", "main"]); return sha; };
  const gone = branch("build/gone", "card-gone", 5), one = branch("build/one", "card-one", 1); branch("build/two", "card-two", 2);
  s.sync();
  note(gone); note(one);
  // the re-cut branch is deleted and pruned: git has no such commit, and the note still lists it
  s.g(["push", "-q", "origin", "--delete", "build/gone"]); s.g(["fetch", "-q", "--prune", "origin"]); s.g(["branch", "-qD", "build/gone"]);
  s.g(["reflog", "expire", "--expire=now", "--all"]); s.g(["gc", "-q", "--prune=now"]);
  assert.throws(() => s.g(["cat-file", "-e", `${gone}^{commit}`]), "control: git no longer has the noted commit");
  assert.ok(s.g(["notes", "--ref=refs/notes/flight-board/stack-ready", "list"]).includes(gone), "control: the note still lists it");
  const cards = [{ id: "card-one" }, { id: "card-two" }];
  const run = (git) => { const calls = []; const repo = { ...s.repo(), git: (a) => { calls.push(a.join(" ")); return git(a); } }; return { out: cardStates({ cards, config: cfg, repos: { "": repo }, now: (T0 + LATE + 100) * 1000, stacks: [""] }), calls }; };
  const fast = run((a) => s.g(a));
  assert.equal(fast.out["card-one"].stackHold, undefined, "fast path: the card whose commit is noted is covered");
  assert.equal(fast.out["card-two"].stackHold, true, "fast path: the card beside it is still held");
  assert.ok(fast.calls.some((c) => c.startsWith("rev-list --ignore-missing")), "the one rev-list is asked");
  assert.equal(fast.calls.some((c) => c.startsWith("merge-base") && c.includes(gone)), false, "fast path: the missing commit is not asked of git one by one");
  const slow = run((a) => { if (a[0] === "rev-list" && a.includes("--ignore-missing")) throw new Error("bad object"); return s.g(a); });
  assert.equal(slow.out["card-one"].stackHold, undefined, "fallback: the card whose commit is noted is covered");
  assert.equal(slow.out["card-two"].stackHold, true, "fallback: the card beside it is still held");
  assert.ok(slow.calls.some((c) => c.startsWith("merge-base") && c.includes(gone)), "control: the fallback does ask per noted commit");
});

test("the cache file: only its own shape comes back, a bad entry is dropped, a bad file is an empty cache", () => {
  const k = `${"a".repeat(40)}:${"b".repeat(40)}`, rec = { sha: "c".repeat(40), at: 5, message: "x\n\nBoard-Id: card-one" };
  const file = (text) => () => ({ whole: true, text });
  const good = JSON.stringify({ v: 1, repos: { "": { "build/stack": { key: k, recs: [rec] } } } });
  assert.deepEqual(readStackCache("d", file(good)), { "": { "build/stack": { key: k, recs: [rec] } } });
  assert.deepEqual(readStackCache("d", file(JSON.stringify({ v: 1, repos: { "": { x: { key: "no", recs: [rec] }, y: { key: k, recs: [{ sha: "short", at: 1, message: "m" }] }, z: { key: k, recs: "no" } } } }))), { "": {} }, "a bad key, a bad record and a non-list are each dropped");
  for (const bad of ["{", JSON.stringify({ v: 2, repos: {} }), JSON.stringify([]), JSON.stringify({ v: 1, repos: [] })]) assert.deepEqual(readStackCache("d", file(bad)), {}, bad);
  assert.deepEqual(readStackCache("d", () => null), {});
  assert.deepEqual(readStackCache("d", () => { throw new Error("none"); }), {});
  assert.equal(STACK_CACHE_FILE, "stack-heads-cache.json");
});
