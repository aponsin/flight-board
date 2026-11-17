// #C1112: shipped branches are listed and deleted through one weekly Terminal ask made by the board. The probe lists, for each configured repository, the remote
// and local branches whose tip is already on main (never main or dev, never a branch with commits of its own, never an open card's branch) as branches.shipped;
// the store raises ONE Terminal ask a week from it with the delete lines. Real git; fictional repository and names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { shippedBranchesWrite, sweepRepos, plainBranch } from "../collector/shipped-branches.mjs";
import { evidenceJob } from "../collector/probe-evidence.mjs";
import { shippedBranchesShape, sweepAsk, askRefusal, evidenceRefusal, SWEEP_TITLE } from "../worker/board-rules.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { writeEvidence, syncBranchSweep, wakeAsk } from "../worker/board-store.mjs";

const T = 1_800_000_000_000, DAY = 86_400_000, H = 3_600_000;
const cfgOf = (collector) => JSON.stringify({ collector });
const CFG = cfgOf({ repoPath: "~/Code/demo-repo", remote: "origin", mainBranch: "main" });

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-sweep-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const branch = (name, { merge, extra }) => {
    g(["checkout", "-qb", name]); writeFileSync(join(work, `${name.replace(/\//g, "_")}.md`), "x\n"); g(["add", "-A"]); g(["commit", "-qm", name]);
    g(["checkout", "-q", "main"]);
    if (merge) g(["merge", "-q", "--no-ff", "-m", `merge ${name}`, name]);
    if (extra) g(["branch", extra]);
  };
  branch("build/shipped-one", { merge: true });
  branch("build/shipped-two", { merge: true });
  branch("build/still-open", { merge: true });
  branch("build/unmerged", { merge: false });
  branch("dev", { merge: true });
  g(["commit", "-q", "--allow-empty", "-m", "main moves on"]); // so the merged branches are no longer main's tip
  g(["branch", "fresh-cut"]); // a branch cut at main's tip: nothing of its own yet
  g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]);
  return (_r, args) => g(args);
}
const names = (l) => l.slice().sort();

test("the listing: remote and local branches whose tip is on main; not main or dev, not a branch with commits of its own, not an open card's, not one cut at main's tip", () => {
  const git = scratch();
  const v = shippedBranchesWrite(CFG, { git, openIds: ["still-open"], now: T }).value;
  assert.equal(v.at, T);
  assert.equal(v.repos.length, 1);
  const r = v.repos[0];
  assert.deepEqual([r.name, r.dir, r.remote], ["demo-repo", "~/Code/demo-repo", "origin"]);
  assert.deepEqual(names(r.remoteBranches), ["build/shipped-one", "build/shipped-two"]);
  assert.deepEqual(names(r.localBranches), ["build/shipped-one", "build/shipped-two"]);
  assert.equal(shippedBranchesShape(v), true, "what the probe posts is what the store accepts");
  const all = JSON.stringify(v);
  for (const never of ["build/unmerged", "build/still-open", "dev", "fresh-cut"]) assert.ok(!all.includes(`"${never}"`), never);
  assert.ok(!r.remoteBranches.includes("main") && !r.localBranches.includes("main") && !r.remoteBranches.includes("HEAD"));
});

test("with no card open, the card branch is listed too; a repository with nothing to delete is left out", () => {
  const git = scratch();
  assert.deepEqual(names(shippedBranchesWrite(CFG, { git, openIds: [], now: T }).value.repos[0].remoteBranches), ["build/shipped-one", "build/shipped-two", "build/still-open"]);
  assert.deepEqual(shippedBranchesWrite(CFG, { git: () => "", openIds: [], now: T, log: () => {} }).value.repos, [], "a git that lists nothing gives no repository");
});

