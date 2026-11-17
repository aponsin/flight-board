// #C997 (the card's third test): a bare time, interval, threshold or retry constant added in worker/, collector/, scripts/, hooks/ or gate/ fails
// this test unless it is a setting (worker/knobs.mjs: its value then comes from KNOBS, not a number) or is on the short FIXED list below with a reason.
// The ones that exist today and are not yet settings sit on the frozen BASELINE (tests/ops-knobs-baseline.json): it only SHRINKS. A baseline entry whose
// constant is gone or became a setting must be removed from the file (the test names it), and nothing may be added to it.
// OPS_BASELINE_WRITE=1 rewrites the baseline from the code (use it only to REMOVE entries; the test refuses a rewrite that grows it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["worker", "collector", "scripts", "hooks", "gate"];
const BASELINE_FILE = join(ROOT, "tests", "ops-knobs-baseline.json");

// Time-ish names: ends in _MS/_SEC/_MIN/_HOURS/_DAYS or holds TIMEOUT, INTERVAL, STALE, FRESH, WITHIN, AFTER, AGAIN, LIMIT, QUIET, WINDOW, REPEAT, BACKOFF, RETRY.
const NAME = /(?:_(?:MS|SEC|MIN|HOURS|DAYS)$|TIMEOUT|INTERVAL|STALE|FRESH|WITHIN|_AFTER|AGAIN|LIMIT|QUIET|WINDOW|REPEAT|BACKOFF|RETRY)/;
// A plain numeric expression: digits, underscores, dots, e, * + - / ( ) and spaces. A name or call in it makes it NOT bare (it is derived).
const BARE = /^\d[\d_.e*+\-/() ]*$/;

