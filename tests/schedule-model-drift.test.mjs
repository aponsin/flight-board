// #C1006: scheduled tasks flag a model they were not given. The watchdog task named no model, followed the app default and ran two days on the top model
// before anyone saw it. The board config says which model each task is meant to have (scheduledTasks), the app's session files say which its last run used
// (model, scheduledTaskId), the probe posts the pair as schedule.models, and the page shows a mismatch red, a task with no chosen model amber "unset",
// a task never run or not run for a week grey, and nothing for a paused one.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConfig, fullConfig } from "../scripts/config.mjs";
import { appSessions } from "../collector/state.mjs";
import { scheduleModelsWrite, configuredTasks, newestRuns } from "../collector/schedule-models.mjs";
import { evidenceJob, scheduleSessions } from "../collector/probe-evidence.mjs";
import { scheduleModelsShape, evidenceRefusal } from "../worker/board-rules.mjs";
import { probeDoc } from "../worker/compat-view.mjs";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000, H = 3_600_000, DAY = 24 * H;
const cfgOf = (scheduledTasks) => JSON.stringify({ scheduledTasks });
const run = (taskId, model, at, extra = {}) => ({ id: `local_${taskId}_${at}`, title: "x", transcript: "t", cwd: "/x", at, model, scheduledTaskId: taskId, ...extra });
const write = (config, sessions) => scheduleModelsWrite(config, { sessions, now: T }).value;

test("config: scheduledTasks defaults to none, and a list of { id, model?, paused? } with plain words is accepted", () => {
  assert.deepEqual(fullConfig({}).scheduledTasks, []);
  assert.deepEqual(checkConfig({ scheduledTasks: [{ id: "team-watchdog", model: "claude-haiku-5-5" }, { id: "ops-daily", paused: true }, { id: "no-model", model: null }] }), []);
});

test("config: every way to get a task wrong is refused, one test line each", () => {
  const bad = (v, re) => assert.ok(checkConfig({ scheduledTasks: v }).some((e) => re.test(e)), JSON.stringify(v));
  bad("x", /scheduledTasks: a list/);
  bad(Array.from({ length: 31 }, (_, i) => ({ id: `t${i}` })), /up to 30/);
  bad(["x"], /an object/);
  bad([{ id: "a b" }], /\.id/);
  bad([{ id: "<b>" }], /\.id/);
  bad([{}], /\.id/);
  bad([{ id: "a" }, { id: "a" }], /listed twice/);
  bad([{ id: "a", model: "claude haiku" }], /\.model/);
  bad([{ id: "a", model: 5 }], /\.model/);
  bad([{ id: "a", paused: "yes" }], /\.paused/);
  bad([{ id: "a", mdoel: "x" }], /unknown field "mdoel"/);
});

