// #C997: the operational numbers that are settings, in one place. Imports nothing, so the Worker, the probe and the Mac scripts read the same table.
// The board config's `ops` section holds { key: number } (seconds). It is read at EVERY run on the Mac; the Worker has no board config, so the
// evidence job posts resolveKnobs()'s answer under the evidence key `knobs` and the Worker reads it from the store (as it reads `look`).
// A value that is missing keeps its default quietly. A value that is not a number, below its minimum, above its maximum or not under the
// setting it must stay under is IGNORED: the default stands and the page's header names the setting and why (never a refused config file).
// Stays in code, never a setting: anything that decides who may sign, land or deploy, and the write-validity windows (see FIXED below).
export const KNOBS = {
  // launchd fires the job every minute (its plist is written at install); a longer interval makes a run skip until due, so the floor is 60 s.
  evidenceIntervalSec: { default: 60, min: 60, max: 600, label: "how often the evidence job starts (s)" },
  // The plist's own alarm is the installed limit + 15 s, so the limit can be lowered here but not raised past what is installed (170 s).
  evidenceLimitSec: { default: 170, min: 60, max: 170, label: "the evidence job's time limit (s)" },
  slowRunSec: { default: 150, min: 30, max: 280, under: "evidenceLimitSec", label: "a run longer than this is shown as slow (s)" },
  staleAfterSec: { default: 300, min: 120, max: 1800, over: ["evidenceIntervalSec", "evidenceLimitSec"], label: "an evidence reading older than this is stale on the page (s)" },
  probeSilentSec: { default: 300, min: 120, max: 1800, over: ["evidenceIntervalSec", "evidenceLimitSec"], label: "no probe post for this long makes the Probe chip silent (s)" },
  // #C1106 part B, the Worker-side step clocks (posted by the probe in the `knobs` key, read by the store at each run).
  stallAfterSec: { default: 900, min: 120, max: 7200, label: "a card waits this long at a phase with its agent idle before Manager is woken (s)" },
  shipSlowSec: { default: 660, min: 120, max: 3600, label: "Release's ship step is slow after this long (s)" },
  postedFreshSec: { default: 3600, min: 600, max: 86400, label: "a read-only role's card counts as worked while its thread had a post this recent (s)" },
  landedUnbuiltSec: { default: 1800, min: 300, max: 14400, label: "a landed card with no deploy pair holding it wakes its owner after this long (s)" },
  copyStaleSec: { default: 3600, min: 600, max: 172800, label: "the probe's copy of a repository is stale when its oldest card reading is older than this (s)" },
  holdNoEndSec: { default: 7200, min: 600, max: 86400, label: "a hold with no end wakes Manager after this long, and the store gives a waiting_on this end (s)" },
  autoCloseSec: { default: 1800, min: 300, max: 86400, label: "the board closes an answered Decision this long after its card moved on (s)" },
  // Manager's wake (row 4): when a sent batch counts as not taken, how often an untaken one is sent again, how soon a failed send to the owner's words is retried,
  // and how long without an ask makes the chip red.
  wakeTakenSec: { default: 180, min: 60, max: 1800, label: "a batch not read this long after a good send is a failure (s)" },
  wakeResendSec: { default: 300, min: 60, max: 3600, label: "an untaken batch is sent again at most this often (s)" },
  wakeRetryFailedSec: { default: 60, min: 20, max: 600, label: "a failed send is retried this soon while the owner's own words wait (s)" },
  askStaleSec: { default: 180, min: 90, max: 1800, label: "the Manager chip is red when the probe has not asked the store for this long (s)" },
  // The share of the week at which the idle-agent stall lines are held and Manager gets one line (the Worker's #C1078 hold); the dispatch's own ceiling for new build work is collector.quotaCeilingPct.
  quotaOutPct: { default: 98, min: 50, max: 100, label: "at this share of the week's quota the idle-agent stall lines are held until the reset (%)" },
  // What the board says to Manager and pushes to the owner's phone, and when (worker/push-rules.mjs). The nudge to Manager stays under the owner's push.
  managerNudgeSec: { default: 600, min: 120, max: 3600, under: "ownerPushSec", label: "an ask the owner has not answered wakes Manager after this long (s)" },
  ownerPushSec: { default: 1800, min: 300, max: 14400, label: "an ask the owner has not answered goes to the owner's phone after this long (s)" },
  ownerWordSec: { default: 600, min: 120, max: 3600, label: "a thread ending on the owner's word wakes Manager after this long (s)" },
  ownerWordRepeatSec: { default: 1800, min: 300, max: 14400, label: "...and again this often at first (s)" },
  ownerWordSlowRepeatSec: { default: 10800, min: 1800, max: 86400, label: "...then this often after four reminders (s)" },
  ownerWordWindowSec: { default: 604800, min: 86400, max: 2592000, label: "only owner words newer than this are read (s)" },
  promptSec: { default: 1800, min: 300, max: 14400, label: "a role stopped on a prompt for the owner wakes Manager and the phone after this long (s)" },
  // #C1113 (Checker 2's LOW on #C1106): the silence must outlast one whole evidence cycle, or a healthy probe with a long interval sends false "Mac may be down" pushes (300 s against a 600 s interval).
  silentPushSec: { default: 900, min: 300, max: 7200, over: ["evidenceIntervalSec", "evidenceLimitSec"], label: "the phone is told the Mac may be down after this long without a post (s)" },
  shipWindowSec: { default: 604800, min: 86400, max: 2592000, label: "a ship is pushed only while it is newer than this and unacknowledged (s)" },
  // #C1113 slice 3: three more Worker-side windows.
  stuckFreshSec: { default: 900, min: 120, max: 7200, over: ["evidenceIntervalSec", "evidenceLimitSec"], label: "the probe's stuck reading counts for the phone's push while it was written within this (s)" },
  stuckWindowSec: { default: 86400, min: 3600, max: 604800, label: "a refused write shows on the page's stuck line for this long (s)" },
  threadWindowSec: { default: 7200, min: 600, max: 86400, label: "an owner thread whose last word is newer than this blocks a decision naming the same card or ask (s)" },
  // Not settings (#C1113): gate/reset.mjs EVIDENCE_STALE_MS (no card shows a commit for 10 min; the file is pinned by the owner's install, so changing it needs an
  // owner pack, and it is NOT the page's probe edge staleAfterSec) and collector/store-dispatch.mjs AGENTS_FRESH_MS are on the lint's FIXED list with their reasons
  // (tests/ops-knobs-lint.test.mjs, docs/ops-knobs-triage.md); one that needs tuning later gets its own card.
};
export const KNOB_KEYS = Object.keys(KNOBS);

