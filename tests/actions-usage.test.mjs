// The runner and Actions usage the usage job posts (#C736): the old usage script's count, one day at a time.
import test from "node:test";
import assert from "node:assert/strict";
import { actionsDay, usageDays, daysDue, runActionsUsage } from "../collector/actions-usage.mjs";
import { actionsUsageStep, expandHome, evidenceJob } from "../collector/probe-evidence.mjs";

const at = (iso, min) => ({ started_at: iso, completed_at: new Date(Date.parse(iso) + min * 60_000).toISOString() });
function fakeGh(runs, jobsOf) {
  const calls = [];
  const gh = ([p]) => { calls.push(p); if (p.includes("/jobs")) return { jobs: jobsOf[Number(p.match(/runs\/(\d+)\/jobs/)[1])] ?? [] }; return { workflow_runs: runs }; };
  gh.calls = calls;
  return gh;
}

test("self-hosted job minutes are runner minutes; the rest are hosted, at 0.008 a minute; unfinished and backwards jobs count for nothing", () => {
  const gh = fakeGh([{ id: 1 }, { id: 2 }], {
    1: [{ labels: ["self-hosted", "macOS"], ...at("2026-11-09T10:00:00Z", 10) }, { labels: ["ubuntu-latest"], ...at("2026-11-09T10:00:00Z", 30) }, { labels: ["ubuntu-latest"], started_at: "2026-11-09T10:00:00Z" }],
    2: [{ labels: ["self-hosted"], ...at("2026-11-09T11:00:00Z", 5.4) }, { labels: ["ubuntu-latest"], started_at: "2026-11-09T12:00:00Z", completed_at: "2026-11-09T11:00:00Z" }, { labels: null, ...at("2026-11-09T11:00:00Z", 20) }],
  });
  assert.deepEqual(actionsDay("2026-11-09", gh), { day: "2026-11-09", runner_minutes: 15, automation_minutes: 50, actions_usd: 0.4 });
  assert.ok(gh.calls[0].includes("created=2026-11-09"));
});

test("runs are read a hundred to the page until a short page", () => {
  const pages = [Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })), [{ id: 101 }]];
  let n = 0;
  const gh = ([p]) => (p.includes("/jobs") ? { jobs: [] } : { workflow_runs: pages[n++] ?? [] });
  actionsDay("2026-11-09", gh);
  assert.equal(n, 2);
});

test("a day that is not a date is refused", () => assert.throws(() => actionsDay("2026-11-9; rm", () => ({}))));

test("today every half hour; yesterday until it has been read after it ended", () => {
  const now = Date.parse("2026-11-10T01:00:00Z");
  const [today, yesterday] = usageDays(now);
  assert.deepEqual([today, yesterday], ["2026-11-10", "2026-11-09"]);
  assert.deepEqual(daysDue(now, {}), ["2026-11-10", "2026-11-09"]);
  assert.deepEqual(daysDue(now, { [today]: now - 10 * 60_000, [yesterday]: now - 90 * 60_000 }), ["2026-11-09"], "yesterday was last read before midnight");
  assert.deepEqual(daysDue(now, { [today]: now - 10 * 60_000, [yesterday]: Date.parse("2026-11-10T00:30:00Z") }), [], "both read recently");
  assert.deepEqual(daysDue(now, { [today]: now - 31 * 60_000, [yesterday]: Date.parse("2026-11-10T00:30:00Z") }), [today]);
});

test("a day the store refused stays due; a day the gh call failed on is logged and stays due", async () => {
  const now = Date.parse("2026-11-10T01:00:00Z"), log = [];
  const gh = ([p]) => { if (p.includes("created=2026-11-09")) throw new Error("gh exploded"); return p.includes("/jobs") ? { jobs: [] } : { workflow_runs: [] }; };
  const r = await runActionsUsage({ now, gh, post: async () => false, log: (l) => log.push(l) });
  assert.equal(r.posted, 0); assert.deepEqual(r.seen, {});
  assert.ok(log.some((l) => /2026-11-09: gh exploded/.test(l)) && log.some((l) => /2026-11-10: the store did not take it/.test(l)));
  const ok = await runActionsUsage({ now, gh: fakeGh([], {}), post: async () => true });
  assert.deepEqual(Object.keys(ok.seen).sort(), ["2026-11-09", "2026-11-10"]);
});

test("the usage job's step posts each due day to /api/probe/usage and keeps the days read beside the state", async () => {
  const now = Date.parse("2026-11-10T01:00:00Z"), posts = [], written = {};
  const files = { "/cfg.json": JSON.stringify({ collector: { repoPath: "/work/team" } }) };
  const fetchImpl = async (url, o) => { posts.push([url, JSON.parse(o.body)]); return { ok: true, status: 200 }; };
  const gh = fakeGh([{ id: 1 }], { 1: [{ labels: ["self-hosted"], ...at("2026-11-10T00:10:00Z", 12) }] });
  await actionsUsageStep({ base: "https://b.example", headers: {}, fetchImpl, origConfig: "/cfg.json", stateFile: "/state/board/state.json", env: {}, read: (p) => { if (files[p] === undefined) throw new Error("no file"); return files[p]; }, log: () => {}, now, gh, write: (p, t) => { written[p] = t; } });
  assert.deepEqual(posts.map(([u]) => u), ["https://b.example/api/probe/usage", "https://b.example/api/probe/usage"]);
  assert.deepEqual(posts.map(([, b]) => b.day).sort(), ["2026-11-09", "2026-11-10"]);
  assert.equal(posts[0][1].runner_minutes, 12);
  assert.deepEqual(Object.keys(JSON.parse(written["/state/board/actions-usage.json"])).sort(), ["2026-11-09", "2026-11-10"]);
});

