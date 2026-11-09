// How a probe run is started, limited and logged (#C719; Director's rules after the 2026-11-08 hang). Three separate launchd
// jobs, one per cadence, so one hung run can never block another; each run has two limits (inside: the watchdog, whose message
// names the pending step; outside: an operating-system alarm, because a timer cannot fire while the event loop is blocked);
// every child process has its own timeout and is killed at it; every log line carries the time and a run id, and each run logs
// its start and its end with the duration.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { armWatchdog } from "./run-watchdog.mjs";

// Per cadence: how often it starts and the inside limit in seconds. Row 4 is red at 3 minutes, so none comes near it.
export const JOBS = {
  ask: { intervalSec: 20, limitSec: 30 },
  evidence: { intervalSec: 60, limitSec: 90 },
  usage: { intervalSec: 300, limitSec: 120 },
};
export const OUTER_EXTRA_SEC = 15; // the OS alarm fires this long after the inside limit if the process is still stuck

export const newRunId = () => randomBytes(4).toString("hex");

// "2026-11-09T05:30:00.123Z ask a1b2c3d4 message"
export function makeLogger(job, runId, write = (l) => console.error(l), now = Date.now) {
  return (message) => write(`${new Date(now()).toISOString()} ${job} ${runId} ${message}`);
}

// Starts a run: logs the start, arms the inside watchdog. Returns { runId, log, step(name, fn), finish(code) }.
export function startRun(job, { write, report, exit, now = Date.now, setTimer, limitSec = JOBS[job]?.limitSec } = {}) {
  if (!limitSec) throw new Error(`unknown job ${job}`);
  const runId = newRunId(), log = makeLogger(job, runId, write, now), t0 = now();
  let pending = null;
  log(`start limit ${limitSec}s`);
  const wd = armWatchdog({ ms: limitSec * 1000, log, report: report ? (r) => report({ ...r, job, runId }) : undefined, exit, now, setTimer, pending: () => pending });
  return {
    runId, log,
    // Names the step that is pending, so a timeout says where the run was stuck.
    async step(name, fn) { pending = name; log(`step ${name}`); try { return await fn(); } finally { pending = null; } },
    finish(code = 0) { wd.disarm(); log(`end code ${code} in ${now() - t0} ms`); return code; },
  };
}

// A child process with its own timeout; killed (SIGKILL) at it. Rejects with a message naming the command and the limit.
export function runChild(cmd, args, { timeoutMs, input, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, cwd, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err?.killed) return reject(new Error(`${cmd} killed after ${timeoutMs} ms`));
      if (err) return reject(Object.assign(new Error(`${cmd} exited ${err.code}`), { code: err.code, stdout, stderr }));
      resolve({ stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// The launchd job for one cadence: started through perl's alarm so the OS ends it even if the event loop is blocked.
export function launchdPlist({ job, label, nodePath, script, args = [], logPath }) {
  const j = JOBS[job];
  if (!j) throw new Error(`unknown job ${job}`);
  const alarm = j.limitSec + OUTER_EXTRA_SEC;
  const argv = ["/usr/bin/perl", "-e", `alarm ${alarm}; exec @ARGV`, nodePath, script, ...args, "--job", job];
  const x = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${x(label)}</string>
<key>ProgramArguments</key><array>${argv.map((a) => `<string>${x(a)}</string>`).join("")}</array>
<key>StartInterval</key><integer>${j.intervalSec}</integer>
<key>StandardOutPath</key><string>${x(logPath)}</string>
<key>StandardErrorPath</key><string>${x(logPath)}</string>
</dict></plist>
`;
}
