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
