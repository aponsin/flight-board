// #C997 (the card's third test): a bare time, interval, threshold or retry constant added in worker/, collector/, scripts/, hooks/ or gate/ fails
// this test unless it is a setting (worker/knobs.mjs: its value then comes from KNOBS, not a number) or is on the short FIXED list below with a reason.
// There is no baseline any more (#C1113 retired it: every constant that was on it is now a setting or on the FIXED list, see docs/ops-knobs-triage.md), and no
// way to write one: a new bare time constant fails here until it is a setting or on FIXED with its reason, and a test fails if the baseline file comes back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["worker", "collector", "scripts", "hooks", "gate"];

// Time-ish names: ends in _MS/_SEC/_MIN/_HOURS/_DAYS or holds TIMEOUT, INTERVAL, STALE, FRESH, WITHIN, AFTER, AGAIN, LIMIT, QUIET, WINDOW, REPEAT, BACKOFF, RETRY.
const NAME = /(?:_(?:MS|SEC|MIN|HOURS|DAYS)$|TIMEOUT|INTERVAL|STALE|FRESH|WITHIN|_AFTER|AGAIN|LIMIT|QUIET|WINDOW|REPEAT|BACKOFF|RETRY)/;
// A plain numeric expression: digits, underscores, dots, e, * + - / ( ) and spaces. A name or call in it makes it NOT bare (it is derived).
const BARE = /^\d[\d_.e*+\-/() ]*$/;

