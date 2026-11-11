// #C737 (Director's rule): on the store a board-repository card is live only when its commit is inside BOTH the commit the store Worker was
// deployed from and the commit of the tree the probe runs from, never because the installed link moved at the merge. Real git for the
// reading; the Worker's route and the evidence job through their seams. Fictional repository and names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState, deployedSha } from "../collector/state.mjs";
import { readDeploy, deployEnv, evidenceJob, defaultBuild } from "../collector/probe-evidence.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { treeStep } from "../scripts/pair/tree.template.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI", repos: [{ name: "boardrepo", path: "/y", notes: NOTES }] } });

// main: base -> C1 -> (card work, signed, merged) C2 -> C3, plus a side branch D off C1 that is not on main.
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "fb-livedeploy-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  const commit = (t, file, msg) => { at = T0 + t; appendFileSync(join(work, file), `${t}\n`); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  commit(0, "base.md", "start");
  const c1 = commit(5, "c1.md", "earlier work");
  g(["checkout", "-qb", "side"]); const d = commit(6, "d.md", "a side line"); g(["checkout", "-q", "main"]);
  g(["checkout", "-qb", "board-fix"]);
  const own = commit(10, "w.md", "The card's work\n\nBoard-Id: board-fix");
  for (const ref of Object.values(NOTES)) g(["notes", `--ref=${ref}`, "add", "-m", "PASS", own]);
  g(["checkout", "-q", "main"]); at = T0 + 20; g(["merge", "-q", "--no-ff", "-m", "merge board-fix", "board-fix"]); g(["branch", "-qD", "board-fix"]);
  const c2 = g(["rev-parse", "HEAD"]).trim();
  const c3 = commit(30, "c3.md", "later work");
  g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]);
  const repo = (live) => ({ git: (a) => g(a), remote: "origin", main: "main", notes: NOTES, tips: [{ branch: "main", sha: c3, at: T0, message: "" }], live, versionPattern: null });
  return { g, c1, c2, c3, d, own, repo, bare };
}
const read = (r, live) => cardState({ id: "board-fix", num: 9, level: "Full", phase: "plan", repo: "boardrepo" }, r.repo(live), cfg, (T0 + 100) * 1000);

test("deployedSha: the older of the two when one contains the other; nothing when either is unknown, unreachable or on another line", () => {
  const r = rig();
  const git = (a) => r.g(a);
  assert.equal(deployedSha(git, r.c2, r.c2), r.c2);
  assert.equal(deployedSha(git, r.c1, r.c3), r.c1, "the Worker is behind the tree");
  assert.equal(deployedSha(git, r.c3, r.c1), r.c1, "the tree is behind the Worker");
  for (const [w, t] of [["", r.c2], [r.c2, ""], [null, undefined], ["abc", r.c2], [r.c2, "x".repeat(40)], ["0".repeat(40), r.c2], [r.d, r.c2]]) assert.equal(deployedSha(git, w, t), null, JSON.stringify([w, t]));
  assert.equal(deployedSha(() => { throw new Error("git down"); }, r.c2, r.c2), null);
});

test("merged, not deployed: the card reads ship, never live; once the Worker AND the tree carry it, live; one of them behind: ship", () => {
  const r = rig();
  const git = (a) => r.g(a);
  const merged = read(r, deployedSha(git, r.c1, r.c1));
  assert.equal(merged.onMain, true); assert.deepEqual(merged.signed, ["checker", "security"]);
  assert.equal(merged.phase, "ship", "on main and signed, but neither the Worker nor the tree has it");
  assert.equal(read(r, deployedSha(git, r.c2, r.c2)).phase, "live", "the pair has run: both carry the merge");
  assert.equal(read(r, deployedSha(git, r.c3, r.c3)).phase, "live", "both are ahead of it");
  assert.equal(read(r, deployedSha(git, r.c3, r.c1)).phase, "ship", "the Worker is ahead but the tree is not");
  assert.equal(read(r, deployedSha(git, r.c1, r.c3)).phase, "ship", "the tree is ahead but the Worker is not");
});

test("unreadable: no Worker build, no tree commit, or two lines: the card stays at ship, never live", () => {
  const r = rig();
  const git = (a) => r.g(a);
  for (const [w, t] of [["", r.c3], [r.c3, ""], [r.d, r.c3], ["", ""]]) { const s = read(r, deployedSha(git, w, t)); assert.equal(s.phase, "ship", JSON.stringify([w, t])); assert.notEqual(s.phase, "live"); }
});

test("state.mjs reads the installed link for these cards only when the store's rule is off (the old state job)", () => {
  const src = readFileSync(new URL("../collector/state.mjs", import.meta.url), "utf8");
  assert.match(src, /process\.env\.FB_DEPLOY_RULE === "1" \? deployedSha\(at\.git, process\.env\.FB_DEPLOY_WORKER, process\.env\.FB_DEPLOY_TREE\) : installed/);
});

