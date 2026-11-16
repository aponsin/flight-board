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
  LAND_TIP_SEC: "the land job's per-tip budget: tied to the job's limit, which launchd's plist holds, and to LAND_REPORT_FRESH_MS (tests/ship-lane-per-repo.test.mjs); changing it needs an owner install",
  LAND_MARGIN_SEC: "the land job's margin before its limit: tied to the plist's alarm and the per-tip budget (tests/ship-lane-per-repo.test.mjs); changing it needs an owner install",
  LAND_REPORT_FRESH_MS: "how long the land report counts as fresh: lives in the owner-pinned dispatch and must stay over the land job's interval plus limit (tests/ship-lane-per-repo.test.mjs); changing it needs an owner install",
  OUTAGE_KEEP_MS: "how long a recorded outage is kept (7 days): a retention bound on the table, not a cadence",
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