test("appSessions keeps model and scheduledTaskId as plain words (else null), and nothing more of the file", () => {
  const root = mkdtempSync(join(tmpdir(), "sched-")), org = join(root, "a".repeat(8) + "-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "b".repeat(8) + "-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  try {
    mkdirSync(org, { recursive: true });
    const file = (n, extra) => writeFileSync(join(org, `local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}.json`), JSON.stringify({ title: `S${n}`, cliSessionId: `cccccccc-cccc-4ccc-8ccc-ccccccccccc${n}`, cwd: "/Users/x/Code/r", lastActivityAt: T, ...extra }));
    file(1, { model: "claude-sonnet-5-5", scheduledTaskId: "team-ops-daily", effort: "medium", prompt: "secret words" });
    file(2, { model: "not a model\nline", scheduledTaskId: "bad id!" });
    file(3, {});
    file(4, { model: 7, scheduledTaskId: { x: 1 } });
    const rows = Object.fromEntries(appSessions(root).map((s) => [s.title, s]));
    assert.equal(rows.S1.model, "claude-sonnet-5-5");
    assert.equal(rows.S1.scheduledTaskId, "team-ops-daily");
    for (const t of ["S2", "S3", "S4"]) assert.deepEqual([rows[t].model, rows[t].scheduledTaskId], [null, null], t);
    assert.deepEqual(Object.keys(rows.S1).sort(), ["at", "cwd", "from", "id", "model", "scheduledTaskId", "title", "transcript"], "effort and the prompt are not kept");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an archived run still counts for the schedule reading (and only for it): a task whose newest run is archived and drifted reads red, not 'no run yet' (Checker 2's F1)", () => {
  const root = mkdtempSync(join(tmpdir(), "sched-arch-")), org = join(root, "a".repeat(8) + "-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "b".repeat(8) + "-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  try {
    mkdirSync(org, { recursive: true });
    const file = (n, extra) => writeFileSync(join(org, `local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}.json`), JSON.stringify({ title: `S${n}`, cliSessionId: `cccccccc-cccc-4ccc-8ccc-ccccccccccc${n}`, cwd: "/Users/x/Code/r", scheduledTaskId: "watchdog", ...extra }));
    file(1, { model: "claude-haiku-5-5", lastActivityAt: T - 5 * H });
    file(2, { model: "claude-opus-5-5", lastActivityAt: T - H, isArchived: true });
    assert.deepEqual(appSessions(root).map((s) => s.title), ["S1"], "everything else still leaves archived sessions out");
    assert.deepEqual(appSessions(root, undefined, { includeArchived: true }).map((s) => s.title).sort(), ["S1", "S2"]);
    const v = scheduleModelsWrite(cfgOf([{ id: "watchdog", model: "claude-haiku-5-5" }]), { sessions: scheduleSessions(root), now: T }).value;
    assert.deepEqual(v.tasks, [{ id: "watchdog", chosen: "claude-haiku-5-5", lastRun: "claude-opus-5-5", at: T - H }]);
    assert.equal(JSON.parse(JSON.stringify(page(null).scheduleVerdict(v.tasks[0], T))).c, "bad", "the drifted archived run is red");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the reading takes the newest run of each task, the chosen model from the config, and says when a run is not known", () => {
  const v = write(cfgOf([{ id: "watchdog", model: "claude-haiku-5-5" }, { id: "never", model: "claude-haiku-5-5" }]), [
    run("watchdog", "claude-opus-5-5", T - 5 * H), run("watchdog", "claude-haiku-5-5", T - H), run("watchdog", "claude-sonnet-5-5", T - 9 * H), { id: "p", title: "plain", at: T, model: "claude-opus-5-5", scheduledTaskId: null }]);
  assert.deepEqual(v, { at: T, tasks: [{ id: "watchdog", chosen: "claude-haiku-5-5", lastRun: "claude-haiku-5-5", at: T - H }, { id: "never", chosen: "claude-haiku-5-5", lastRun: null, at: null }] });
  assert.equal(scheduleModelsShape(v), true, "what the probe posts is what the store accepts");
});

test("a paused task is left out, even with runs; a task seen on a session but not in the config is never listed (another project's task name stays off the board)", () => {
  const v = write(cfgOf([{ id: "ops-daily", model: "claude-haiku-5-5", paused: true }, { id: "mine", model: "claude-haiku-5-5" }, { id: "no-model" }]), [
    run("ops-daily", "claude-opus-5-5", T - H), run("mine", "claude-haiku-5-5", T - 2 * H), run("old-one", "claude-opus-5-5", T - 9 * H), run("new-one", "claude-sonnet-5-5", T - 3 * H)]);
  assert.deepEqual(v.tasks.map((t) => [t.id, t.chosen]), [["mine", "claude-haiku-5-5"], ["no-model", null]], "the config's own tasks only, in its order; one with no model is still listed (amber 'unset')");
  assert.equal(JSON.stringify(v).includes("old-one") || JSON.stringify(v).includes("new-one"), false);
});

test("no list in the config posts no task, even for tasks seen; at most 30 are posted; an unusable config posts nothing (the store keeps its last good reading)", () => {
  assert.deepEqual(write("{}", []).tasks, []);
  assert.deepEqual(write("{}", [run("a", "m", T)]).tasks, [], "a task seen but not configured is not listed");
  assert.equal(write(cfgOf(Array.from({ length: 30 }, (_, i) => ({ id: `t${i}` }))), Array.from({ length: 40 }, (_, i) => run(`t${i}`, "m", T - i))).tasks.length, 30);
  const logs = [];
  for (const c of ["not json", cfgOf("x"), cfgOf([{ id: "a b" }]), cfgOf([{ id: "a" }, { id: "a" }]), cfgOf([{ id: "a", model: "x y" }]), cfgOf([{ id: "a", prompt: "an extra field" }])]) assert.equal(scheduleModelsWrite(c, { sessions: [], now: T, log: (l) => logs.push(l) }), null, c);
  assert.equal(logs.length, 6, "each says why");
  assert.equal(configuredTasks(cfgOf([])).length, 0);
  assert.equal(newestRuns([run("a", "m", T), { scheduledTaskId: "b c", at: T }]).size, 1);
});

test("the evidence job posts schedule.models with the late writes, after look and before live, and a failing session read posts none but breaks nothing", async () => {
  const state = { v: 1, board: { boardId: "x".repeat(22), at: T, probe: "p".repeat(40), pageVersion: null }, cards: {}, agents: {} };
  const go = async (sessionsRead) => {
    const posted = [];
    await evidenceJob({ job: "evidence", base: "https://x.test", headers: {}, configPath: "/c.json", stateFile: "/s.json", build: async () => {}, sessionsRead,
      read: (p) => (p === "/c.json" ? JSON.stringify({ scheduledTasks: [{ id: "w", model: "claude-haiku-5-5" }], collector: { liveUrl: "https://live.test/" } }) : JSON.stringify(state)), liveFetch: async () => ({ ok: true, json: async () => ({ version: "1.0.0" }) }),
      fetchImpl: async (_u, o) => { const b = JSON.parse(o.body); posted.push(b); return { ok: true, status: 200 }; } });
    return posted;
  };
  const ok = await go(() => [run("w", "claude-opus-5-5", Date.now() - H)]);
  const keys = ok.map((b) => b.key);
  assert.ok(keys.indexOf("look") < keys.indexOf("schedule.models") && keys.indexOf("schedule.models") < keys.indexOf("live"), keys.join(","));
  assert.deepEqual(ok.find((b) => b.key === "schedule.models").value.tasks, [{ id: "w", chosen: "claude-haiku-5-5", lastRun: "claude-opus-5-5", at: ok.find((b) => b.key === "schedule.models").value.tasks[0].at }]);
  const failed = (await go(() => { throw new Error("no folder"); })).map((b) => b.key);
  assert.ok(!failed.includes("schedule.models") && failed.includes("live"));
});

test("the store accepts the shape and refuses anything else: words, model names and times only", () => {
  const good = { at: T, tasks: [{ id: "w", chosen: null, lastRun: "claude-opus-5-5", at: T }] };
  assert.equal(scheduleModelsShape(good), true);
  assert.equal(evidenceRefusal("schedule.models", good, "probe"), null);
  const bad = [null, [], { at: T }, { at: "x", tasks: [] }, { at: T, tasks: "x" }, { ...good, extra: 1 },
    { at: T, tasks: Array.from({ length: 31 }, () => good.tasks[0]) },
    { at: T, tasks: [{ id: "a b", chosen: null, lastRun: null, at: null }] },
    { at: T, tasks: [{ id: "a", chosen: "m\nx", lastRun: null, at: null }] },
    { at: T, tasks: [{ id: "a", chosen: undefined, lastRun: null, at: null }] },
    { at: T, tasks: [{ id: "a", chosen: null, lastRun: null, at: "x" }] },
    { at: T, tasks: [{ id: "a", chosen: null, lastRun: null, at: null, prompt: "secret" }] },
    { at: T, tasks: [{ id: "a", chosen: null, lastRun: "m\nx", at: null }] },
    { at: T, tasks: [{ id: "a", chosen: null, lastRun: { x: 1 }, at: null }] },
    { at: T, tasks: [{ id: "a", chosen: null, lastRun: undefined, at: null }] }];
  for (const v of bad) assert.equal(scheduleModelsShape(v), false, JSON.stringify(v));
  assert.notEqual(evidenceRefusal("schedule.models", bad[3], "probe"), null, "a bad value is refused");
  assert.notEqual(evidenceRefusal("schedule.models", good, "agent"), null, "only the probe writes evidence");
});

test("the page's probe document carries schedule.models at any age, so the page can say the reading is old", () => {
  const view = (readAt) => ({ now: T, evidence: { "schedule.models": { value: { at: T - 100 * H, tasks: [] }, readAt } }, cards: [] });
  assert.deepEqual(probeDoc(view(T - 100 * H)).schedule, { at: T - 100 * H, tasks: [] });
  assert.equal(probeDoc({ now: T, evidence: {}, cards: [] }).schedule, undefined);
});

// The page.
const page = (schedule, at = T) => {
  const b = loadNames(["scheduleVerdict", "scheduleModelsHtml", "probeEvent"], { Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(at); } static now() { return at; } } });
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { boardId: "TestBoard42xyz", at, probe: null, pageVersion: null }, cards: {}, agents: {}, ...(schedule ? { schedule } : {}) } } }, {});
  return b;
};
const task = (chosen, lastRun, at) => ({ id: "w", chosen, lastRun, at });