test("readDeploy: the Worker's 40-hex build and the tree's commit; anything else reads as unknown, with the reason logged", async () => {
  const sha = "a".repeat(40), tree = "b".repeat(40), logs = [];
  const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });
  assert.deepEqual(await readDeploy({ base: "https://x.test", headers: { h: "1" }, fetchImpl: ok({ sha }), treeSha: () => tree }), { worker: sha, tree });
  let asked;
  await readDeploy({ base: "https://x.test", headers: { h: "1" }, fetchImpl: async (u, o) => { asked = [u, o.redirect, o.headers]; return { ok: true, json: async () => ({ sha }) }; }, treeSha: () => tree });
  assert.deepEqual(asked, ["https://x.test/api/probe/build", "error", { h: "1" }]);
  for (const body of [{ sha: null }, { sha: "abc" }, { sha: "A".repeat(40) }, {}, null]) assert.equal((await readDeploy({ base: "https://x.test", headers: {}, fetchImpl: ok(body), treeSha: () => tree, log: (l) => logs.push(l) })).worker, "", JSON.stringify(body));
  assert.equal((await readDeploy({ base: "https://x.test", headers: {}, fetchImpl: async () => ({ ok: false, status: 503 }), treeSha: () => tree })).worker, "");
  assert.equal((await readDeploy({ base: "https://x.test", headers: {}, fetchImpl: async () => { throw new Error("down"); }, treeSha: () => tree })).worker, "");
  assert.equal((await readDeploy({ base: "https://x.test", headers: {}, fetchImpl: ok({ sha }), treeSha: () => "not a sha" })).tree, "");
  assert.equal((await readDeploy({ base: "https://x.test", headers: {}, fetchImpl: ok({ sha }), treeSha: () => { throw new Error("no git"); } })).tree, "");
  assert.ok(logs.length >= 4, "each unknown build is said");
  assert.deepEqual(deployEnv({ worker: sha, tree: "" }), { FB_DEPLOY_RULE: "1", FB_DEPLOY_WORKER: sha, FB_DEPLOY_TREE: "" });
});

test("the evidence job gives the state child the deploy facts, the usage job none; the child's environment keeps its PATH", async () => {
  const seen = {};
  const state = JSON.stringify({ id: "x" });
  const run = (job) => evidenceJob({ job, base: "https://x.test", headers: {}, configPath: "/c.json", stateFile: "/s.json", privateDir: null, fetchImpl: async () => ({ ok: true, status: 200 }), liveFetch: async () => ({ ok: false }), ghCheck: () => true, deployRead: async () => ({ worker: "a".repeat(40), tree: "b".repeat(40) }), build: async (args, ms, extra) => { seen[job] = extra; }, read: () => state, log: () => {} }).catch(() => {});
  await run("evidence"); await run("usage");
  assert.deepEqual(seen.evidence, { FB_DEPLOY_RULE: "1", FB_DEPLOY_WORKER: "a".repeat(40), FB_DEPLOY_TREE: "b".repeat(40) });
  assert.deepEqual(seen.usage, {});
  let got;
  await defaultBuild(["x"], 1, async (bin, args, o) => { got = o.env; }, { PATH: "/p" }, { FB_DEPLOY_RULE: "1" });
  assert.equal(got.PATH, "/p"); assert.equal(got.FB_DEPLOY_RULE, "1");
});

test("GET /api/probe/build is the probe's alone and says the Worker's BUILD_SHA, or null when it is unset or not 40 hex", async () => {
  const WHO = { owner: { who: "owner", role: "owner" }, manager: { who: "Manager", role: "agent" }, probe: { who: "probe", role: "probe" } };
  const get = (as, env) => worker.fetch(new Request("https://board.test/api/probe/build", { headers: { "x-as": as } }), { DB: makeDb(), ...env }, null, Date.now(), async (req) => WHO[req.headers.get("x-as")] ?? null);
  const sha = "c".repeat(40);
  assert.equal((await get("owner", { BUILD_SHA: sha })).status, 403);
  assert.equal((await get("manager", { BUILD_SHA: sha })).status, 403);
  assert.deepEqual(await (await get("probe", { BUILD_SHA: sha })).json(), { sha });
  for (const v of [undefined, "", "abc", "C".repeat(40), `${sha}\n`, 5]) assert.deepEqual(await (await get("probe", { BUILD_SHA: v })).json(), { sha: null }, String(v));
});