test("a config with no repository folder, or a store that is down, is logged and never throws", async () => {
  const log = [];
  await actionsUsageStep({ base: "https://b.example", headers: {}, fetchImpl: async () => { throw new Error("down"); }, origConfig: "/c", stateFile: "/s/state.json", env: {}, read: () => "{}", log: (l) => log.push(l), gh: fakeGh([], {}), write: () => {} });
  assert.ok(log.some((l) => /no collector\.repoPath/.test(l)));
  const log2 = [];
  await actionsUsageStep({ base: "https://b.example", headers: {}, fetchImpl: async () => { throw new Error("down"); }, origConfig: "/c", stateFile: "/s/state.json", env: {}, read: (p) => (p === "/c" ? JSON.stringify({ collector: { repoPath: "/x" } }) : (() => { throw new Error("none"); })()), log: (l) => log2.push(l), gh: fakeGh([], {}), write: () => {} });
  assert.ok(log2.some((l) => /actions usage failed: down/.test(l)));
});

test("a repoPath that starts with ~ is expanded before gh runs in it (Checker F1)", async () => {
  const cwds = [];
  const exec = (cmd, args, o) => { cwds.push(o.cwd); return JSON.stringify(args[1].includes("/jobs") ? { jobs: [] } : { workflow_runs: [] }); };
  await actionsUsageStep({ base: "https://b.example", headers: {}, fetchImpl: async () => ({ ok: true, status: 200 }), origConfig: "/c", stateFile: "/s/state.json", env: {}, read: (p) => { if (p === "/c") return JSON.stringify({ collector: { repoPath: "~/.flight-board/b/repo" } }); throw new Error("none"); }, log: () => {}, now: Date.parse("2026-11-10T01:00:00Z"), home: "/Users/someone", exec, write: () => {} });
  assert.ok(cwds.length > 0);
  assert.ok(cwds.every((c) => c === "/Users/someone/.flight-board/b/repo"), cwds.join());
  assert.equal(expandHome("~", "/h"), "/h"); assert.equal(expandHome("/x/~y", "/h"), "/x/~y"); assert.equal(expandHome("~other/x", "/h"), "~other/x");
});

test("past the job's deadline no more gh runs: the day in hand stays due, nothing is saved, the job does not fail (Checker F2)", async () => {
  let t = 1000, calls = 0, saved = 0, posts = 0;
  const gh = () => { calls++; t += 400; return { workflow_runs: Array.from({ length: calls < 3 ? 100 : 0 }, (_, i) => ({ id: i + 1 })), jobs: [] }; };
  const log = [];
  await actionsUsageStep({ base: "https://b.example", headers: {}, fetchImpl: async () => { posts++; return { ok: true, status: 200 }; }, origConfig: "/c", stateFile: "/s/state.json", env: {}, read: (p) => { if (p === "/c") return JSON.stringify({ collector: { repoPath: "/r" } }); throw new Error("none"); }, log: (l) => log.push(l), now: Date.parse("2026-11-10T01:00:00Z"), gh, deadline: 2000, clock: () => t, write: () => { saved++; } });
  assert.ok(calls <= 4, `gh was called ${calls} times`);
  assert.equal(posts, 0); assert.equal(saved, 0);
  assert.ok(log.some((l) => /the job's time is spent/.test(l)));
});

test("the usage job hands the step the job's deadline, 15 s short of its 120 s limit, and gh is told how long is left (Checker, through evidenceJob)", async () => {
  const lefts = [];
  const gh = (args, left) => { lefts.push(left); return args[0].includes("/jobs") ? { jobs: [] } : { workflow_runs: [] }; };
  const read = (p) => { if (p === "/c") return JSON.stringify({ collector: { repoPath: "/r" } }); if (p === "/s/state.json") return JSON.stringify({}); throw new Error("none"); };
  await evidenceJob({ job: "usage", base: "https://b.example", headers: {}, configPath: "/c", stateFile: "/s/state.json", build: async () => {}, read, fetchImpl: async () => ({ ok: true, status: 200 }), log: () => {}, actions: { gh, write: () => {} } });
  assert.ok(lefts.length > 0);
  assert.ok(lefts.every((l) => l > 104_000 && l <= 105_000), lefts.join());
  // Past the deadline the step stops: a clock 106 s on gets no gh call at all.
  let calls = 0;
  const t0 = Date.now();
  await evidenceJob({ job: "usage", base: "https://b.example", headers: {}, configPath: "/c", stateFile: "/s/state.json", build: async () => {}, read, fetchImpl: async () => ({ ok: true, status: 200 }), log: () => {}, actions: { gh: () => { calls++; return { workflow_runs: [], jobs: [] }; }, clock: () => t0 + 106_000, write: () => {} } });
  assert.equal(calls, 0);
});