// The constants that stay in code on purpose, by FILE AND NAME ("scripts/pickup-watch.mjs:FRESH", #C1151), with the reason (the inventory's FIXED list: they decide who may
// sign, land or deploy, protect KV or a protocol, or are write-validity windows and sanity bounds). Adding an entry here is a reviewed decision, like adding a setting. A
// bare constant of the same name in another file is NOT exempt, and an entry that names no bare constant in its file fails the test below (a dead entry).
export const FIXED = {
  "worker/compat-ships.mjs:FRESH_MS": "a sanity bound on a posted time (30 days)",
  "worker/board-rules.mjs:ACTIVITY_SKEW_MS": "how far ahead of now a session's lastActivityAt may read and still count as activity (5 min, #C1143): a clock-skew tolerance and a sanity bound on a time the probe wrote, not a cadence",
  "worker/probe-jobs.mjs:LAND_TIP_SEC": "the land job's per-tip budget: tied to the job's limit, which launchd's plist holds, and to LAND_REPORT_FRESH_MS (tests/ship-lane-per-repo.test.mjs); changing it needs an owner install",
  // #C1113 slice 2: four that are not operating numbers.
  "worker/web-push.mjs:VAPID_HOURS": "the lifetime of the Web Push signature (12 h): RFC 8292 lets a push service refuse one over 24 h, so it is a protocol bound, not an operating number",
  "worker/state-worker.mjs:HEARTBEAT_MS": "the state Worker's keep-alive write (15 min): it is tied to the daily KV write budget (WRITES_DEFAULT, the account's shared quota), so moving it moves that arithmetic and is a deploy decision",
  "worker/board-rules.mjs:INLINE_LIST_MIN": "how many inline (1) (2) (3) markers in one paragraph count as a packed list (3): the threshold of a wording rule, not a time or an operating number",
  // #C1113 slice 4 (Manager: do not plumb the posted settings into the dispatch; one that needs tuning later gets its own card).
  "worker/board-rules.mjs:STALL_WAKE_AFTER_MS": "how long an idle-agent stall must have lasted before the stalled role itself is woken (30 min, #C1097): read by the dispatch (collector/store-dispatch.mjs), which never sees the posted settings; a second step after the Manager's stall line (stallAfterSec), so it is not a cadence; tuning it is its own card",
  "collector/store-dispatch.mjs:AGENTS_FRESH_MS": "how old the agents reading may be before the dispatch trusts none of it (5 min): a reading window on the evidence the dispatch reads, the same kind as the page's staleAfterSec but read in the owner-pinned dispatch, which has no posted settings; tuning it is its own card",
  "collector/week-usage.mjs:SESSION_WEEK_FRESH_MS": "how old a session's weekly-usage post may be and still count (1 h): a reading window on a session's own report, read on the Mac by the collector, which has no posted settings; tuning it is its own card",
  // #C1113 slice 5: the collector's reading windows, run limits and fixed facts (group B), and two write-validity windows (group C).
  "collector/actions-usage.mjs:HOSTED_USD_PER_MIN": "GitHub's published price for a hosted runner minute ($0.008): a price, not an operating number",
  "collector/probe-board.mjs:SEND_TIMEOUT_MS": "the probe's send timeout (25 s): tied to the ask job's own 30 s limit, which the launchd plist holds; changing it needs an owner install",
  "collector/probe-evidence.mjs:E2E_EVERY_MS": "how often the probe asks for the product's daily test run (30 min): a cost bound on gh reads inside the usage job's 5-minute cadence, not a setting",
  "collector/probe-evidence.mjs:E2E_STALE_MS": "how old the kept e2e answer may be before it is written as unknown (2 h): a reading window on the evidence, well over E2E_EVERY_MS",
  "collector/probe-evidence.mjs:REPOST_MS": "how long the probe waits before posting an unchanged evidence key again (10 min): tied to the page's and the store's freshness windows, which stay over it",
  "collector/prompt-alarm.mjs:NEEDS_USER_MS": "how long a role stopped on a call the owner must answer stays quiet before the prompt alarm fires (15 min): the same bound as USER_MS, one reading of one rule",
  "collector/readings.mjs:STEP_MS": "a role mid-turn with no transcript movement for this long is stuck on a step (30 min, #C1005): the watchdog's own rule, read on the Mac; tuning it is its own card",
  "collector/readings.mjs:USER_MS": "a role stopped on a call the owner must answer for this long is stuck (15 min, #C593): the watchdog's own rule, read on the Mac; tuning it is its own card",
  "collector/readings.mjs:WEEK_MS": "the length of the quota week (7 days): a fact about the account's quota, not an operating number",
  "collector/readings.mjs:WINDOW_TOKENS": "the model's context window (1,000,000 tokens): a fact about the model, not an operating number",
  "collector/run-watchdog.mjs:REPORT_WAIT_MS": "how long the run watchdog waits to tell the store before it exits (5 s): bounded inside RUN_LIMIT_MS, a protocol bound on one best-effort call",
  "collector/run-watchdog.mjs:RUN_LIMIT_MS": "the probe's whole-run limit (5 min, #C719): tied to the launchd job's interval and alarm in the plist; changing it needs an owner install",
  "collector/state-schema.mjs:LIVE_FRESH_MS": "how old state.json may be and still count (3 min): the gate and the Collector read it through one schema and the page keeps a copy (liveOn); a reading window shared with the page, not a cadence",
  "collector/store-dispatch.mjs:AFTER_SHIP_WINDOW_MS": "how long after a ship Ops is woken for the check (24 h): a reading window on the evidence, not a cadence; tuning it is its own card",
  "collector/store-dispatch.mjs:DECISION_FRESH_MS": "how long an answered Decision may still wake its card's owner (24 h, #C872): an owner idle longer than that is someone else's problem; tuning it is its own card",
  "collector/watch-readings.mjs:QUIET_MS": "how long the permission-prompt ledger may be silent while agents work before the watch says so (24 h): a reading window on the ledger, not a cadence",
  "collector/fence.mjs:FRESH_MAX_MS": "decides who may write: how old a fenced state file may be and still count (30 min), the fence's own freshness, as FRESH_MAX is for the gate",
  "collector/fence.mjs:FUTURE_MAX_MS": "decides who may write: how far ahead of now a fenced time may read (1 min): a clock-skew tolerance and a sanity bound, not a cadence",
  // #C1113 slice 6: the rest of the baseline (collector/state.mjs, gate, hooks, scripts, the page). The reasons are the triage table's (docs/ops-knobs-triage.md).
  "collector/state.mjs:BACKOFF_MAX_MS": "the longest back-off wait (30 min): the top of the same doubling (collector/state.mjs)",
  "collector/state.mjs:BACKOFF_MIN_MS": "the first wait after a failed gh call (60 s): the shape of the back-off, which doubles to BACKOFF_MAX_MS (collector/state.mjs)",
  "collector/state.mjs:CI_BATCH_LIMIT": "how many CI runs one batched list reads (100): a cost bound on gh, not a time (collector/state.mjs)",
  "collector/state.mjs:REREAD_DONE_MS": "how long after done_at a closed product card that has not read live is read again (14 days, #C1379): a cost bound, about ten git or gh calls a card a run, so one that never reads live is not read forever",
  "worker/reading.mjs:TIP_FUTURE_MS": "how far past now a commit's own date may be before the stuck rule ignores it (5 minutes, #C1399): clock skew between machines, a bound that keeps an author-set date from holding a card off stuck, not a tuning",
  "worker/compat-reading.mjs:CLOSED_WINDOW_MS":"how long after it closed a card is still served with its reading (7 days, #C1381, the contract's own window): a size bound on the compat answer, not a tuning",
  "collector/state.mjs:MIRROR_STALE_MS": "how old the board export may be for the asks (2 h): the answer gate's own window (collector/state.mjs)",
  "collector/state.mjs:QUIET_LOOKBACK_MS": "how far back the quiet-hours scan walks, minute by minute (48 h): a cost bound on one loop (collector/state.mjs)",
  "collector/state.mjs:RETRY_MS": "one more try 5 s later after a network blip (#C428), well inside launchd's minute (collector/state.mjs)",
  "collector/state.mjs:SHIP_CANDIDATE_MAX_MS": "how long a pushed ship candidate stays one (6 h): the bound behind SHIP_CI_WINDOW_MS (collector/state.mjs)",
  "collector/state.mjs:STACKS_FRESH_MS": "a stack-switch file older than 30 min reads as off: a reading window, and off is the safe reading (collector/state.mjs)",
  "collector/state.mjs:USAGE_EVERY_MS": "how often the usage job reads (5 min): the job's cadence, tied to the plist (collector/state.mjs)",
  "collector/state.mjs:USAGE_RETRY_MAX_MS": "the longest usage back-off (24 h), the top of the same back-off (collector/state.mjs)",
  "collector/state.mjs:USAGE_RETRY_MIN_MS": "the first wait after a failed usage read (10 min), the start of its back-off (collector/state.mjs)",
  "collector/state.mjs:WEEK_SPAN_MS": "the length of the usage week (7 days): a fact about the account's quota (collector/state.mjs)",
  "collector/state.mjs:WORKING_QUIET_MS": "a turn quiet for 15 min is read as idle (a session closed mid-turn): a reading rule on the transcript (collector/state.mjs)",
  "gate/reset.mjs:CLOSE_AGAIN_MS": "how often a CLOSE line repeats (2 h, #C682): the owner's own fix for a line that woke the lead too often (gate/reset.mjs)",
  "gate/reset.mjs:DISPATCH_ALIVE_MS": "a role's dispatch watch counts as running if its pid file was beaten within 90 s (gate/reset.mjs)",
  "gate/reset.mjs:DISPATCH_IDLE_MS": "how long an agent sits idle with a card to do and no turns before the first dispatch line (15 min) (gate/reset.mjs)",
  "gate/reset.mjs:DISPATCH_LATE_MS": "how long after a first dispatch line with nothing moved before level 2 (30 min), also named in the late line (gate/reset.mjs)",
  "gate/reset.mjs:DISPATCH_TURN_IDLE_MS": "how long an idle agent with a card turn waits before its first wake (60 s) (gate/reset.mjs)",
  "gate/reset.mjs:EVIDENCE_STALE_MS": "no card shows a commit for 10 min (the file is owner-pinned, and it is not the page's probe edge staleAfterSec) (gate/reset.mjs)",
  "gate/reset.mjs:GAP_AGAIN_MS": "how often a GAP line repeats (30 min), the repeat spacing of that line kind (gate/reset.mjs)",
  "gate/reset.mjs:LINE_AGAIN_MS": "how long before a printed line prints again (2 h), like CLOSE_AGAIN_MS (gate/reset.mjs)",
  "gate/stop.mjs:DISPATCH_ASK_GAP_MS": "the stop hook asks about the watch at most every 10 min, so a session that cannot run it is not stopped for ever (gate/stop.mjs)",
  "gate/wake.mjs:ALIVE_MAX_MS": "how old the wake watch's alive file may be (60 s): tied to the watch's own beat and POLL_MS (gate/wake.mjs)",
  "gate/wake.mjs:POLL_MS": "the wake watch's 5 s file poll: the feel of one watch, not an operating number",
  "hooks/red-ask-board.py:OPEN_ASKS_MAX_AGE_MS": "the export of open asks counts for 10 min: the hook's own freshness for a red line (hooks/red-ask-board.py)",
  "hooks/red-ask-board.py:OWNER_FRESH_MS": "an owner message under 10 min old defers the reset cue one turn: the reset rule's own window (hooks/red-ask-board.py)",
  "scripts/pickup-watch.mjs:FRESH": "5,000 TOKENS, not a time: a session whose Messages read under it has just been cleared (scripts/pickup-watch.mjs)",
  "scripts/prompt-watch.mjs:STUCK_MS": "a stopped prompt must be this old (30 min) before the push line names it, once per stop (scripts/prompt-watch.mjs)",
  "scripts/restart-check.mjs:LIVE_FRESH": "state.json older than 3 min reads as nothing: the restart check's own copy of the live-state window (LIVE_FRESH_MS) (scripts/restart-check.mjs)",
  "scripts/restart-ready.mjs:AGENT_QUIET_MS": "an agent active within 2 min counts as busy for the restart check (scripts/restart-ready.mjs)",
  "scripts/stack-ready.mjs:QUEUE_FRESH_MS": "how old the queue reading may be for stack-ready to trust it (15 min); a reading from the future is refused (scripts/stack-ready.mjs)",
  "scripts/stack-ready.mjs:STALE_LISTED": "20: how many stale branch names the line lists before \"and N more\"; a count, not a time (scripts/stack-ready.mjs)",
  "scripts/state-install.mjs:BOOT_POLL_MS": "0.5 s between looks while it boots: the same pause (scripts/state-install.mjs)",
  "scripts/state-install.mjs:BOOT_RETRY_MS": "2 s before a second bootstrap if launchd answers an error: the same pause (scripts/state-install.mjs)",
  "scripts/wake-watch.mjs:FOLLOW_WINDOW_MS": "the window (60 s) in which more than 3 pin changes end the --pinned launcher with a line instead of following them (#C1240): a loop guard on a re-install, not a cadence; six installs a day never reach it",
  "scripts/wake-watch.mjs:STALE_EXIT": "75: the exit code a watch ends with when the pin moved under a --pinned launcher (#C1240), the one thing the launcher reads it for; an exit code, not a time (scripts/wake-watch.mjs)",
  "scripts/state-install.mjs:BOOT_WAIT_MS": "10 s to wait for a launchd job to boot: a pause inside the install script (scripts/state-install.mjs)",
  "worker/probe-jobs.mjs:LAND_SUITE_SEC": "the group check's one suite run on a group head, added to the per-tip budget before such a tip starts (#C1146): tied to the same alarm and LAND_TIP_SEC (tests/group-check-before-land.test.mjs); changing it needs an owner install",
  "worker/probe-jobs.mjs:LAND_MARGIN_SEC": "the land job's margin before its limit: tied to the plist's alarm and the per-tip budget (tests/ship-lane-per-repo.test.mjs); changing it needs an owner install",
  "collector/store-dispatch.mjs:LAND_REPORT_FRESH_MS": "how long the land report counts as fresh: lives in the owner-pinned dispatch and must stay over the land job's interval plus limit (tests/ship-lane-per-repo.test.mjs); changing it needs an owner install",
  "worker/board-store.mjs:OUTAGE_KEEP_MS": "how long a recorded outage is kept (7 days): a retention bound on the table, not a cadence",
  "worker/board-rules.mjs:NOTE_FRESH_MS": "how long a written next_note counts as a card's reason (1 h, #C1093): a reading window on the note, not a cadence; Manager may move it to a setting with #C1113",
  "worker/board-rules.mjs:REVIEW_LATE_MS": "how long a review may run past its ETA before Manager is woken (30 min, #C1115): the owner's own number for a late review, not a cadence; Manager may move it to a setting with #C1113",
  "worker/board-rules.mjs:REVIEW_BASE_DEFAULT_MS": "the checker review's length when no checker has been measured yet (30 min, #C1115): a fallback for the review ETA, replaced by the measured median as soon as there is one",
  "collector/store-dispatch.mjs:SHIP_CI_FRESH_MS": "how old the heartbeat may be before the ship-CI wake concludes nothing (10 min, #C1105): a reading window on the evidence, not a cadence, and it lives in the owner-pinned dispatch",
  "collector/store-dispatch.mjs:SHIP_CI_PAIR_MS": "how far the ship reading may trail the heartbeat and still count as written in the same run (3 min, #C1105): a reading window on the evidence, not a cadence",
  "collector/store-dispatch.mjs:SHIP_CI_WINDOW_MS": "how long a ship candidate stays worth a wake (6 h, #C1105): the same bound as a candidate's own age (SHIP_CANDIDATE_MAX_MS), not a cadence",
  "worker/board-rules.mjs:ANSWERED_CLOSE_HOLD_MS": "how long after the owner's answer an agent may not close the ask (1 h, #C1109): the owner's own rule for his answers, a hold on the agent's close, not a cadence",
  "worker/board-store.mjs:SWEEP_EVERY_MS": "how often the shipped-branches Terminal ask is raised (weekly, #C1112): the card's own cadence, one ask a week",
  "worker/board-store.mjs:SWEEP_FRESH_MS": "how old the shipped-branches list may be before the store raises nothing from it (2 days, #C1112): a reading window on the evidence, not a cadence",
  "collector/probe-evidence.mjs:SWEEP_LIST_MS": "how often the probe re-reads the shipped branches (6 h, #C1112): a cost bound on git reads, well inside the 2-day window",
  // #C1386: the truth check's own bounds (collector/truth-check.mjs). It must not read the evidence's rules, so none of these is a setting the reading shares.
  "collector/truth-check.mjs:CLOSED_GRACE_MS": "how long a closed card whose reading is not done is left alone before the truth check compares it (1 h, #C1386): the contract's own wait, so a card that just closed is not called wrong",
  "collector/truth-check.mjs:CLOSED_WINDOW_MS": "how far back a closed card is still checked (7 days, #C1386): the same window the compat answer serves closed readings for, a size bound",
  "collector/truth-check.mjs:DEPLOY_SETTLE_MS": "how old a product's version commit must be before its deploy wait is called wrong (30 min, #C1386): the deploy run takes minutes, so a younger commit is not judged",
  "collector/truth-check.mjs:GIT_TIMEOUT_MS": "one git question's timeout in the truth check (15 s, #C1386): a cost bound inside the usage job's own limit",
  "worker/compat-usage.mjs:MAX_MIN": "a sanity bound",
  "worker/board-rules.mjs:STEP_PAST_MS": "write validity of a step's time",
  "worker/board-rules.mjs:STEP_FUTURE_MS": "write validity of a step's time",
  "scripts/board-land.mjs:HOLDS_FRESH_MS": "decides who may land: a hold's freshness",
  "worker/state-worker.mjs:RATE_MS": "protects the KV write rate",
  "worker/state-worker.mjs:WAKE_RATE_MS": "protects the KV write rate",
  "collector/probe-board.mjs:FETCH_TIMEOUT_MS": "derived from the job limit and the tails",
  "collector/probe-run.mjs:OUTER_EXTRA_SEC": "the launchd alarm's margin over the job limit",
  "collector/probe-evidence.mjs:POST_TAIL_SEC": "derived from the job limit",
  "collector/probe-evidence.mjs:LATE_TAIL_SEC": "derived from the job limit",
  "collector/probe-evidence.mjs:LIVE_SKIP_SEC": "derived from the job limit",
  "gate/wake.mjs:MAX_RUN_MS": "the 30 minute cap of the wake tool",
  "collector/store-dispatch.mjs:USAGE_FRESH_MS": "26 hours: a usage reading's day",
  "collector/store-dispatch.mjs:FOREIGN_WRITER_MS": "legacy guard",
};