test("the verdict: same is green; another model is red; no chosen model is amber 'unset', never red; never run or not for a week is grey, never red", () => {
  const b = page(null), v = (t, now) => JSON.parse(JSON.stringify(b.scheduleVerdict(t, now))); // the page's own objects come from another context
  assert.deepEqual(v(task("claude-haiku-5-5", "claude-haiku-5-5", T - H), T), { c: "ok", txt: "✓ claude-haiku-5-5" }, "the green chip says it in words too, a check mark and the model (Designer's finding: not colour alone)");
  assert.deepEqual(v(task("claude-haiku-5-5", "claude-opus-5-5", T - H), T), { c: "bad", txt: "ran claude-opus-5-5, chosen claude-haiku-5-5" });
  assert.deepEqual(v(task(null, "claude-opus-5-5", T - H), T), { c: "warn", txt: "unset · ran claude-opus-5-5" });
  assert.equal(v(task(null, null, T - H), T).c, "warn");
  assert.equal(v(task("claude-haiku-5-5", null, T - H), T).c, "warn", "a run whose model was not read is not a mismatch");
  assert.deepEqual(v(task("claude-haiku-5-5", null, null), T), { c: "mute", txt: "no run yet" });
  assert.deepEqual(v(task(null, null, null), T), { c: "mute", txt: "no run yet" });
  for (const chosen of ["claude-haiku-5-5", null]) assert.deepEqual(v(task(chosen, "claude-opus-5-5", T - 8 * DAY), T), { c: "mute", txt: "no recent run" }, "a paused or deleted task's old run is never red");
  assert.equal(v(task("claude-haiku-5-5", "claude-opus-5-5", T - 6 * DAY), T).c, "bad", "inside the week it still counts");
});

