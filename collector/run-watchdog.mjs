// Whole-run watchdog for the probe (#C719). On 2026-11-08 one probe run hung with no child and no socket (an await nothing
// times out); launchd does not start a second copy of a StartInterval job while the first lives, so every later run, and the
// wakes, derived state and cards, froze. Every call had its own limit but the run had none. This is the run's limit: after
// `ms` it logs, tells the store (best effort, bounded by REPORT_WAIT_MS), and exits 2 so the next launch can run. The timer
// is deliberately NOT unref'd (the brief's rule): it is a live handle until it fires or is disarmed.
export const RUN_LIMIT_MS = 5 * 60_000;
export const REPORT_WAIT_MS = 5_000;

export function armWatchdog({ ms = RUN_LIMIT_MS, log = console.error, report = async () => {}, exit = (c) => process.exit(c), now = Date.now, setTimer = setTimeout } = {}) {
  const startedAt = now();
  const timer = setTimer(async () => {
    log(`probe run timed out after ${Math.round((now() - startedAt) / 1000)} s; exiting 2`);
    // Tell the store so the board shows it red, but never let that report keep the run alive.
    try { await Promise.race([report({ reason: "probe-run-timeout", at: now(), ms }), new Promise((r) => setTimeout(r, REPORT_WAIT_MS))]); } catch { /* best effort */ }
    exit(2);
  }, ms);
  return { disarm: () => clearTimeout(timer) };
}
