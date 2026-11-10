// The runner and Actions usage the store's usage job posts (#C736, board parity). The old board got one doc a day from the usage script
// (usage.py <day>, in the owner's board folder): every workflow run created that day, every job's started-to-completed minutes, split by whether the job's labels
// name a self-hosted runner. Runner minutes are the self-hosted ones; automation minutes are the hosted ones, and the Actions cost is those at
// $0.008 a minute. This is the same count, for the store's usage_days rows (POST /api/probe/usage, the probe only; worker/compat-usage.mjs).
// Pure over an injected `gh(args) -> parsed JSON`: nothing here runs a process or touches the network by itself.

export const HOSTED_USD_PER_MIN = 0.008;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The usage of one day (a YYYY-MM-DD date, the day runs were created on, as the old script asked GitHub for it).
export function actionsDay(day, gh) {
  if (!DAY.test(day)) throw new Error(`day: ${day}`);
  const runs = [];
  for (let page = 1; page <= 20; page++) {
    const r = gh([`repos/{owner}/{repo}/actions/runs?created=${day}&per_page=100&page=${page}`])?.workflow_runs ?? [];
    runs.push(...r);
    if (r.length < 100) break;
  }
  let self = 0, hosted = 0;
  for (const run of runs) {
    if (!Number.isInteger(run?.id)) continue;
    for (const j of gh([`repos/{owner}/{repo}/actions/runs/${run.id}/jobs?per_page=100`])?.jobs ?? []) {
      const a = Date.parse(j?.started_at ?? ""), b = Date.parse(j?.completed_at ?? "");
      if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
      const m = (b - a) / 60_000;
      if (Array.isArray(j.labels) && j.labels.includes("self-hosted")) self += m; else hosted += m;
    }
  }
  return { day, runner_minutes: Math.round(self), automation_minutes: Math.round(hosted), actions_usd: Math.round(hosted * HOSTED_USD_PER_MIN * 100) / 100 };
}

// The UTC dates to read now: today and yesterday (a day is read again until it is a day old, so its last runs are counted).
export function usageDays(now) {
  const d = (ms) => new Date(ms).toISOString().slice(0, 10);
  return [d(now), d(now - 864e5)];
}

// Which of those days to read this run, given when each was last read ({ day: ms }): today at most every `everyMs` (the job runs every 5
// minutes and each run costs one request per workflow run), yesterday until it has been read after it ended, then never.
export function daysDue(now, seen = {}, everyMs = 30 * 60_000) {
  const [today, yesterday] = usageDays(now);
  const out = [];
  const endOfYesterday = Date.parse(`${today}T00:00:00Z`);
  if (!(Number.isFinite(seen[today]) && now - seen[today] < everyMs)) out.push(today);
  if (!(Number.isFinite(seen[yesterday]) && seen[yesterday] >= endOfYesterday)) out.push(yesterday);
  return out;
}

// One run: read the days that are due, post each, and return the new seen-map (only days that posted are marked read).
// post(row) -> Promise<boolean>; a gh failure for one day is logged and leaves that day due.
export async function runActionsUsage({ now, seen = {}, gh, post, log = () => {} }) {
  const next = {};
  for (const d of usageDays(now)) if (Number.isFinite(seen[d])) next[d] = seen[d];
  let posted = 0;
  for (const day of daysDue(now, seen)) {
    let row;
    try { row = actionsDay(day, gh); } catch (e) { log(`actions usage ${day}: ${String(e.message).slice(0, 80)}`); continue; }
    if (await post(row)) { next[day] = now; posted++; } else log(`actions usage ${day}: the store did not take it`);
  }
  return { seen: next, posted };
}
