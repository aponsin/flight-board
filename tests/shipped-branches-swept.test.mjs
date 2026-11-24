// #C1112: shipped branches are listed and deleted through one weekly Terminal ask made by the board. The probe lists, for each configured repository, the remote
// and local branches whose tip is already on main (never main or dev, never a branch with commits of its own, never an open card's branch, tied to the card as
// the board does: by name, by Board-Id trailer or by "#C<n>:" subject) as branches.shipped; the store raises ONE Terminal ask a week from it with the delete lines,
// each remote delete leased on the sha the probe saw. Real git; fictional repository and names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { shippedBranchesWrite, sweepRepos, plainBranch, SWEEP_GIT_MAX_BUFFER } from "../collector/shipped-branches.mjs";
import { evidenceJob } from "../collector/probe-evidence.mjs";
import { shippedBranchesShape, sweepAsk, askRefusal, evidenceRefusal, SWEEP_TITLE } from "../worker/board-rules.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { writeEvidence, syncBranchSweep, wakeAsk } from "../worker/board-store.mjs";

const T = 1_800_000_000_000, DAY = 86_400_000, H = 3_600_000;
const cfgOf = (collector) => JSON.stringify({ collector });
const CFG = cfgOf({ repoPath: "~/Code/demo-repo", remote: "origin", mainBranch: "main" });
const S1 = "1".repeat(40), S2 = "2".repeat(40);
const rb = (...names) => names.map((name, i) => ({ name, sha: String(i + 1).repeat(40) }));

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-sweep-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const branch = (name, { merge, message }) => {
    g(["checkout", "-qb", name]); writeFileSync(join(work, `${name.replace(/\//g, "_")}.md`), "x\n"); g(["add", "-A"]); g(["commit", "-qm", message ?? name]);
    g(["checkout", "-q", "main"]);
    if (merge) g(["merge", "-q", "--no-ff", "-m", `merge ${name}`, name]);
  };
  branch("build/shipped-one", { merge: true });
  branch("build/shipped-two", { merge: true });
  branch("build/still-open", { merge: true });
  // The board ties a branch to a card by its Board-Id trailer and by a "#C<n>:" subject too (collector/derive.mjs headsFor), whatever the branch is called.
  branch("build/renamed-v2", { merge: true, message: "Work\n\nBoard-Id: some-open-card" });
  branch("build/c980-smoke-ignored", { merge: true, message: "#C980: smoke test ignored" });
  branch("build/unmerged", { merge: false });
  branch("dev", { merge: true });
  g(["commit", "-q", "--allow-empty", "-m", "main moves on"]); // so the merged branches are no longer main's tip
  g(["branch", "fresh-cut"]); // a branch cut at main's tip: nothing of its own yet
  g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]);
  const git = (_r, args) => g(args);
  return Object.assign(git, { work, bare, g });
}
const names = (l) => l.map((b) => (typeof b === "string" ? b : b.name)).sort();
const OPEN = ["still-open", { id: "some-open-card", num: 111 }, { id: "smoke-card", num: 980 }];

test("the listing: remote and local branches whose tip is on main; not main or dev, not a branch with commits of its own, not an open card's, not one cut at main's tip", () => {
  const git = scratch();
  const v = shippedBranchesWrite(CFG, { git, openIds: OPEN, now: T }).value;
  assert.equal(v.at, T);
  assert.equal(v.repos.length, 1);
  const r = v.repos[0];
  assert.deepEqual([r.name, r.dir, r.remote, r.main], ["demo-repo", "~/Code/demo-repo", "origin", "main"]);
  assert.deepEqual(names(r.remoteBranches), ["build/shipped-one", "build/shipped-two"]);
  assert.deepEqual(names(r.localBranches), ["build/shipped-one", "build/shipped-two"]);
  for (const b of r.remoteBranches) assert.equal(b.sha, git(null, ["rev-parse", `refs/remotes/origin/${b.name}`]).trim(), "the remote branch's own tip, for the lease");
  assert.equal(shippedBranchesShape(v), true, "what the probe posts is what the store accepts");
  const all = JSON.stringify(v);
  for (const never of ["build/unmerged", "build/still-open", "dev", "fresh-cut"]) assert.ok(!all.includes(`"${never}"`), never);
  assert.ok(!names(r.remoteBranches).includes("main") && !r.localBranches.includes("main") && !names(r.remoteBranches).includes("HEAD"));
});

