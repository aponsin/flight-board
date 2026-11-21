# Ops knobs: the triage of the constants that were on the lint baseline (#C1113)

The lint (tests/ops-knobs-lint.test.mjs) wants every bare time or interval constant to be a setting (worker/knobs.mjs), on its FIXED list with a reason, or on the frozen
baseline (tests/ops-knobs-baseline.json, retired by #C1113: the file and its rewrite switch are gone, and a test fails if it returns). This is the one-time pass over the constants the baseline held when #C1113's rest began (slices 1 and 2 had already moved four).
Each verdict was made from the constant's own declaration and the comment around it. The rule: lean towards FIXED, and make a setting only where someone has already wanted to
tune it. Nobody has wanted to tune any of these, so every one is FIXED. A FIXED entry is keyed by file and name since #C1151, so a later constant of the same name in another file is not exempt; a
constant that needs tuning later gets its own card, and moving one to a setting needs the owner's pack when its file is pinned. Putting a name on FIXED changes only the lint test.

| Constant | File | Verdict | Reason |
|---|---|---|---|
| HOSTED_USD_PER_MIN | collector/actions-usage.mjs | FIXED | GitHub's published price for a hosted runner minute: a price, not an operating number |
| SEND_TIMEOUT_MS | collector/probe-board.mjs | FIXED | 25 s, inside the ask job's own 30 s limit that the plist holds |
| E2E_EVERY_MS | collector/probe-evidence.mjs | FIXED | how often the probe asks for the daily test run (30 min): a cost bound on gh reads |
| E2E_STALE_MS | collector/probe-evidence.mjs | FIXED | how old the kept e2e answer may be before it reads unknown (2 h), well over E2E_EVERY_MS |
| REPOST_MS | collector/probe-evidence.mjs | FIXED | how long before an unchanged evidence key is posted again (10 min), under the freshness windows |
| NEEDS_USER_MS | collector/prompt-alarm.mjs | FIXED | 15 min on a call the owner must answer: the same bound as USER_MS, one reading of one rule |
| STEP_MS | collector/readings.mjs | FIXED | 30 min with no transcript movement is stuck on a step (#C1005): the watchdog's own rule |
| USER_MS | collector/readings.mjs | FIXED | 15 min stopped on a call for the owner is stuck (#C593): the watchdog's own rule |
| WEEK_MS | collector/readings.mjs | FIXED | the length of the quota week: a fact about the account's quota |
| WINDOW_TOKENS | collector/readings.mjs | FIXED | the model's context window: a fact about the model |
| REPORT_WAIT_MS | collector/run-watchdog.mjs | FIXED | 5 s the watchdog waits to tell the store before it exits, inside RUN_LIMIT_MS |
| RUN_LIMIT_MS | collector/run-watchdog.mjs | FIXED | the probe's whole-run limit (5 min, #C719), tied to the launchd job in the plist |
| LIVE_FRESH_MS | collector/state-schema.mjs | FIXED | how old state.json may be and still count (3 min): one schema read by the gate and the Collector, copied by the page |
| AFTER_SHIP_WINDOW_MS | collector/store-dispatch.mjs | FIXED | how long after a ship Ops is woken for the check (24 h): a reading window on the evidence |
| DECISION_FRESH_MS | collector/store-dispatch.mjs | FIXED | how long an answered Decision may still wake its card's owner (24 h, #C872) |
| QUIET_MS | collector/watch-readings.mjs | FIXED | how long the prompt ledger may be silent while agents work before the watch says so (24 h) |
| FRESH_MAX_MS | collector/fence.mjs | FIXED | decides who may write: how old a fenced state file may be (30 min) |
| FUTURE_MAX_MS | collector/fence.mjs | FIXED | decides who may write: how far ahead of now a fenced time may read (1 min), a clock-skew bound |
| BACKOFF_MIN_MS | collector/state.mjs | FIXED | the first wait after a failed gh call (60 s): the shape of the back-off, which doubles to BACKOFF_MAX_MS |
| BACKOFF_MAX_MS | collector/state.mjs | FIXED | the longest back-off wait (30 min): the top of the same doubling |
| CI_BATCH_LIMIT | collector/state.mjs | FIXED | how many CI runs one batched list reads (100): a cost bound on gh, not a time |
| MIRROR_STALE_MS | collector/state.mjs | FIXED | how old the board export may be for the asks (2 h): the answer gate's own window |
| QUIET_LOOKBACK_MS | collector/state.mjs | FIXED | how far back the quiet-hours scan walks, minute by minute (48 h): a cost bound on one loop |
| RETRY_MS | collector/state.mjs | FIXED | one more try 5 s later after a network blip (#C428), well inside launchd's minute |
| SHIP_CANDIDATE_MAX_MS | collector/state.mjs | FIXED | how long a pushed ship candidate stays one (6 h): the bound behind SHIP_CI_WINDOW_MS |
| STACKS_FRESH_MS | collector/state.mjs | FIXED | a stack-switch file older than 30 min reads as off: a reading window, and off is the safe reading |
| USAGE_EVERY_MS | collector/state.mjs | FIXED | how often the usage job reads (5 min): the job's cadence, tied to the plist |
| USAGE_RETRY_MIN_MS | collector/state.mjs | FIXED | the first wait after a failed usage read (10 min), the start of its back-off |
| USAGE_RETRY_MAX_MS | collector/state.mjs | FIXED | the longest usage back-off (24 h), the top of the same back-off |
| WEEK_SPAN_MS | collector/state.mjs | FIXED | the length of the usage week (7 days): a fact about the account's quota |
| WORKING_QUIET_MS | collector/state.mjs | FIXED | a turn quiet for 15 min is read as idle (a session closed mid-turn): a reading rule on the transcript |
| CLOSE_AGAIN_MS | gate/reset.mjs | FIXED | how often a CLOSE line repeats (2 h, #C682): the owner's own fix for a line that woke the lead too often |
| GAP_AGAIN_MS | gate/reset.mjs | FIXED | how often a GAP line repeats (30 min), the repeat spacing of that line kind |
| LINE_AGAIN_MS | gate/reset.mjs | FIXED | how long before a printed line prints again (2 h), like CLOSE_AGAIN_MS |
| EVIDENCE_STALE_MS | gate/reset.mjs | FIXED | no card shows a commit for 10 min (the file is owner-pinned, and it is not the page's probe edge staleAfterSec) |
| DISPATCH_IDLE_MS | gate/reset.mjs | FIXED | how long an agent sits idle with a card to do and no turns before the first dispatch line (15 min) |
| DISPATCH_LATE_MS | gate/reset.mjs | FIXED | how long after a first dispatch line with nothing moved before level 2 (30 min), also named in the late line |
| DISPATCH_TURN_IDLE_MS | gate/reset.mjs | FIXED | how long an idle agent with a card turn waits before its first wake (60 s) |
| DISPATCH_ALIVE_MS | gate/reset.mjs | FIXED | a role's dispatch watch counts as running if its pid file was beaten within 90 s |
| DISPATCH_ASK_GAP_MS | gate/stop.mjs | FIXED | the stop hook asks about the watch at most every 10 min, so a session that cannot run it is not stopped for ever |
| ALIVE_MAX_MS | gate/wake.mjs | FIXED | how old the wake watch's alive file may be (60 s): tied to the watch's own beat and POLL_MS |
| POLL_MS | gate/wake.mjs | FIXED | the wake watch's 5 s file poll: the feel of one watch, not an operating number |
| OPEN_ASKS_MAX_AGE_MS | hooks/red-ask-board.py | FIXED | the export of open asks counts for 10 min: the hook's own freshness for a red line |
| OWNER_FRESH_MS | hooks/red-ask-board.py | FIXED | an owner message under 10 min old defers the reset cue one turn: the reset rule's own window |
| FRESH | scripts/pickup-watch.mjs | FIXED | 5,000 TOKENS, not a time: a session whose Messages read under it has just been cleared |
| STUCK_MS | scripts/prompt-watch.mjs | FIXED | a stopped prompt must be this old (30 min) before the push line names it, once per stop |
| LIVE_FRESH | scripts/restart-check.mjs | FIXED | state.json older than 3 min reads as nothing: the restart check's own copy of the live-state window (LIVE_FRESH_MS) |
| AGENT_QUIET_MS | scripts/restart-ready.mjs | FIXED | an agent active within 2 min counts as busy for the restart check |
| OUTSIDE_QUIET_MS | scripts/restart-ready.mjs | REMOVED | dead: read nowhere (the "outside" check takes a count from its caller and names the 5 minutes in its words); #C1151 deleted it |
| QUEUE_FRESH_MS | scripts/stack-ready.mjs | FIXED | how old the queue reading may be for stack-ready to trust it (15 min); a reading from the future is refused |
| STALE_LISTED | scripts/stack-ready.mjs | FIXED | 20: how many stale branch names the line lists before "and N more"; a count, not a time |
| BOOT_WAIT_MS | scripts/state-install.mjs | FIXED | 10 s to wait for a launchd job to boot: a pause inside the install script |
| BOOT_POLL_MS | scripts/state-install.mjs | FIXED | 0.5 s between looks while it boots: the same pause |
| BOOT_RETRY_MS | scripts/state-install.mjs | FIXED | 2 s before a second bootstrap if launchd answers an error: the same pause |

## Counts

57 baseline entries triaged (56 names: POLL_MS is declared in two files): 57 FIXED, 0 settings, 0 left on the baseline.
- slice 5 (collector reading windows, run limits, fixed facts, and the two fence windows): 19
- slice 6 (collector/state.mjs, gate, hooks, scripts and the page): 38 entries, 37 names

Two things the pass found, both done in #C1151: OUTSIDE_QUIET_MS (scripts/restart-ready.mjs) was declared and read nowhere, so it was deleted (56 FIXED entries remain from this table);
and the FIXED list matched by name alone, so the generic FRESH (scripts/pickup-watch.mjs, 5,000 tokens) would have exempted any future bare constant of that name. Entries are now keyed
by file and name ("scripts/pickup-watch.mjs:FRESH"; POLL_MS became two entries, one per file), and a test fails on an entry that matches no bare constant in its file.

No pack is needed for any of this: the FIXED list is in tests/ops-knobs-lint.test.mjs, and no constant's own file was touched. Moving one of these to a setting later would need
the owner's pack where its file is pinned (gate/*, scripts/*, hooks/*, and collector/state.mjs by the notes in worker/knobs.mjs).