// The constants that stay in code on purpose, by name, with the reason (the inventory's FIXED list: they decide who may sign, land or deploy, protect KV or a
// protocol, or are write-validity windows and sanity bounds). Adding a name here is a reviewed decision, like adding a setting.
export const FIXED = {
  FRESH_MS: "a sanity bound on a posted time (30 days)",
  ACTIVITY_SKEW_MS: "how far ahead of now a session's lastActivityAt may read and still count as activity (5 min, #C1143): a clock-skew tolerance and a sanity bound on a time the probe wrote, not a cadence",
  LAND_TIP_SEC: "the land job's per-tip budget: tied to the job's limit, which launchd's plist holds, and to LAND_REPORT_FRESH_MS (tests/ship-lane-per-repo.test.mjs); changing it needs an owner install",
  // #C1113 slice 2: four that are not operating numbers. Each name is unique in the repository, so the reason holds for every place it is declared.
  VAPID_HOURS: "the lifetime of the Web Push signature (12 h): RFC 8292 lets a push service refuse one over 24 h, so it is a protocol bound, not an operating number",
  UNDO_MS: "how long the page's Undo button stays (5 s): the feel of one control on a page that has no board config to read",
  HEARTBEAT_MS: "the state Worker's keep-alive write (15 min): it is tied to the daily KV write budget (WRITES_DEFAULT, the account's shared quota), so moving it moves that arithmetic and is a deploy decision",
  INLINE_LIST_MIN: "how many inline (1) (2) (3) markers in one paragraph count as a packed list (3): the threshold of a wording rule, not a time or an operating number",
  // #C1113 slice 4 (Manager: do not plumb the posted settings into the dispatch; one that needs tuning later gets its own card). Each name is unique in the repository.
  STALL_WAKE_AFTER_MS: "how long an idle-agent stall must have lasted before the stalled role itself is woken (30 min, #C1097): read by the dispatch (collector/store-dispatch.mjs), which never sees the posted settings; a second step after the Manager's stall line (stallAfterSec), so it is not a cadence; tuning it is its own card",
  AGENTS_FRESH_MS: "how old the agents reading may be before the dispatch trusts none of it (5 min): a reading window on the evidence the dispatch reads, the same kind as the page's staleAfterSec but read in the owner-pinned dispatch, which has no posted settings; tuning it is its own card",
  SESSION_WEEK_FRESH_MS: "how old a session's weekly-usage post may be and still count (1 h): a reading window on a session's own report, read on the Mac by the collector, which has no posted settings; tuning it is its own card",
  // #C1113 slice 5: the collector's reading windows, run limits and fixed facts (group B), and two write-validity windows (group C). Each name is unique in the repository.
  HOSTED_USD_PER_MIN: "GitHub's published price for a hosted runner minute ($0.008): a price, not an operating number",
  ABANDON_MS: "after this long with no evidence a plain build start counts as closed (30 min, #C654): a reading rule on the derived card, not a cadence; tuning it is its own card",
  SEND_TIMEOUT_MS: "the probe's send timeout (25 s): tied to the ask job's own 30 s limit, which the launchd plist holds; changing it needs an owner install",
  E2E_EVERY_MS: "how often the probe asks for the product's daily test run (30 min): a cost bound on gh reads inside the usage job's 5-minute cadence, not a setting",
  E2E_STALE_MS: "how old the kept e2e answer may be before it is written as unknown (2 h): a reading window on the evidence, well over E2E_EVERY_MS",
  REPOST_MS: "how long the probe waits before posting an unchanged evidence key again (10 min): tied to the page's and the store's freshness windows, which stay over it",
  NEEDS_USER_MS: "how long a role stopped on a call the owner must answer stays quiet before the prompt alarm fires (15 min): the same bound as USER_MS, one reading of one rule",
  STEP_MS: "a role mid-turn with no transcript movement for this long is stuck on a step (30 min, #C1005): the watchdog's own rule, read on the Mac; tuning it is its own card",
  USER_MS: "a role stopped on a call the owner must answer for this long is stuck (15 min, #C593): the watchdog's own rule, read on the Mac; tuning it is its own card",
  WEEK_MS: "the length of the quota week (7 days): a fact about the account's quota, not an operating number",
  WINDOW_TOKENS: "the model's context window (1,000,000 tokens): a fact about the model, not an operating number",
  REPORT_WAIT_MS: "how long the run watchdog waits to tell the store before it exits (5 s): bounded inside RUN_LIMIT_MS, a protocol bound on one best-effort call",
  RUN_LIMIT_MS: "the probe's whole-run limit (5 min, #C719): tied to the launchd job's interval and alarm in the plist; changing it needs an owner install",
  LIVE_FRESH_MS: "how old state.json may be and still count (3 min): the gate and the Collector read it through one schema and the page keeps a copy (liveOn); a reading window shared with the page, not a cadence",
  AFTER_SHIP_WINDOW_MS: "how long after a ship Ops is woken for the check (24 h): a reading window on the evidence, not a cadence; tuning it is its own card",
  DECISION_FRESH_MS: "how long an answered Decision may still wake its card's owner (24 h, #C872): an owner idle longer than that is someone else's problem; tuning it is its own card",
  QUIET_MS: "how long the permission-prompt ledger may be silent while agents work before the watch says so (24 h): a reading window on the ledger, not a cadence",
  FRESH_MAX_MS: "decides who may write: how old a fenced state file may be and still count (30 min), the fence's own freshness, as FRESH_MAX is for the gate",
  FUTURE_MAX_MS: "decides who may write: how far ahead of now a fenced time may read (1 min): a clock-skew tolerance and a sanity bound, not a cadence",
  // #C1113 slice 6: the rest of the baseline (collector/state.mjs, gate, hooks, scripts, the page). The reasons are the triage table's (docs/ops-knobs-triage.md); each name is matched across the repository.
  BACKOFF_MAX_MS: "the longest back-off wait (30 min): the top of the same doubling (collector/state.mjs)",
  BACKOFF_MIN_MS: "the first wait after a failed gh call (60 s): the shape of the back-off, which doubles to BACKOFF_MAX_MS (collector/state.mjs)",
  CI_BATCH_LIMIT: "how many CI runs one batched list reads (100): a cost bound on gh, not a time (collector/state.mjs)",
  CLOSED_PACK_DAYS: "how far back the done-card pack lookup reads (14 days, with 500 commits): a cost bound on one git log (collector/state.mjs)",
  MIRROR_STALE_MS: "how old the board export may be for the asks (2 h): the answer gate's own window (collector/state.mjs)",
  QUIET_LOOKBACK_MS: "how far back the quiet-hours scan walks, minute by minute (48 h): a cost bound on one loop (collector/state.mjs)",
  RETRY_MS: "one more try 5 s later after a network blip (#C428), well inside launchd's minute (collector/state.mjs)",
  SHIP_CANDIDATE_MAX_MS: "how long a pushed ship candidate stays one (6 h): the bound behind SHIP_CI_WINDOW_MS (collector/state.mjs)",
  STACKS_FRESH_MS: "a stack-switch file older than 30 min reads as off: a reading window, and off is the safe reading (collector/state.mjs)",
  USAGE_EVERY_MS: "how often the usage job reads (5 min): the job's cadence, tied to the plist (collector/state.mjs)",
  USAGE_RETRY_MAX_MS: "the longest usage back-off (24 h), the top of the same back-off (collector/state.mjs)",
  USAGE_RETRY_MIN_MS: "the first wait after a failed usage read (10 min), the start of its back-off (collector/state.mjs)",
  WEEK_SPAN_MS: "the length of the usage week (7 days): a fact about the account's quota (collector/state.mjs)",
  WORKING_QUIET_MS: "a turn quiet for 15 min is read as idle (a session closed mid-turn): a reading rule on the transcript (collector/state.mjs)",
  CLOSE_AGAIN_MS: "how often a CLOSE line repeats (2 h, #C682): the owner's own fix for a line that woke the lead too often (gate/reset.mjs)",
  DISPATCH_ALIVE_MS: "a role's dispatch watch counts as running if its pid file was beaten within 90 s (gate/reset.mjs)",
  DISPATCH_IDLE_MS: "how long an agent sits idle with a card to do and no turns before the first dispatch line (15 min) (gate/reset.mjs)",
  DISPATCH_LATE_MS: "how long after a first dispatch line with nothing moved before level 2 (30 min), also named in the late line (gate/reset.mjs)",
  DISPATCH_TURN_IDLE_MS: "how long an idle agent with a card turn waits before its first wake (60 s) (gate/reset.mjs)",
  EVIDENCE_STALE_MS: "no card shows a commit for 10 min (the file is owner-pinned, and it is not the page's probe edge staleAfterSec) (gate/reset.mjs)",
  GAP_AGAIN_MS: "how often a GAP line repeats (30 min), the repeat spacing of that line kind (gate/reset.mjs)",
  LINE_AGAIN_MS: "how long before a printed line prints again (2 h), like CLOSE_AGAIN_MS (gate/reset.mjs)",
  DISPATCH_ASK_GAP_MS: "the stop hook asks about the watch at most every 10 min, so a session that cannot run it is not stopped for ever (gate/stop.mjs)",
  ALIVE_MAX_MS: "how old the wake watch's alive file may be (60 s): tied to the watch's own beat and POLL_MS (gate/wake.mjs)",
  POLL_MS: "one name, two polls: the wake watch's 5 s file poll and the page's 2.5 s poll of the store; each is the feel of one control or one watch, not an operating number (gate/wake.mjs and worker/page.mjs)",
  OPEN_ASKS_MAX_AGE_MS: "the export of open asks counts for 10 min: the hook's own freshness for a red line (hooks/red-ask-board.py)",
  OWNER_FRESH_MS: "an owner message under 10 min old defers the reset cue one turn: the reset rule's own window (hooks/red-ask-board.py)",
  FRESH: "5,000 TOKENS, not a time: a session whose Messages read under it has just been cleared (scripts/pickup-watch.mjs)",
  STUCK_MS: "a stopped prompt must be this old (30 min) before the push line names it, once per stop (scripts/prompt-watch.mjs)",
  LIVE_FRESH: "state.json older than 3 min reads as nothing: the restart check's own copy of the live-state window (LIVE_FRESH_MS) (scripts/restart-check.mjs)",
  AGENT_QUIET_MS: "an agent active within 2 min counts as busy for the restart check (scripts/restart-ready.mjs)",
  OUTSIDE_QUIET_MS: "5 min, declared beside AGENT_QUIET_MS but read nowhere in scripts, collector or gate: possibly dead; removing it is its own card (scripts/restart-ready.mjs)",
  QUEUE_FRESH_MS: "how old the queue reading may be for stack-ready to trust it (15 min); a reading from the future is refused (scripts/stack-ready.mjs)",
  STALE_LISTED: "20: how many stale branch names the line lists before \"and N more\"; a count, not a time (scripts/stack-ready.mjs)",
  BOOT_POLL_MS: "0.5 s between looks while it boots: the same pause (scripts/state-install.mjs)",
  BOOT_RETRY_MS: "2 s before a second bootstrap if launchd answers an error: the same pause (scripts/state-install.mjs)",
  BOOT_WAIT_MS: "10 s to wait for a launchd job to boot: a pause inside the install script (scripts/state-install.mjs)",
  LAND_MARGIN_SEC: "the land job's margin before its limit: tied to the plist's alarm and the per-tip budget (tests/ship-lane-per-repo.test.mjs); changing it needs an owner install",
  LAND_REPORT_FRESH_MS: "how long the land report counts as fresh: lives in the owner-pinned dispatch and must stay over the land job's interval plus limit (tests/ship-lane-per-repo.test.mjs); changing it needs an owner install",
  OUTAGE_KEEP_MS: "how long a recorded outage is kept (7 days): a retention bound on the table, not a cadence",
  NOTE_FRESH_MS: "how long a written next_note counts as a card's reason (1 h, #C1093): a reading window on the note, not a cadence; Manager may move it to a setting with #C1113",
  REVIEW_LATE_MS: "how long a review may run past its ETA before Manager is woken (30 min, #C1115): the owner's own number for a late review, not a cadence; Manager may move it to a setting with #C1113",
  REVIEW_BASE_DEFAULT_MS: "the checker review's length when no checker has been measured yet (30 min, #C1115): a fallback for the review ETA, replaced by the measured median as soon as there is one",
  SHIP_CI_FRESH_MS: "how old the heartbeat may be before the ship-CI wake concludes nothing (10 min, #C1105): a reading window on the evidence, not a cadence, and it lives in the owner-pinned dispatch",
  SHIP_CI_PAIR_MS: "how far the ship reading may trail the heartbeat and still count as written in the same run (3 min, #C1105): a reading window on the evidence, not a cadence",
  SHIP_CI_WINDOW_MS: "how long a ship candidate stays worth a wake (6 h, #C1105): the same bound as a candidate's own age (SHIP_CANDIDATE_MAX_MS), not a cadence",
  ANSWERED_CLOSE_HOLD_MS: "how long after the owner's answer an agent may not close the ask (1 h, #C1109): the owner's own rule for his answers, a hold on the agent's close, not a cadence",
  SWEEP_EVERY_MS: "how often the shipped-branches Terminal ask is raised (weekly, #C1112): the card's own cadence, one ask a week",
  SWEEP_FRESH_MS: "how old the shipped-branches list may be before the store raises nothing from it (2 days, #C1112): a reading window on the evidence, not a cadence",
  SWEEP_LIST_MS: "how often the probe re-reads the shipped branches (6 h, #C1112): a cost bound on git reads, well inside the 2-day window",
  MAX_MIN: "a sanity bound",
  STEP_PAST_MS: "write validity of a step's time",
  STEP_FUTURE_MS: "write validity of a step's time",
  FRESH_MAX: "decides who may write: the fence's freshness",
  HOLDS_FRESH_MS: "decides who may land: a hold's freshness",
  RATE_MS: "protects the KV write rate",
  WAKE_RATE_MS: "protects the KV write rate",
  FETCH_TIMEOUT_MS: "derived from the job limit and the tails",
  OUTER_EXTRA_SEC: "the launchd alarm's margin over the job limit",
  POST_TAIL_SEC: "derived from the job limit",
  LATE_TAIL_SEC: "derived from the job limit",
  LIVE_SKIP_SEC: "derived from the job limit",
  MAX_RUN_MS: "the 30 minute cap of the wake tool",
  USAGE_FRESH_MS: "26 hours: a usage reading's day",
  FOREIGN_WRITER_MS: "legacy guard",
};

