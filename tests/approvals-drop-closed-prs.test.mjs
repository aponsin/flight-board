// #C1389 (11-20: the agent list said "38 approved: merge at the next ship" after all 34 were merged; 7 were open on GitHub): the probe reads the open pull requests (evidence `prs`), and the panel
// of the agent's pull requests drops an Approval ask for a pull request of a repository it read when that pull request is not open. A failed or partial read drops nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { approvalDocs, applyApprovals, goneFromGitHub, approvalFor } from "../worker/compat-approvals.mjs";
import { APPROVE, prsShape, evidenceRefusal, PRS_REPO } from "../worker/board-rules.mjs";
import { prsStep, PRS_LIMIT } from "../collector/probe-evidence.mjs";

const T = 1_790_000_000_000;
const H = (c) => c.repeat(40);
const ask = (pr, over = {}, repo = "example/sites") => ({ id: `t${pr}`, num: pr, type: "Approval", title: `PR ${pr}`, created_at: T - 3_600_000, closed_at: null, answered_at: T - 1000, answered_by: "owner", answer: APPROVE, body: JSON.stringify({ pr, head: H("a"), url: `https://github.com/${repo}/pull/${pr}` }), ...over });
const PRS = (open, over = {}) => ({ at: T, repos: ["example/sites"], open: open.map((n) => `example/sites#${n}`), ...over });
const ids = (docs) => docs.agentPrs.map((p) => p.id);

test("an approved pull request that is not open on GitHub leaves both lists; the open ones stay", () => {
  const asks = [343, 344, 345, 346].map((n) => ask(n));
  const docs = approvalDocs(asks, PRS([343, 346]));
  assert.deepEqual(ids(docs).sort(), ["pr343", "pr346"]);
  assert.deepEqual(docs.approvals.map((a) => a.id).sort(), ["pr343", "pr346"]);
});

test("no read, a failed read, another repository's read and an ask with no repository drop nothing", () => {
  const asks = [343, 344].map((n) => ask(n));
  assert.deepEqual(ids(approvalDocs(asks)), ["pr344", "pr343"], "no evidence");
  assert.deepEqual(ids(approvalDocs(asks, null)), ["pr344", "pr343"]);
  assert.deepEqual(ids(approvalDocs(asks, PRS([], { repos: ["example/other"] }))), ["pr344", "pr343"], "that repository was not read");
  assert.deepEqual(ids(approvalDocs(asks, { at: T, repos: [], open: [] })), ["pr344", "pr343"], "nothing was read");
  assert.deepEqual(ids(approvalDocs(asks, "garbage")), ["pr344", "pr343"]);
  const noUrl = ask(500, { body: JSON.stringify({ pr: 500, head: H("a") }) });
  assert.deepEqual(ids(approvalDocs([noUrl], PRS([]))), ["pr500"], "no repository in the ask: nothing to compare");
  const lookalike = ask(501, {}, "example/sites-extra");
  assert.deepEqual(ids(approvalDocs([lookalike], PRS([]))), ["pr501"], "the repository is matched whole, not by prefix");
});

test("a pull request opened after the read is not dropped for being missing from it", () => {
  const fresh = ask(400, { created_at: T + 60_000 });
  assert.deepEqual(ids(approvalDocs([fresh], PRS([]))), ["pr400"]);
  assert.equal(goneFromGitHub({ a: { created_at: T }, pr: 400, url: "https://github.com/example/sites/pull/400" }, PRS([])), true, "an ask made exactly at the read is judged by it");
});

test("applyApprovals reads the evidence from the view, and Release's own check still reads the raw asks", () => {
  const asks = [ask(343), ask(344, { body: JSON.stringify({ pr: 344, head: H("c"), url: "https://github.com/example/sites/pull/344" }) })];
  const view = { asks, evidence: { prs: { value: PRS([343]), readAt: T } } };
  const out = applyApprovals({ waiting: [] }, view);
  assert.deepEqual(ids(out), ["pr343"]);
  assert.equal(approvalFor(asks, 344, H("c")).ok, true, "the approval of a merged pull request is still what approvalFor reads");
  assert.deepEqual(ids(applyApprovals({ waiting: [] }, { asks })), ["pr344", "pr343"]);
});

test("the evidence shape: whole repositories, open numbers of those repositories, bounded", () => {
  assert.equal(prsShape(PRS([1, 2])), true);
  assert.equal(prsShape({ at: T, repos: [], open: [] }), true);
  for (const bad of [null, [], {}, { ...PRS([1]), extra: 1 }, { ...PRS([1]), at: "now" }, { ...PRS([1]), repos: "x" }, { ...PRS([1]), repos: ["no-slash"] }, { ...PRS([]), open: ["example/sites#0"] }, { ...PRS([]), open: ["example/other#5"] }, { ...PRS([]), open: ["example/sites#5<"] }, { ...PRS([]), open: Array.from({ length: 401 }, (_, i) => `example/sites#${i + 1}`) }, { ...PRS([]), repos: Array.from({ length: 11 }, (_, i) => `a/r${i}`) }]) assert.equal(prsShape(bad), false, JSON.stringify(bad)?.slice(0, 60));
  assert.equal(evidenceRefusal("prs", PRS([1]), "probe"), null);
  assert.equal(evidenceRefusal("prs", { at: T }, "probe").rule, "prs-shape");
  assert.equal(evidenceRefusal("prs", PRS([1]), "Builder").rule, "only-probe-writes-status");
});