test("an open card keeps its branch however the board ties them: by the Board-Id trailer of the tip or by a '#C<n>:' subject, not only by the branch's name (Checker 2's M1)", () => {
  const git = scratch();
  const listed = (open) => names(shippedBranchesWrite(CFG, { git, openIds: open, now: T }).value.repos[0].remoteBranches);
  assert.ok(listed(["still-open"]).includes("build/renamed-v2"), "with no card named by the trailer, it is listed");
  assert.ok(listed(["still-open"]).includes("build/c980-smoke-ignored"));
  assert.ok(!listed([{ id: "some-open-card", num: 111 }]).includes("build/renamed-v2"), "the trailer names an open card: kept");
  assert.ok(!listed([{ id: "some-open-card" }]).includes("build/renamed-v2"), "a card with no number is still tied by its id");
  assert.ok(!listed([{ id: "smoke-card", num: 980 }]).includes("build/c980-smoke-ignored"), "the subject names an open card's number: kept");
  assert.ok(listed([{ id: "smoke-card", num: 981 }]).includes("build/c980-smoke-ignored"), "another number: listed");
  assert.ok(listed([{ id: "smoke-card" }]).includes("build/c980-smoke-ignored"), "an open card with no number keeps nothing by subject");
  const local = names(shippedBranchesWrite(CFG, { git, openIds: [{ id: "some-open-card", num: 111 }, { id: "smoke-card", num: 980 }], now: T }).value.repos[0].localBranches);
  assert.ok(!local.includes("build/renamed-v2") && !local.includes("build/c980-smoke-ignored"), "the local branches too");
});

test("with no card open, the card branch is listed too; a repository with nothing to delete is left out", () => {
  const git = scratch();
  assert.deepEqual(names(shippedBranchesWrite(CFG, { git, openIds: [], now: T }).value.repos[0].remoteBranches), ["build/c980-smoke-ignored", "build/renamed-v2", "build/shipped-one", "build/shipped-two", "build/still-open"]);
  assert.deepEqual(shippedBranchesWrite(CFG, { git: () => "", openIds: [], now: T, log: () => {} }).value.repos, [], "a git that lists nothing gives no repository");
});