// #C1151: a FIXED entry is keyed by file AND name ("scripts/pickup-watch.mjs:FRESH"), so a bare constant of the same name in another file is not exempt. scanAll lists every bare
// time constant, FIXED or not; scan lists those that are neither on FIXED nor on the baseline's business.
export function scan(dirs = DIRS, root = ROOT) {
  return scanAll(dirs, root).filter((key) => !Object.hasOwn(FIXED, key));
}
export function scanAll(dirs = DIRS, root = ROOT) {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(mjs|js|py)$/.test(name)) continue;
      const rel = relative(root, p);
      readFileSync(p, "utf8").split("\n").forEach((line) => {
        if (!/^\s*(?:export\s+)?(?:const|let)\s/.test(line) && !/^[A-Z][A-Z0-9_]*\s*=/.test(line)) return; // a declaration line (JS const, Python module constant)
        for (const m of line.matchAll(/\b([A-Z][A-Z0-9_]*)\s*=\s*(\d[\d_.e*+\-/() ]*?)\s*(?=[,;]|$|\/\/|#)/g)) {
          if (NAME.test(m[1]) && BARE.test(m[2].trim())) found.push(`${rel}:${m[1]}`);
        }
      });
    }
  };
  for (const d of dirs) { try { walk(join(root, d)); } catch { /* a folder this checkout lacks */ } }
  return [...new Set(found)].sort();
}

