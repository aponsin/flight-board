import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { JOBS, OUTER_EXTRA_SEC, makeLogger, startRun, runChild, launchdPlist } from "../collector/probe-run.mjs";

test("five cadences (#C821 added dispatch, #C975 land), each with an inside limit well under row 4's 3 minutes", () => {
  assert.deepEqual(Object.keys(JOBS), ["ask", "evidence", "usage", "dispatch", "land"]);
  assert.deepEqual(Object.values(JOBS).map((j) => j.intervalSec), [20, 120, 300, 60, 180]);
  assert.deepEqual(Object.values(JOBS).map((j) => j.limitSec), [30, 170, 120, 45, 170]);
  for (const [name, j] of Object.entries(JOBS)) if (name !== "evidence" && name !== "land") assert.ok(j.limitSec + OUTER_EXTRA_SEC < 180);
  // #C996's stopgap (every number reverts to 60 / 90 when part 2 makes runs fast): evidence may run to 170 s, starts every 2 minutes
  // (launchd never overlaps two runs of a job), and its alarm is 185 s, past the page's old 3-minute edge (now 5).
  assert.equal(JOBS.evidence.limitSec + OUTER_EXTRA_SEC, 185);
  assert.ok(JOBS.evidence.limitSec + OUTER_EXTRA_SEC < 5 * 60);
});

test("every log line carries the time and a run id; a run logs its start and its end with the duration", () => {
  const lines = [];
  let t = Date.parse("2026-11-09T05:30:00.000Z");
  const run = startRun("ask", { write: (l) => lines.push(l), now: () => t, exit: () => {} });
  t += 1500;
  assert.equal(run.finish(0), 0);
  assert.match(lines[0], /^2026-11-09T05:30:00\.000Z ask [0-9a-f]{8} start limit 30s$/);
  assert.match(lines[1], /^2026-11-09T05:30:01\.500Z ask [0-9a-f]{8} end code 0 in 1500 ms$/);
  assert.equal(lines[0].split(" ")[2], lines[1].split(" ")[2], "the same run id on both");
  assert.match(makeLogger("usage", "abc", () => {}, () => 0).toString(), /=>/);
});

test("a run that outlives its inside limit names the step it was stuck on and exits 2", async () => {
  const lines = [];
  const reports = [];
  let code;
  const run = startRun("evidence", { write: (l) => lines.push(l), limitSec: 0.05, report: async (r) => reports.push(r), exit: (c) => { code = c; } });
  await new Promise((resolve) => {
    run.step("read session files", () => new Promise(() => {}));
    const iv = setInterval(() => { if (code !== undefined) { clearInterval(iv); resolve(); } }, 10);
  });
  assert.equal(code, 2);
  assert.ok(lines.some((l) => /timed out after \d+ s; pending step: read session files; exiting 2/.test(l)), lines.join("\n"));
  assert.equal(reports[0].step, "read session files");
  assert.equal(reports[0].job, "evidence");
});

test("a child process is killed at its own timeout", async () => {
  const t0 = Date.now();
  await assert.rejects(runChild("sleep", ["30"], { timeoutMs: 200 }), /killed after 200 ms/);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal((await runChild("echo", ["hi"], { timeoutMs: 5000 })).stdout.trim(), "hi");
});

test("each cadence is its own launchd job with the OS alarm in front of the program", () => {
  const plists = Object.keys(JOBS).map((job) => launchdPlist({ job, label: `com.flight-board.probe.${job}`, nodePath: "/usr/bin/node", script: "/x/probe.mjs", logPath: `/x/${job}.log` }));
  assert.equal(new Set(plists.map((p) => /<key>Label<\/key><string>([^<]+)/.exec(p)[1])).size, 5);
  assert.deepEqual(plists.map((p) => Number(/<key>StartInterval<\/key><integer>(\d+)/.exec(p)[1])), [20, 120, 300, 60, 180]);
  assert.deepEqual(plists.map((p) => /alarm (\d+); exec @ARGV/.exec(p)[1]), ["45", "185", "135", "60", "185"]);
  for (const p of plists) assert.match(p, /<string>\/usr\/bin\/perl<\/string><string>-e<\/string>/);
});

// The outside limit: a run whose event loop is blocked cannot run a timer, but the OS alarm still ends it.
test("the OS alarm ends a process whose event loop is blocked", () => {
  const r = spawnSync("/usr/bin/perl", ["-e", "alarm 1; exec @ARGV", process.execPath, "-e", "while (true) {}"], { timeout: 10_000 });
  assert.equal(r.signal, "SIGALRM");
});