// ---- the collector's step ----
const CONFIG = JSON.stringify({ collector: { repoPath: "~/Code/sites", repos: [{ name: "sites", path: "~/Code/sites" }, { name: "board", path: "/work/board" }, { name: "x", path: 5 }] } });
function harness({ answers, config = CONFIG } = {}) {
  const posts = [], logs = [], calls = [];
  const run = (args, cwd) => { calls.push([cwd, args.join(" ")]); const a = answers[cwd]; if (a instanceof Error) throw a; return a[args[0]]; };
  const post = async (writes) => { posts.push(...writes); };
  return { posts, logs, calls, args: { base: "https://board.test", headers: {}, origConfig: "/c.json", read: () => config, log: (l) => logs.push(l), now: T, run, post, home: "/home/u" } };
}

test("the step names each repository it read, lists its open numbers, and writes the key prs", async () => {
  const h = harness({ answers: { "/home/u/Code/sites": { repo: "example/sites\n", pr: '[{"number":343},{"number":351}]' }, "/work/board": { repo: "example/board\n", pr: "[]" } } });
  const v = await prsStep(h.args);
  assert.deepEqual(v, { at: T, repos: ["example/sites", "example/board"], open: ["example/sites#343", "example/sites#351"] });
  assert.deepEqual(h.posts, [{ key: "prs", value: v }]);
  assert.equal(prsShape(v), true);
  assert.equal(h.calls.filter(([d]) => d === "/home/u/Code/sites").length, 2, "one folder named twice is asked once");
  assert.ok(h.calls.every(([, a]) => /^(repo view|pr list --state open)/.test(a)), "read-only gh commands only");
  assert.ok(PRS_REPO.test("example/sites") && !PRS_REPO.test("example"));
});

test("a repository whose read failed, or whose list may be cut, is left out; nothing read writes nothing and the job never throws", async () => {
  const boom = Object.assign(new Error("gh: not logged in"), { status: 1 });
  const h = harness({ answers: { "/home/u/Code/sites": boom, "/work/board": { repo: "example/board", pr: "[]" } } });
  assert.deepEqual((await prsStep(h.args)).repos, ["example/board"], "the failed one is not named, so nothing of it is dropped");
  const full = harness({ answers: { "/home/u/Code/sites": { repo: "example/sites", pr: JSON.stringify(Array.from({ length: PRS_LIMIT }, (_, i) => ({ number: i + 1 }))) }, "/work/board": boom } });
  assert.equal(await prsStep(full.args), null, "a list that filled the cap may be cut: unread");
  assert.deepEqual(full.posts, []);
  const bad = harness({ answers: { "/home/u/Code/sites": { repo: "not a repo", pr: "[]" }, "/work/board": { repo: "example/board", pr: "[{\"number\":\"x\"}]" } } });
  assert.equal(await prsStep(bad.args), null);
  assert.deepEqual(bad.posts, []);
  assert.equal(await prsStep({ ...h.args, read: () => { throw new Error("no"); } }), null);
  assert.equal(await prsStep({ ...h.args, read: () => "{}" }), null);
  assert.equal(await prsStep({ ...h.args, post: async () => { throw new Error("answered 500"); } }), null);
  assert.equal(await prsStep({ ...h.args, deadline: 0, clock: () => 1 }), null, "past the job's deadline no gh runs");
});

// Checker 2 on 94e18d62: the two guards below each passed the whole suite when removed.
test("more than 400 open pull requests in all are not carried (400 are), and nothing is written", async () => {
  const nums = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ number: i + 1 })));
  const config = JSON.stringify({ collector: { repoPath: "/w/a", repos: [{ path: "/w/b" }, { path: "/w/c" }] } });
  const run = (sizes) => harness({ config, answers: { "/w/a": { repo: "o/a", pr: nums(sizes[0]) }, "/w/b": { repo: "o/b", pr: nums(sizes[1]) }, "/w/c": { repo: "o/c", pr: nums(sizes[2]) } } });
  const ok = run([134, 133, 133]);
  assert.equal((await prsStep(ok.args)).open.length, 400, "400 is the most carried");
  assert.equal(ok.posts.length, 1);
  const over = run([134, 134, 133]);
  assert.equal(await prsStep(over.args), null, "401 each under the per-repository cap, over the total");
  assert.deepEqual(over.posts, []);
  assert.ok(over.logs.some((l) => /too many open pull requests/.test(l)));
});

test("two folders of one repository list its pull requests once", async () => {
  const config = JSON.stringify({ collector: { repoPath: "/w/one", repos: [{ path: "/w/two" }] } });
  const same = { repo: "example/sites", pr: '[{"number":1},{"number":2}]' };
  const h = harness({ config, answers: { "/w/one": same, "/w/two": same } });
  const v = await prsStep(h.args);
  assert.deepEqual(v.repos, ["example/sites"]);
  assert.deepEqual(v.open, ["example/sites#1", "example/sites#2"]);
  assert.equal(prsShape(v), true);
});

test("the usage job runs the step after the truth check and before the Actions step", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../collector/probe-evidence.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(job === "usage"\) await prsStep\(\{/);
  assert.ok(src.indexOf("await truthStep({") < src.indexOf("await prsStep({") && src.indexOf("await prsStep({") < src.indexOf("await actionsUsageStep({"));
  assert.equal(/PRS_REPO = (\/[^\n]*\/);/.exec(src)[1], /PRS_REPO = (\/[^\n]*\/);/.exec(readFileSync(new URL("../worker/board-rules.mjs", import.meta.url), "utf8"))[1], "the collector's repository pattern is the Worker's");
});
