// #C988: the week's share of the plan as Claude itself shows it ("Weekly · all models" in get_usage), written to the store by a session
// that can read it (the context keeper, on each run) through the week_usage door tool, as evidence key usage.week: { pct, resetsAt, by }.
// The probe can't call get_usage, and its own figure is an estimate from this Mac's transcripts (28% on the tile while Claude showed 39%,
// #C842). So the dispatch's quota stop and the Plan week tile prefer the session's reading while it is fresh (written within the last hour,
// for the week still running); an older one is unknown: no stop, a warning. With no session reading at all, the probe's estimate stays.
// Pure (no network, no file system, no clock: `now` is passed in), so the Worker and the probe share it.
import { WEEK_MS, AMBER_PACE, RED_PACE } from "./readings.mjs";

export const WEEK_USAGE_KEY = "usage.week", SESSION_WEEK_FRESH_MS = 3600e3;
const ROLE_WORD = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

// The tool's arguments -> { value } to store, or { refused: detail }. percent: a whole percent from 0 to 100, as get_usage gives it;
// resets_at: get_usage's resetsAt (an ISO time), in the future and at most 8 days away (a week, and a little for clocks).
// Security's LOW 2 on 1305a74: a low percent turns the quota stop off for an hour (the costly direction), and usage never falls within a week.
// So with `prev` (the stored value), a percent under prev.pct for the same week is refused (lower: true). The same week is a reset time within
// an hour of the stored one (get_usage's resetsAt moves by milliseconds between reads); a new week's reset starts fresh. A high bogus value
// only stops new build work for an hour, which fails safe.
export const SAME_WEEK_MS = 3600e3;
export function weekUsageValue(args, now, who, prev = null) {
  const pct = args?.percent, at = typeof args?.resets_at === "string" && args.resets_at.length <= 40 ? Date.parse(args.resets_at) : NaN;
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) return { refused: "percent is a whole number from 0 to 100: get_usage's \"Weekly · all models\" percentUsed" };
  if (!Number.isFinite(at)) return { refused: "resets_at is get_usage's resetsAt for \"Weekly · all models\" (an ISO time)" };
  if (at <= now || at > now + WEEK_MS + 24 * 3600e3) return { refused: "resets_at must be in the future and at most 8 days away" };
  if (typeof who !== "string" || !ROLE_WORD.test(who)) return { refused: "the writer is a role" };
  if (prev && Number.isInteger(prev.pct) && Number.isFinite(prev.resetsAt) && Math.abs(prev.resetsAt - at) < SAME_WEEK_MS && pct < prev.pct) return { refused: `percent ${pct} is under the ${prev.pct} already stored for this week: usage never falls within a week`, lower: true };
  return { value: { pct, resetsAt: Math.round(at), by: who } };
}

// The view's session reading: { state: "fresh", pct, resetsAt, readAt, by } | { state: "stale", readAt, ageMs } | { state: "none" }.
// Stale: written over an hour ago, from a week that has since reset, or from the future.
export function sessionWeek(view, now) {
  const e = view?.evidence?.[WEEK_USAGE_KEY], v = e?.value, readAt = e?.readAt;
  if (!v || typeof v !== "object" || !Number.isInteger(v.pct) || v.pct < 0 || v.pct > 100 || !Number.isFinite(v.resetsAt) || !Number.isFinite(readAt)) return { state: "none" };
  if (now - readAt > SESSION_WEEK_FRESH_MS || readAt > now + 60e3 || v.resetsAt <= now) return { state: "stale", readAt, ageMs: Math.max(0, now - readAt) };
  return { state: "fresh", pct: v.pct, resetsAt: v.resetsAt, readAt, by: typeof v.by === "string" ? v.by : null };
}

// The probe's usage tile with the session's fresh reading in place of its estimate: the percent Claude shows, its pace over the week gone,
// the level from that pace, and src "session" (the page then drops "est."). Anything else, the tile as it was.
export function withSessionWeek(usage, view, now) {
  const s = sessionWeek(view, now);
  if (s.state !== "fresh" || !usage || typeof usage !== "object" || Array.isArray(usage)) return usage;
  const gone = 1 - (s.resetsAt - now) / WEEK_MS;
  const pace = gone >= 0.02 && gone <= 1 ? Math.min(10000, Math.round((s.pct / 100 / gone) * 100)) : null;
  const x = pace === null ? 0 : pace / 100;
  return { ...usage, weekPct: s.pct, pace, level: x >= RED_PACE ? "red" : x >= AMBER_PACE ? "amber" : "ok", src: "session", srcAt: s.readAt };
}