test("a repository git cannot read is left out and logged; the others are still listed", () => {
  const git = scratch(), logs = [];
  const two = cfgOf({ repoPath: "~/Code/demo-repo", repos: [{ name: "other", path: "~/Code/other" }] });
  const v = shippedBranchesWrite(two, { git: (r, args) => { if (r.name === "demo-repo") throw new Error("not a repository\nmore"); return git(r, args); }, openIds: [], now: T, log: (l) => logs.push(l) }).value;
  assert.deepEqual(v.repos.map((r) => r.name), ["other"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /demo-repo could not be read: not a repository$/);
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

test("the store accepts the shape and refuses anything else: plain names, a ~/ folder, 6 repositories and 60 branches at most", () => {
  const good = { at: T, repos: [{ name: "demo-repo", dir: "~/Code/demo-repo", remote: "origin", remoteBranches: ["build/a"], localBranches: [] }] };
  assert.equal(shippedBranchesShape(good), true);
  assert.equal(evidenceRefusal("branches.shipped", good, "probe"), null);
  const r = good.repos[0];
  const bad = [null, [], { at: T }, { at: "x", repos: [] }, { at: T, repos: "x" }, { ...good, extra: 1 }, { at: T, repos: Array.from({ length: 7 }, () => r) },
    { at: T, repos: [{ ...r, dir: "/abs" }] }, { at: T, repos: [{ ...r, dir: "~/a b" }] }, { at: T, repos: [{ ...r, dir: "~/../x" }] },
    { at: T, repos: [{ ...r, name: "a b" }] }, { at: T, repos: [{ ...r, remote: "o;x" }] }, { at: T, repos: [{ ...r, remoteBranches: ["a b"] }] },
    { at: T, repos: [{ ...r, remoteBranches: ["a;rm -rf x"] }] }, ...[";", "$", "|", "&", "'", "\"", "`", "(", ">", "*"].map((c) => ({ at: T, repos: [{ ...r, remoteBranches: [`a${c}b`] }] })), { at: T, repos: [{ ...r, localBranches: ["-D"] }] }, { at: T, repos: [{ ...r, localBranches: ["a", "a"] }] },
    { at: T, repos: [{ ...r, remoteBranches: Array.from({ length: 61 }, (_, i) => `b${i}`) }] }, { at: T, repos: [{ ...r, remoteBranches: "x" }] },
    { at: T, repos: [{ ...r, prompt: "extra" }] }, { at: T, repos: [{ ...r, localBranches: undefined }] }];
  for (const v of bad) assert.equal(shippedBranchesShape(v), false, JSON.stringify(v));
  assert.notEqual(evidenceRefusal("branches.shipped", bad[3], "probe"), null, "a bad value is refused");
  assert.notEqual(evidenceRefusal("branches.shipped", good, "agent"), null, "only the probe writes evidence");
});

test("the ask: one delete line per 15 remote branches and per 15 local ones, each with its own folder, and the Worker accepts it as a Terminal ask", () => {
  const list = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const v = { at: T, repos: [{ name: "demo-repo", dir: "~/Code/demo-repo", remote: "origin", remoteBranches: list(31, "r"), localBranches: list(2, "l") }, { name: "other", dir: "~/Code/other", remote: "up", remoteBranches: [], localBranches: ["x"] }] };
  const ask = sweepAsk(v);
  assert.equal(ask.title, `${SWEEP_TITLE}: 34 on main already`);
  assert.equal(ask.commands.length, 3 + 1 + 1);
  assert.equal(ask.commands[0], `git -C ~/Code/demo-repo push origin --delete ${list(15, "r").join(" ")}`);
  assert.equal(ask.commands[1], `git -C ~/Code/demo-repo push origin --delete ${list(31, "r").slice(15, 30).join(" ")}`);
  assert.equal(ask.commands[2], "git -C ~/Code/demo-repo push origin --delete r30", "the last chunk holds the remaining one");
  assert.equal(ask.commands[3], "git -C ~/Code/demo-repo branch -d l0 l1");
  assert.equal(ask.commands[4], "git -C ~/Code/other branch -d x");
  assert.equal(askRefusal({ type: "Terminal", title: ask.title, asked_by: "Manager", commands: ask.commands }, T), null, "the ask rules take it (no bare cd, every line alone)");
  assert.equal(sweepAsk({ at: T, repos: [] }), null);
  assert.equal(sweepAsk({ at: T, repos: [{ ...v.repos[0], remoteBranches: [], localBranches: [] }] }), null);
  assert.equal(sweepAsk({ at: T, repos: "x" }), null, "a bad value makes no ask");
});

const GOOD = { at: T, repos: [{ name: "demo-repo", dir: "~/Code/demo-repo", remote: "origin", remoteBranches: ["build/a", "build/b"], localBranches: ["build/a"] }] };
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
  assert.deepEqual(JSON.parse(asks[0].body).commands, ["git -C ~/Code/demo-repo push origin --delete build/a build/b", "git -C ~/Code/demo-repo branch -d build/a"]);
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

test("a list over 2 days old, an empty one, no list and a bad one make no ask", async () => {
  const db = makeDb();
  assert.equal(await syncBranchSweep(db, T), null, "no list");
  await writeEvidence(db, T, "probe", "branches.shipped", { at: T, repos: [] });
  assert.equal(await syncBranchSweep(db, T + 1000), null, "empty");
  await writeEvidence(db, T, "probe", "branches.shipped", GOOD);
  assert.equal(await syncBranchSweep(db, T + 3 * DAY), null, "old");
  assert.equal((await asksOf(db)).length, 0);
  await db.prepare("UPDATE evidence SET value = ? WHERE key = 'branches.shipped'").bind(JSON.stringify({ at: T, repos: [{ ...GOOD.repos[0], remoteBranches: ["a;rm -rf /"] }] })).run();
  assert.equal(await syncBranchSweep(db, T + 1000), null, "a value that no longer fits the shape (tampered after the write) makes no ask");
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
  const state = { v: 1, board: { boardId: "x".repeat(22), at: T, probe: "p".repeat(40), pageVersion: null }, cards: { "open-card": { phase: "build" }, "done-card": { phase: "live" } }, agents: {} };
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
  const git = (r, args) => { seen.push(args.join(" ")); if (args[0] === "rev-parse") return "a".repeat(40); return args[0] === "for-each-ref" ? `refs/remotes/origin/build/open-card\t${"b".repeat(40)}\nrefs/remotes/origin/build/done-card\t${"c".repeat(40)}\n` : ""; };
  const first = await go(git);
  const keys = first.map((b) => b.key);
  assert.ok(keys.includes("branches.shipped") && keys.indexOf("branches.shipped") < keys.indexOf("live"), keys.join(","));
  const v = first.find((b) => b.key === "branches.shipped").value;
  assert.deepEqual(v.repos[0].remoteBranches, ["build/done-card"], "a card still open (any phase but live) keeps its branch; a live one's is listed");
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
