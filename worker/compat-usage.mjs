// Time spent, the usage tiles and the per-agent table (#C726 C3, board parity; docs/DATA.md rows 42 to 44).
// The old page computes agent minutes and the per-agent table ("Last 7 days, per agent") itself, from each card's phaseLog,
// which it builds from the steps collection: the store's phase history (#C723 B3b). The plan-week tile reads the probe's
// usage reading (probe.usage, already in the probe document). What it lacks is the usage collection: one row per day with the
// runner and automation minutes and the Actions cost. Those are the store's usage_days rows (migration 0001), written by the
// probe only, through POST /api/probe/usage (board-worker.mjs), never typed.
//
// Hooks (Boardsmith adds them, one line each):
//   board-store readView      usage: await readUsage(db)            (and in the tag's content)
//   compat-view compatView    applyUsage(collections, view)
// applyUsage and usageDayRefusal are pure.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MIN = 24 * 60 * 50; // fifty machines busy all day: anything above is not a reading
const FIELDS = { runner_minutes: [0, MAX_MIN], automation_minutes: [0, MAX_MIN], actions_usd: [0, 10_000] };

// One day's reading from the probe: { day, runner_minutes?, automation_minutes?, actions_usd? }. Agent minutes are not taken:
// the page counts them from the phase history, the one record of who worked when.
export function usageDayRefusal(row, now) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return { rule: "usage-shape", detail: "an object" };
  const extra = Object.keys(row).filter((k) => k !== "day" && !(k in FIELDS));
  if (extra.length) return { rule: "usage-shape", detail: `unknown fields ${extra.join(", ").slice(0, 80)}` };
  if (typeof row.day !== "string" || !DAY.test(row.day) || Number.isNaN(Date.parse(`${row.day}T00:00:00Z`))) return { rule: "usage-day", detail: String(row.day).slice(0, 20) };
  // A day more than one day ahead of the Worker's clock (time zones) is no reading.
  if (Date.parse(`${row.day}T00:00:00Z`) > now + 864e5) return { rule: "usage-day", detail: `${row.day} is in the future` };
  for (const [k, [lo, hi]] of Object.entries(FIELDS)) if (k in row && !(typeof row[k] === "number" && Number.isFinite(row[k]) && row[k] >= lo && row[k] <= hi)) return { rule: "usage-value", detail: `${k} is a number from ${lo} to ${hi}` };
  if (!Object.keys(FIELDS).some((k) => k in row)) return { rule: "usage-shape", detail: "nothing to record" };
  return null;
}

// The probe's write: the day's row takes the fields it sends and keeps the others.
export async function writeUsageDay(db, now, row, refuse, who = "probe") {
  const bad = usageDayRefusal(row, now);
  if (bad) return refuse(db, now, bad, null, who);
  const keys = Object.keys(FIELDS).filter((k) => k in row);
  await db.prepare(`INSERT INTO usage_days (day, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")}) ON CONFLICT (day) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(", ")}`)
    .bind(row.day, ...keys.map((k) => row[k])).run();
  return { ok: true, day: row.day };
}

export async function readUsage(db) {
  return (await db.prepare("SELECT day, runner_minutes, automation_minutes, actions_usd FROM usage_days ORDER BY day").all()).results;
}

// Pure: the old usage docs, { id, day, runnerMin, actionsMin, actionsUsd }. No agentMin: with one, the page would stop
// counting agent minutes from the history for that day.
export function applyUsage(collections, view) {
  if (view.usage === undefined) return collections;
  collections.usage = (view.usage ?? []).map((u) => ({ id: u.day, day: u.day, runnerMin: Math.round(u.runner_minutes), actionsMin: Math.round(u.automation_minutes), actionsUsd: Math.round(u.actions_usd * 100) / 100 }));
  return collections;
}
