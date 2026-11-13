// The probe's launchd cadences (#C719): how often each job starts and its inside limit, in seconds. Imports nothing, so the
// Worker (the header's "slow: N s of <limit>") and the probe (collector/probe-run.mjs) read the same numbers.
// Row 4 is red at 3 minutes, so none comes near it, except evidence (#C996, a stopgap until the state child is fast again): its
// runs took 80-120 s against a 90 s limit and were killed, so the board never refreshed. Now a run may take 170 s, a run starts
// every 120 s (launchd never overlaps two), and the page's evidence readings count as stale only after 5 minutes. EVERY EVIDENCE
// NUMBER HERE REVERTS (interval 60, limit 90) when part 2 makes the runs fast.
export const JOBS = {
  ask: { intervalSec: 20, limitSec: 30 },
  evidence: { intervalSec: 120, limitSec: 170 },
  usage: { intervalSec: 300, limitSec: 120 },
  dispatch: { intervalSec: 60, limitSec: 45 }, // #C821: the owners' DISPATCH files from the store's view
  // #C975: the landing job (scripts/board-land.mjs, #C967), from the signed linked copy, not the probe. A real landing runs the release tool's dry
  // run and real run (each builds the page, a carried sign-off also runs the suite), so it gets the evidence job's room. Its report counts as fresh
  // for 10 minutes (collector/store-dispatch.mjs LAND_REPORT_FRESH_MS), so a missed run or two still leaves board landings with the job.
  land: { intervalSec: 180, limitSec: 170 },
};