test("at most 60 branches of each kind are posted, so the Worker never refuses the whole list for a long one (Checker 2's LOW 1)", () => {
  const tip = "a".repeat(40);
  const many = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}b${i}\x1f${String(i % 10).repeat(40)}\x1fmsg\x1e`).join("");
  const git = (_r, args) => (args[0] === "rev-parse" ? tip : args.at(-1).startsWith("refs/remotes/") ? many("refs/remotes/origin/", 75) : many("refs/heads/", 70));
  const v = shippedBranchesWrite(CFG, { git, openIds: [], now: T }).value;
  assert.deepEqual([v.repos[0].remoteBranches.length, v.repos[0].localBranches.length], [60, 60]);
  assert.equal(shippedBranchesShape(v), true);
});

test("a repository git cannot read is left out and logged; the others are still listed", () => {
  const git = scratch(), logs = [];
  const two = cfgOf({ repoPath: "~/Code/demo-repo", repos: [{ name: "other", path: "~/Code/other" }] });
  const v = shippedBranchesWrite(two, { git: (r, args) => { if (r.name === "demo-repo") throw new Error("not a repository\nmore"); return git(r, args); }, openIds: [], now: T, log: (l) => logs.push(l) }).value;
  assert.deepEqual(v.repos.map((r) => r.name), ["other"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /demo-repo could not be read: not a repository$/);
});

// #C1124 (Security's INFO I1 on 5ac5d9df): git's output past the buffer must read as a plain "cut" and sweep nothing for that repository, never a partial list.
test("git output past the buffer: the repository is left out and the log says the output was cut; the other repository is still listed", () => {
  const git = scratch(), logs = [];
  const two = cfgOf({ repoPath: "~/Code/demo-repo", repos: [{ name: "other", path: "~/Code/other" }] });
  let real;
  try { execFileSync("git", ["--version"], { encoding: "utf8", maxBuffer: 1 }); } catch (e) { real = e; } // the error Node really throws on an overflow
  assert.ok(real, "a 1-byte buffer overflows");
  const v = shippedBranchesWrite(two, { git: (r, args) => { if (r.name === "demo-repo" && args[0] === "for-each-ref") throw real; return git(r, args); }, openIds: [], now: T, log: (l) => logs.push(l) }).value;
  assert.deepEqual(v.repos.map((r) => r.name), ["other"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /demo-repo git's output was longer than the \d+-byte buffer and was cut: nothing was swept for it$/);
  assert.doesNotMatch(logs[0], /could not be read/);
});

test("the sweep's real git reader runs with the big buffer, far above Node's 1 MB default", () => {
  assert.ok(SWEEP_GIT_MAX_BUFFER >= 16 * 1024 * 1024);
  assert.match(readFileSync(new URL("../collector/probe-evidence.mjs", import.meta.url), "utf8"), /const defaultSweepGit = [^\n]*maxBuffer: SWEEP_GIT_MAX_BUFFER/);
});

test("the config: only a ~/ folder with plain words is listed; none or an unreadable config posts nothing", () => {
  assert.deepEqual(sweepRepos(cfgOf({ repoPath: "/abs/path" })), [], "an absolute folder has no ~/ form for the owner's Terminal line");
  assert.deepEqual(sweepRepos(cfgOf({ repoPath: "~/a b" })), []);
  assert.deepEqual(sweepRepos(cfgOf({ repoPath: "~/../etc" })), []);
  assert.deepEqual(sweepRepos(cfgOf({ repoPath: "~/Code/x", remote: "o;rm", mainBranch: "$(x)" })).map((r) => [r.remote, r.main]), [["origin", "main"]], "a bad remote or main falls back, it never reaches a line");
  assert.equal(sweepRepos("not json", () => {}), null);
  assert.equal(shippedBranchesWrite("{}", { git: () => "", openIds: [], now: T }), null);
  assert.equal(sweepRepos(cfgOf({ repoPath: "~/a", repos: Array.from({ length: 9 }, (_, i) => ({ name: `r${i}`, path: `~/r${i}` })) })).length, 6);
  assert.deepEqual(["a/b", "a.b-c_d", "x"].map(plainBranch), [true, true, true]);
  assert.deepEqual(["-x", "a b", "a;b", "a$b", "a..b", "a/", "a.lock", "", "a\nb"].map(plainBranch), Array(9).fill(false));
});

test("the store accepts the shape and refuses anything else: plain names, a ~/ folder, 6 repositories and 60 branches at most, never main, master, dev or HEAD", () => {
  const good = { at: T, repos: [{ name: "demo-repo", dir: "~/Code/demo-repo", remote: "origin", main: "main", remoteBranches: rb("build/a"), localBranches: [] }] };
  assert.equal(shippedBranchesShape(good), true);
  assert.equal(evidenceRefusal("branches.shipped", good, "probe"), null);
  const r = good.repos[0];
  const withR = (over) => ({ at: T, repos: [{ ...r, ...over }] });
  const bad = [null, [], { at: T }, { at: "x", repos: [] }, { at: T, repos: "x" }, { ...good, extra: 1 }, { at: T, repos: Array.from({ length: 7 }, () => r) },
    withR({ dir: "/abs" }), withR({ dir: "~/a b" }), withR({ dir: "~/../x" }), withR({ name: "a b" }), withR({ remote: "o;x" }), withR({ main: undefined }), withR({ main: "a b" }),
    withR({ remoteBranches: [{ name: "a b", sha: S1 }] }), withR({ remoteBranches: [{ name: "a;rm -rf x", sha: S1 }] }), withR({ localBranches: ["-D"] }), withR({ localBranches: ["a", "a"] }),
    withR({ remoteBranches: [{ name: "a", sha: S1 }, { name: "a", sha: S2 }] }),
    withR({ remoteBranches: Array.from({ length: 61 }, (_, i) => ({ name: `b${i}`, sha: S1 })) }), withR({ localBranches: Array.from({ length: 61 }, (_, i) => `b${i}`) }), withR({ remoteBranches: "x" }),
    withR({ prompt: "extra" }), withR({ localBranches: undefined }),
    // a remote branch is { name, sha } with the full tip, and nothing else
    withR({ remoteBranches: ["build/a"] }), withR({ remoteBranches: [{ name: "build/a" }] }), withR({ remoteBranches: [{ name: "build/a", sha: "abc" }] }), withR({ remoteBranches: [{ name: "build/a", sha: "A".repeat(40) }] }),
    withR({ remoteBranches: [{ name: "build/a", sha: `${S1}` , extra: 1 }] }), withR({ remoteBranches: [{ name: "build/a", sha: `${S1} --force` }] }),
    ...[";", "$", "|", "&", "'", "\"", "`", "(", ">", "*"].map((c) => withR({ remoteBranches: [{ name: `a${c}b`, sha: S1 }] })),
    // Security's L1: the never-list is the Worker's too
    ...["main", "master", "dev", "HEAD"].flatMap((n) => [withR({ remoteBranches: [{ name: n, sha: S1 }] }), withR({ localBranches: [n] })]),
    withR({ main: "trunk", remoteBranches: [{ name: "trunk", sha: S1 }] }), withR({ main: "trunk", localBranches: ["trunk"] })];
  for (const v of bad) assert.equal(shippedBranchesShape(v), false, JSON.stringify(v));
  assert.equal(shippedBranchesShape(withR({ main: "trunk", remoteBranches: rb("main-fix", "development", "build/dev") })), true, "a name that only contains a never-word is fine");
  assert.notEqual(evidenceRefusal("branches.shipped", bad[3], "probe"), null, "a bad value is refused");
  assert.notEqual(evidenceRefusal("branches.shipped", good, "agent"), null, "only the probe writes evidence");
  assert.equal(sweepAsk(withR({ remoteBranches: [{ name: "dev", sha: S1 }] })), null, "a bad probe reading never makes a delete line for dev");
});