test("a pair made from the templates: the deploy sets BUILD_SHA to the signed commit and writes the marker the tree step reads; both parse", async () => {
  const { makePair } = await import("../scripts/pair/make-pair.mjs");
  const files = makePair({ name: "pc11", card: "#C737", what: "w", signed: "d".repeat(40), deployOk: "ok", treeOk: "ok" });
  const [deploy, tree] = [files["board-store-deploy-pc11.mjs"], files["board-store-tree-pc11.mjs"]];
  assert.match(deploy, /"--var", `BUILD_SHA:\$\{checkedOut\}`/);
  assert.match(deploy, /const checkedOut = String\(spawn\("git", \["-C", TREE, "rev-parse", "HEAD"\]/, "the value is read back from the checkout");
  assert.match(deploy, /if \(checkedOut !== signed\) return stop\(/, "and it must be the signed commit");
  assert.equal((deploy.match(/BUILD_SHA:/g) ?? []).length, 1, "BUILD_SHA is set in exactly one place");
  // #C924: no argument reaches the deploy; the environment is read in exactly one place, to carry the two Cloudflare values from the private file.
  assert.ok(!/process\.argv\.slice|process\.argv\[2\]/.test(deploy), "no argument reaches the deploy");
  assert.equal((deploy.match(/process\.env/g) ?? []).length, 1, "process.env is read in one place only");
  assert.match(deploy, /\{ \.\.\.opts, env: \{ \.\.\.process\.env, \.\.\.creds \} \}/);
  assert.ok(deploy.includes("board-store-deploy-pc11.done") && tree.includes("board-store-deploy-pc11.done"), "one marker name in both");
  assert.ok(deploy.indexOf('"--var"') < deploy.indexOf("fs.writeFileSync(`${here}"), "the marker is written after the deploy");
  const dir = mkdtempSync(join(tmpdir(), "fb-c737files-"));
  for (const [f, text] of Object.entries(files)) { writeFileSync(join(dir, f), text); execFileSync("node", ["--check", join(dir, f)], { stdio: "pipe" }); }
});

test("a deploy made without the template resets BUILD_SHA to its plain default (empty): the Worker says nothing and the card reads ship, never the last sha", async () => {
  const toml = readFileSync(new URL("../worker/wrangler.board.toml", import.meta.url), "utf8");
  assert.match(toml, /^BUILD_SHA = ""$/m, "the plain default is empty");
  const r = rig();
  const WHO = { probe: { who: "probe", role: "probe" } };
  const answer = await (await worker.fetch(new Request("https://board.test/api/probe/build", { headers: { "x-as": "probe" } }), { DB: makeDb(), BUILD_SHA: "" }, null, Date.now(), async (req) => WHO[req.headers.get("x-as")] ?? null)).json();
  assert.deepEqual(answer, { sha: null });
  const dep = await readDeploy({ base: "https://x.test", headers: {}, fetchImpl: async () => ({ ok: true, json: async () => answer }), treeSha: () => r.c3 });
  assert.equal(dep.worker, "");
  const s = read(r, deployedSha((a) => r.g(a), dep.worker, dep.tree));
  assert.equal(s.phase, "ship"); assert.notEqual(s.phase, "live");
});

// #C737 (Manager): a card of another repository that is on main and read at ship waits for the owner's deploy, not for Release: the
// stall wake of #C732 does not fire for it. Control: the same card without a repo word, or not yet on main, still wakes.
test("the stall wake does not fire for a board-repository card on main at ship; it still does for one not on main or one with no repo word", async () => {
  const { createCard, writeEvidence, wakeAsk } = await import("../worker/board-store.mjs");
  const T = 1_800_000_000_000, MIN = 60_000;
  const wakes = async (card, evidence) => {
    const db = makeDb();
    await createCard(db, T, "Manager", { id: "card-a", title: "A card", owner_role: "Boardsmith", ...card });
    await writeEvidence(db, T, "probe", "cards.card-a", { lit: ["ship"], phase: "ship", ci: "none", ...evidence });
    await writeEvidence(db, T, "probe", "agents", { Release: { state: "idle", tool: null, card: null, since: T } });
    return (await wakeAsk(db, T + 20 * MIN)).count;
  };
  assert.equal(await wakes({}, { onMain: true }), 1, "a card with no repo word at ship, Release idle 20 min: a stall (the team's own flow)");
  assert.equal(await wakes({ repo: "flight-board" }, { onMain: false }), 1, "queued for a board release, not on main: Release's to land, a stall");
  assert.equal(await wakes({ repo: "flight-board" }, { onMain: true }), 0, "on main, waiting for the owner's deploy: not a stall");
  assert.equal(await wakes({ repo: "flight-board" }, {}), 1, "no reading of main: not exempt");
});

// The pair's ordering: the tree does not move until the deploy of the same pair has said it ran with the same commit.
test("the tree step refuses to move before this pair's deploy has run, and after it moves as before", () => {
  const r = rig();
  const dir = mkdtempSync(join(tmpdir(), "fb-order-"));
  const tree = join(dir, "tree");
  execFileSync("git", ["clone", "-q", r.bare, tree]);
  execFileSync("git", ["-C", tree, "checkout", "-q", "--detach", r.c1]);
  const done = join(dir, "board-store-deploy-pc11.done"), from = join(dir, "from");
  const step = () => treeStep({ mode: "update", tree, fromFile: from, signed: r.c3, deployDone: done });
  const none = step(); assert.equal(none.ok, false); assert.match(none.why, /deploy of this pair has not run/);
  writeFileSync(done, `${r.c2}\n`);
  assert.match(step().why, /deploy of this pair has not run/, "a marker naming another commit is not this pair's deploy");
  assert.equal(execFileSync("git", ["-C", tree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), r.c1, "nothing moved");
  writeFileSync(done, `${r.c3}\n`);
  assert.equal(step().ok, true);
  assert.equal(execFileSync("git", ["-C", tree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), r.c3);
});