test("the page draws one chip per task, says when the reading is over 36 h old, and draws nothing when there is no reading or no task", () => {
  const html = page({ at: T - 10 * H, tasks: [task("claude-haiku-5-5", "claude-opus-5-5", T - H), { ...task(null, "claude-opus-5-5", T - H), id: "u" }] }).scheduleModelsHtml(T);
  assert.match(html, /data-task="w"[\s\S]*sm-chip bad">ran claude-opus-5-5, chosen claude-haiku-5-5/);
  assert.match(html, /data-task="u"[\s\S]*sm-chip warn">unset/);
  assert.match(page({ at: T - H, tasks: [task("m", "m", T - H)] }).scheduleModelsHtml(T), /sm-chip ok">✓ m</, "a matching task reads ✓ and the model");
  assert.doesNotMatch(html, /model reading old/);
  assert.match(page({ at: T - 37 * H, tasks: [task("m", "m", T)] }).scheduleModelsHtml(T), /model reading old/);
  assert.equal(page(null).scheduleModelsHtml(T), "");
  assert.equal(page({ at: T, tasks: [] }).scheduleModelsHtml(T), "");
  assert.match(page({ at: T, tasks: [{ id: "<img>", chosen: "<b>", lastRun: "<i>", at: T }] }).scheduleModelsHtml(T), /&lt;img&gt;/, "words are escaped");
  assert.match(page({ at: T, tasks: [{ id: "<img>", chosen: "<b>", lastRun: "<i>", at: T }] }).scheduleModelsHtml(T), /class="sm-id">&lt;img&gt;<\/span>/, "the id shown is escaped too, not only the data-task attribute");
  assert.doesNotMatch(page({ at: T, tasks: [{ id: "<img>", chosen: "<b>", lastRun: "<i>", at: T }] }).scheduleModelsHtml(T), /<img>|<i>|<b>/, "no raw tag from a word reaches the page");
});