test("the ask: one delete line per 5 remote branches and per 5 local ones, each with its own folder, remote delete leased on the sha seen; the Worker accepts it as a Terminal ask (#T2273: 15 in a line was too long to paste whole)", () => {
  const list = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const remote = list(31, "r").map((name, i) => ({ name, sha: String(i % 10).repeat(40) }));
  const v = { at: T, repos: [{ name: "demo-repo", dir: "~/Code/demo-repo", remote: "origin", main: "main", remoteBranches: remote, localBranches: list(7, "l") }, { name: "other", dir: "~/Code/other", remote: "up", main: "main", remoteBranches: [], localBranches: ["x"] }] };
  const ask = sweepAsk(v);
  assert.equal(ask.title, `${SWEEP_TITLE}: 39 on main already`);
  assert.equal(ask.commands.length, 7 + 2 + 1, "31 remote = six lines of 5 and one of 1; 7 local = 5 and 2; one more folder");
  const line = (chunk) => `git -C ~/Code/demo-repo push origin ${chunk.map((b) => `--force-with-lease=${b.name}:${b.sha}`).join(" ")} --delete ${chunk.map((b) => b.name).join(" ")}`;
  for (let k = 0; k < 6; k++) assert.equal(ask.commands[k], line(remote.slice(k * 5, k * 5 + 5)), `remote line ${k + 1} holds 5`);
  assert.equal(ask.commands[6], line(remote.slice(30)), "the last chunk holds the remaining one");
  assert.equal(ask.commands[7], "git -C ~/Code/demo-repo branch -d l0 l1 l2 l3 l4");
  assert.equal(ask.commands[8], "git -C ~/Code/demo-repo branch -d l5 l6");
  assert.equal(ask.commands[9], "git -C ~/Code/other branch -d x");
  assert.equal(askRefusal({ type: "Terminal", title: ask.title, asked_by: "Manager", commands: ask.commands }, T), null, "the ask rules take it (no bare cd, every line alone)");
  assert.equal(sweepAsk({ at: T, repos: [] }), null);
  assert.equal(sweepAsk({ at: T, repos: [{ ...v.repos[0], remoteBranches: [], localBranches: [] }] }), null);
  assert.equal(sweepAsk({ at: T, repos: "x" }), null, "a bad value makes no ask");
});

test("the delete line works with real git, and a branch pushed again since the listing is NOT deleted (Checker 2's LOW 2)", () => {
  const git = scratch();
  const v = shippedBranchesWrite(CFG, { git, openIds: OPEN, now: T }).value;
  const asRun = (cmd) => cmd.replace("~/Code/demo-repo", git.work);
  const [one, two] = ["build/shipped-one", "build/shipped-two"].map((n) => ({ ...v, repos: [{ ...v.repos[0], remoteBranches: v.repos[0].remoteBranches.filter((b) => b.name === n), localBranches: [] }] }));
  const remoteHas = (n) => execFileSync("git", ["ls-remote", "--heads", git.bare, n], { encoding: "utf8" }).trim() !== "";
  // another clone pushes build/shipped-two again after the listing
  git.g(["checkout", "-q", "build/shipped-two"]); writeFileSync(join(git.work, "again.md"), "more\n"); git.g(["add", "-A"]); git.g(["commit", "-qm", "work started again"]); git.g(["push", "-q", "origin", "build/shipped-two"]); git.g(["checkout", "-q", "main"]);
  assert.throws(() => execFileSync("sh", ["-c", asRun(sweepAsk(two).commands[0])], { stdio: "pipe" }), /stale info|rejected|failed/i, "the lease on the old tip refuses");
  assert.equal(remoteHas("build/shipped-two"), true, "the branch pushed again is still there");
  execFileSync("sh", ["-c", asRun(sweepAsk(one).commands[0])], { stdio: "pipe" });
  assert.equal(remoteHas("build/shipped-one"), false, "the untouched shipped branch is deleted");
});

