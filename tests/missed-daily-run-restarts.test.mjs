// #C1105: a daily full test run that reads "missed" is started by hand once, on main, and not again until a reading that is not missed has cleared it.
import test from "node:test";
import assert from "node:assert/strict";
import { e2eStep, defaultE2eStart, E2E_EVERY_MS, E2E_WORKFLOW_FILE } from "../collector/probe-evidence.mjs";

const cfg = JSON.stringify({ collector: { repoPath: "~/code/product" } });
const answer = (state) => ({ status: state === "ok" ? 0 : 1, stdout: JSON.stringify({ state, reason: "r", run: null, lastGreenAt: null }) });
function rig() {
  const files = new Map(), logs = [], starts = [];
  const io = { stateFile: "/s/board/state.json", env: {}, home: "/home/x", log: (l) => logs.push(l), read: (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p); }, write: (p, t) => files.set(p, t) };
  return { files, logs, starts, io };
}
const T0 = 10_000_000;

test("a missed reading starts the daily run once, in the product's clone, and keeps the start", () => {
  const { files, logs, starts, io } = rig();
  const start = (target) => { starts.push(target); return { status: 0, stdout: "" }; };
  assert.equal(e2eStep(cfg, { ...io, run: () => answer("missed"), start, now: T0 }).state, "missed");
  assert.deepEqual(starts, [{ cwd: "/home/x/code/product", ref: "origin/main" }]);
  assert.ok(logs.some((l) => /started it by hand/.test(l)), logs.join("\n"));
  assert.equal(JSON.parse(files.get("/s/board/e2e.json")).startedAt, T0);
});

test("a run that is still missed at the next readings is not started again", () => {
  const { starts, io } = rig();
  const start = (target) => { starts.push(target); return { status: 0, stdout: "" }; };
  for (let i = 0; i < 4; i++) e2eStep(cfg, { ...io, run: () => answer("missed"), start, now: T0 + i * E2E_EVERY_MS });
  assert.equal(starts.length, 1, "one start for the whole miss");
});

test("a start that fails is logged and tried again at the next reading", () => {
  const { files, logs, starts, io } = rig();
  let ok = false;
  const start = (target) => { starts.push(target); return ok ? { status: 0, stdout: "" } : { status: 1, stderr: "HTTP 422: no workflow_dispatch\nmore" }; };
  e2eStep(cfg, { ...io, run: () => answer("missed"), start, now: T0 });
  assert.equal(starts.length, 1);
  assert.equal(JSON.parse(files.get("/s/board/e2e.json")).startedAt, undefined, "a failed start is not kept");
  assert.ok(logs.some((l) => /could not be started \(HTTP 422: no workflow_dispatch\)/.test(l)), logs.join("\n"));
  ok = true;
  e2eStep(cfg, { ...io, run: () => answer("missed"), start, now: T0 + E2E_EVERY_MS });
  assert.equal(starts.length, 2);
  assert.equal(JSON.parse(files.get("/s/board/e2e.json")).startedAt, T0 + E2E_EVERY_MS);
  e2eStep(cfg, { ...io, run: () => ({ status: 0, stdout: "x" }), start: () => { throw new Error("gh is gone"); }, now: T0 + 2 * E2E_EVERY_MS });
  assert.equal(starts.length, 2, "a reading that is not missed starts nothing");
});

test("a start that throws never fails the reading", () => {
  const { logs, io } = rig();
  const v = e2eStep(cfg, { ...io, run: () => answer("missed"), start: () => { throw new Error("spawn exploded"); }, now: T0 });
  assert.equal(v.state, "missed");
  assert.ok(logs.some((l) => /starting the daily run failed: spawn exploded/.test(l)), logs.join("\n"));
});

test("red, unknown and ok start nothing, and a reading that is not missed clears the kept start so the next miss starts again", () => {
  const { starts, io } = rig();
  const start = (target) => { starts.push(target); return { status: 0, stdout: "" }; };
  let at = T0;
  const step = (state) => { e2eStep(cfg, { ...io, run: () => answer(state), start, now: at }); at += E2E_EVERY_MS; };
  step("red"); step("unknown"); step("ok");
  assert.equal(starts.length, 0);
  step("missed");
  assert.equal(starts.length, 1);
  step("ok");
  step("missed");
  assert.equal(starts.length, 2, "a new miss after an ok starts again");
});

test("defaultE2eStart runs gh workflow run on the main branch of the clone, and refuses an unsafe ref", () => {
  const calls = [];
  const exec = (cmd, args, opts) => { calls.push({ cmd, args, cwd: opts.cwd }); return { status: 0 }; };
  defaultE2eStart({ cwd: "/p", ref: "origin/main" }, {}, exec);
  assert.deepEqual(calls, [{ cmd: "gh", args: ["workflow", "run", E2E_WORKFLOW_FILE, "--ref", "main"], cwd: "/p" }]);
  assert.equal(E2E_WORKFLOW_FILE, "daily-e2e.yml");
  const bad = defaultE2eStart({ cwd: "/p", ref: "origin/--evil" }, {}, exec);
  assert.equal(bad.error.code, "bad-ref");
  assert.equal(calls.length, 1);
});