test("no new bare time or interval constant: each is a setting or on the FIXED list with a reason", () => {
  const fresh = scan();
  assert.deepEqual(fresh, [], `a new bare time constant: make it a setting (worker/knobs.mjs) or add its name to FIXED in this test with the reason\n${fresh.join("\n")}`);
});

// Checker 2's F1 on b45aae0d: with an empty baseline the rewrite path wrote every new constant into it and the lint went green. The baseline and its rewrite are gone, and stay gone.
test("the baseline is retired: no baseline file, and no rewrite path in this test", () => {
  assert.equal(existsSync(join(ROOT, "tests", "ops-knobs-baseline.json")), false, "tests/ops-knobs-baseline.json must not come back: a new constant is a setting or a FIXED entry");
  const src = readFileSync(new URL(import.meta.url), "utf8");
  assert.equal(/process\.env\.OPS_BASELINE/.test(src), false, "no environment switch may rewrite what the lint accepts");
});

test("every FIXED name has a reason", () => {
  for (const [k, why] of Object.entries(FIXED)) assert.ok(typeof why === "string" && why.length > 8, k);
});

test("the scanner sees a bare constant, a derived one and a comma declaration", () => {
  const dir = `${process.env.TMPDIR || "/tmp"}/ops-lint-${process.pid}`;
  mkdirSync(join(dir, "worker"), { recursive: true });
  writeFileSync(join(dir, "worker", "x.mjs"), "export const NEW_STALE_MS = 5 * 60_000;\nconst A_MS = KNOBS.x.default * 1000, OTHER_RETRY_SEC = 30;\nconst SIZE_MAX = 5;\nexport const FRESH_MS = 30 * 864e5;\n");
  // FRESH_MS is on FIXED for its own file only (#C1151), so the same name in worker/x.mjs is found too.
  try { assert.deepEqual(scan(["worker"], dir), ["worker/x.mjs:FRESH_MS", "worker/x.mjs:NEW_STALE_MS", "worker/x.mjs:OTHER_RETRY_SEC"]); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a FIXED entry exempts its own file only: the same name in another file is found (#C1151)", () => {
  const realKey = Object.keys(FIXED).find((k) => k.endsWith(":FRESH"));
  assert.ok(realKey, "scripts/pickup-watch.mjs:FRESH is on FIXED");
  const dir = `${process.env.TMPDIR || "/tmp"}/ops-lint-file-${process.pid}`;
  mkdirSync(join(dir, "scripts"), { recursive: true });
  const [file] = realKey.split(":");
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), "export const FRESH = 5_000;\n");
  writeFileSync(join(dir, "scripts", "other.mjs"), "export const FRESH = 5_000;\n");
  try { assert.deepEqual(scan(["scripts"], dir), ["scripts/other.mjs:FRESH"]); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("every FIXED entry names a bare constant that exists in its file (no dead entry)", () => {
  const all = new Set(scanAll());
  const dead = Object.keys(FIXED).filter((k) => !all.has(k));
  assert.deepEqual(dead, [], `these FIXED entries match no bare time constant: remove them\n${dead.join("\n")}`);
});

test("every FIXED key is a file and a name", () => {
  for (const k of Object.keys(FIXED)) assert.match(k, /^(?:worker|collector|scripts|hooks|gate)\/[A-Za-z0-9._\/-]+\.(?:mjs|js|py):[A-Z][A-Z0-9_]*$/, k);
});