// raw: the config's `ops` value (anything). Returns { values: { key: number }, ignored: [{ key, why }] }; values has every key.
export function resolveKnobs(raw) {
  const values = {}, ignored = [];
  const bag = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (raw !== undefined && raw !== null && bag !== raw) ignored.push({ key: "ops", why: "unreadable" });
  for (const [key, k] of Object.entries(KNOBS)) {
    values[key] = k.default;
    if (!Object.hasOwn(bag, key)) continue;
    const v = bag[key];
    if (typeof v !== "number" || !Number.isFinite(v)) ignored.push({ key, why: "not a number" });
    else if (v < k.min) ignored.push({ key, why: "too low" });
    else if (v > k.max) ignored.push({ key, why: "too high" });
    else values[key] = v;
  }
  // A setting that must stay under another is checked after both are resolved.
  // The owner is told only about a setting they wrote; a default that has to move because they changed another one moves quietly.
  for (const [key, k] of Object.entries(KNOBS)) {
    if (k.under && values[key] >= values[k.under] && !ignored.some((i) => i.key === key)) {
      if (Object.hasOwn(bag, key)) ignored.push({ key, why: `not under ${k.under}` });
      values[key] = Math.min(k.default, values[k.under] - 1);
    }
  }
  // A reading must outlive one whole evidence cycle (interval + limit), or the page goes stale between two healthy runs (Checker 2's M2).
  for (const [key, k] of Object.entries(KNOBS)) {
    if (!k.over) continue;
    const floor = k.over.reduce((s, o) => s + values[o], 0);
    if (values[key] > floor) continue;
    if (Object.hasOwn(bag, key) && !ignored.some((i) => i.key === key)) ignored.push({ key, why: "not over interval plus limit" });
    values[key] = Math.min(k.max, Math.max(k.default, floor + 1));
  }
  for (const key of Object.keys(bag)) if (!Object.hasOwn(KNOBS, key)) ignored.push({ key, why: "unknown setting" });
  return { values, ignored };
}

// The shape the Worker accepts under the evidence key `knobs`: { values: {known key: finite number}, ignored: [{ key, why }] up to 40 }.
const WHY = /^[a-z][a-z0-9 _-]{0,40}$/i, KEY = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
export const knobsShape = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => k === "values" || k === "ignored")
  && v.values !== null && typeof v.values === "object" && !Array.isArray(v.values) && Object.entries(v.values).every(([k, n]) => Object.hasOwn(KNOBS, k) && Number.isFinite(n) && n >= KNOBS[k].min && n <= KNOBS[k].max)
  && Array.isArray(v.ignored) && v.ignored.length <= 40 && v.ignored.every((i) => i !== null && typeof i === "object" && typeof i.key === "string" && KEY.test(i.key) && typeof i.why === "string" && WHY.test(i.why));

// The value of a setting from a stored reading (the Worker side): the reading's number when it is known and valid, else the default.
export const knobFrom = (stored, key) => {
  const k = KNOBS[key], vals = stored?.values;
  const n = vals !== null && typeof vals === "object" && Object.hasOwn(vals, key) ? vals[key] : undefined;
  return Number.isFinite(n) && n >= k.min && n <= k.max ? n : k.default;
};