export function scan(dirs = DIRS, root = ROOT) {
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
          if (NAME.test(m[1]) && BARE.test(m[2].trim()) && !FIXED[m[1]]) found.push(`${rel}:${m[1]}`);
        }
      });
    }
  };
  for (const d of dirs) { try { walk(join(root, d)); } catch { /* a folder this checkout lacks */ } }
  return [...new Set(found)].sort();
}

const readBaseline = () => JSON.parse(readFileSync(BASELINE_FILE, "utf8"));

test("no new bare time or interval constant: each is a setting, on the FIXED list with a reason, or already on the frozen baseline", () => {
  const found = scan(), base = new Set(readBaseline());
  if (process.env.OPS_BASELINE_WRITE === "1") {
    const old = new Set(readBaseline());
    const next = found.filter((f) => old.size === 0 || old.has(f));
    writeFileSync(BASELINE_FILE, JSON.stringify(old.size === 0 ? found : next, null, 1) + "\n");
    return;
  }
  const fresh = found.filter((f) => !base.has(f));
  assert.deepEqual(fresh, [], `a new bare time constant: make it a setting (worker/knobs.mjs) or add its name to FIXED in this test with the reason\n${fresh.join("\n")}`);
});

test("the baseline only shrinks: an entry whose constant is gone or became a setting is removed from tests/ops-knobs-baseline.json", () => {
  const found = new Set(scan());
  const stale = readBaseline().filter((b) => !found.has(b));
  assert.deepEqual(stale, [], `remove these from tests/ops-knobs-baseline.json (run once with OPS_BASELINE_WRITE=1):\n${stale.join("\n")}`);
});

test("every FIXED name has a reason", () => {
  for (const [k, why] of Object.entries(FIXED)) assert.ok(typeof why === "string" && why.length > 8, k);
});

test("the scanner sees a bare constant, a derived one and a comma declaration", () => {
  const dir = `${process.env.TMPDIR || "/tmp"}/ops-lint-${process.pid}`;
  mkdirSync(join(dir, "worker"), { recursive: true });
  writeFileSync(join(dir, "worker", "x.mjs"), "export const NEW_STALE_MS = 5 * 60_000;\nconst A_MS = KNOBS.x.default * 1000, OTHER_RETRY_SEC = 30;\nconst SIZE_MAX = 5;\nexport const FRESH_MS = 30 * 864e5;\n");
  try { assert.deepEqual(scan(["worker"], dir), ["worker/x.mjs:NEW_STALE_MS", "worker/x.mjs:OTHER_RETRY_SEC"]); } finally { rmSync(dir, { recursive: true, force: true }); }
});