const GOOD = { at: T, repos: [{ name: "demo-repo", dir: "~/Code/demo-repo", remote: "origin", main: "main", remoteBranches: rb("build/a", "build/b"), localBranches: ["build/a"] }] };
const asksOf = async (db) => (await db.prepare("SELECT id, type, title, asked_by, body, closed_at, created_at FROM asks ORDER BY created_at").all()).results;

test("the store raises ONE Terminal ask from a fresh list, asked as the lead, and not again while it is open or for a week after it closed", async () => {
  const db = makeDb();
  await writeEvidence(db, T, "probe", "branches.shipped", GOOD);
  const made = await syncBranchSweep(db, T + 1000);
  assert.equal(made.ok, true);
  let asks = await asksOf(db);
  assert.equal(asks.length, 1);
  assert.deepEqual([asks[0].type, asks[0].asked_by], ["Terminal", "Manager"]);
  assert.match(asks[0].title, /^Shipped branches to delete: 3 on main already$/);
  assert.deepEqual(JSON.parse(asks[0].body).commands, [`git -C ~/Code/demo-repo push origin --force-with-lease=build/a:${"1".repeat(40)} --force-with-lease=build/b:${"2".repeat(40)} --delete build/a build/b`, "git -C ~/Code/demo-repo branch -d build/a"]);
  await writeEvidence(db, T + 2 * H, "probe", "branches.shipped", { ...GOOD, at: T + 2 * H });
  assert.equal(await syncBranchSweep(db, T + 2 * H), null, "open: no second one");
  await db.prepare("UPDATE asks SET closed_at = ? WHERE id = ?").bind(T + 3 * H, asks[0].id).run();
  await writeEvidence(db, T + 3 * H, "probe", "branches.shipped", { ...GOOD, at: T + 3 * H });
  assert.equal(await syncBranchSweep(db, T + 3 * H), null, "closed 3 hours ago: not within a week");
  await writeEvidence(db, T + 6 * DAY, "probe", "branches.shipped", { ...GOOD, at: T + 6 * DAY });
  assert.equal(await syncBranchSweep(db, T + 6 * DAY), null, "6 days after the first");
  await writeEvidence(db, T + 8 * DAY, "probe", "branches.shipped", { ...GOOD, at: T + 8 * DAY });
  assert.equal((await syncBranchSweep(db, T + 8 * DAY)).ok, true, "a week after, a new ask");
  assert.equal((await asksOf(db)).length, 2);
});

test("a sweep ask still open after more than a week is not asked again: none while one is open, however old (Checker 2's M2)", async () => {
  const db = makeDb();
  await writeEvidence(db, T, "probe", "branches.shipped", GOOD);
  assert.equal((await syncBranchSweep(db, T + 1000)).ok, true);
  await writeEvidence(db, T + 8 * DAY, "probe", "branches.shipped", { ...GOOD, at: T + 8 * DAY });
  assert.equal(await syncBranchSweep(db, T + 8 * DAY), null, "open for 8 days: nothing new, the owner has not run it");
  assert.equal((await asksOf(db)).length, 1);
  await writeEvidence(db, T + 30 * DAY, "probe", "branches.shipped", { ...GOOD, at: T + 30 * DAY });
  assert.equal(await syncBranchSweep(db, T + 30 * DAY), null, "or 30");
  assert.equal((await asksOf(db)).length, 1);
});

test("a list over 2 days old, an empty one, no list and a bad one make no ask", async () => {
  const db = makeDb();
  assert.equal(await syncBranchSweep(db, T), null, "no list");
  await writeEvidence(db, T, "probe", "branches.shipped", { at: T, repos: [] });
  assert.equal(await syncBranchSweep(db, T + 1000), null, "empty");
  await writeEvidence(db, T, "probe", "branches.shipped", GOOD);
  assert.equal(await syncBranchSweep(db, T + 3 * DAY), null, "old");
  assert.equal((await asksOf(db)).length, 0);
  await db.prepare("UPDATE evidence SET value = ? WHERE key = 'branches.shipped'").bind(JSON.stringify({ at: T, repos: [{ ...GOOD.repos[0], remoteBranches: [{ name: "a;rm -rf /", sha: S1 }] }] })).run();
  assert.equal(await syncBranchSweep(db, T + 1000), null, "a value that no longer fits the shape (tampered after the write) makes no ask");
  await db.prepare("UPDATE evidence SET value = ? WHERE key = 'branches.shipped'").bind(JSON.stringify({ at: T, repos: [{ ...GOOD.repos[0], localBranches: ["dev"] }] })).run();
  assert.equal(await syncBranchSweep(db, T + 1000), null, "or one that names dev");
  assert.equal((await asksOf(db)).length, 0);
});

test("the probe's 20-second ask raises it, and a failing sweep never stops the wake", async () => {
  const db = makeDb();
  await writeEvidence(db, T, "probe", "branches.shipped", GOOD);
  await wakeAsk(db, T + 1000);
  assert.equal((await asksOf(db)).length, 1);
  await wakeAsk(db, T + 2000);
  assert.equal((await asksOf(db)).length, 1, "asked again 1 second later: still one");
});

test("the evidence job posts branches.shipped with the late writes before live, at most every 6 hours, and a failing git posts none but breaks nothing", async () => {
  const state = { v: 1, board: { boardId: "x".repeat(22), at: T, probe: "p".repeat(40), pageVersion: null }, cards: { "open-card": { phase: "build", num: 412 }, "done-card": { phase: "live", num: 413 } }, agents: {} };
  const files = {};
  const go = async (sweepGit, at = Date.now()) => {
    const posted = [];
    await evidenceJob({ job: "evidence", base: "https://x.test", headers: {}, configPath: "/c.json", stateFile: "/dir/s.json", build: async () => {}, sweepGit, sessionsRead: () => [],
      read: (p) => (p === "/c.json" ? JSON.stringify({ collector: { repoPath: "~/Code/demo-repo", liveUrl: "https://live.test/" } }) : p in files ? files[p] : JSON.stringify(state)),
      write: (p, t) => { files[p] = t; }, liveFetch: async () => ({ ok: true, json: async () => ({ version: "1.0.0" }) }),
      fetchImpl: async (_u, o) => { posted.push(JSON.parse(o.body)); return { ok: true, status: 200 }; } });
    return posted;
  };
  const seen = [];
  const rec = (name, sha, message = "msg") => `refs/remotes/origin/${name}\x1f${sha}\x1f${message}\x1e`;
  const git = (r, args) => {
    seen.push(args.join(" "));
    if (args[0] === "rev-parse") return "a".repeat(40);
    return args[0] === "for-each-ref" && args.at(-1).startsWith("refs/remotes/") ? rec("build/open-card", "b".repeat(40)) + rec("build/done-card", "c".repeat(40)) + rec("build/other", "d".repeat(40), "#C412: still the open card's number") : "";
  };
  const first = await go(git);
  const keys = first.map((b) => b.key);
  assert.ok(keys.includes("branches.shipped") && keys.indexOf("branches.shipped") < keys.indexOf("live"), keys.join(","));
  const v = first.find((b) => b.key === "branches.shipped").value;
  assert.deepEqual(v.repos[0].remoteBranches, [{ name: "build/done-card", sha: "c".repeat(40) }], "a card still open (any phase but live) keeps its branch, by name or by its number in a subject; a live one's is listed");
  assert.ok(seen.every((a) => /^(rev-parse|for-each-ref)\b/.test(a)), `read-only git only: ${seen.join(" | ")}`);
  assert.ok("/dir/branches-listed.json" in files, "the time of the listing is kept beside the state");
  const again = (await go(git)).map((b) => b.key);
  assert.ok(!again.includes("branches.shipped"), "listed less than 6 hours ago: not again");
  files["/dir/branches-listed.json"] = JSON.stringify({ at: Date.now() - 7 * H });
  assert.ok((await go(git)).map((b) => b.key).includes("branches.shipped"), "after 6 hours, again");
  files["/dir/branches-listed.json"] = JSON.stringify({ at: 0 });
  const failed = (await go(() => { throw new Error("no repository"); })).map((b) => b.key);
  assert.ok(failed.includes("live") && failed.includes("branches.shipped"), "a repository git cannot read posts an empty list and nothing breaks");
});
