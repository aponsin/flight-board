// The probe's own readings, without a model (#C592 keeper, #C593 watchdog, #C595 usage): pure functions over what
// collector/state.mjs already reads from the transcripts and the app's session files. Numbers, times and enums come out
// (collector/state-schema.mjs's ctx, stuck and usage); no text of a transcript or a title does.
import { ROLE } from "./state-schema.mjs";

// A role in the last assistant entry's usage fields: the tokens its next turn is sent with. Null without one.
export function contextTokens(entries) {
  const e = entries.findLast((x) => x.type === "assistant" && x.message?.usage && typeof x.message.usage === "object");
  if (!e) return null;
  const u = e.message.usage, n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  const t = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  return t > 0 && t <= 5e6 ? t : null;
}

// Each role's context (#C592): { <role>: { pct, tokens, at, over } } against the window (the board's resetAt is where the
// roles reset, so pct is of the window and over is tokens at or past resetAt).
export const WINDOW_TOKENS = 1_000_000;
export function ctxReadings({ tokens, resetAt, now, window = WINDOW_TOKENS }) {
  const out = {};
  for (const [role, t] of Object.entries(tokens)) {
    if (!ROLE.test(role) || !Number.isInteger(t)) continue;
    out[role] = { pct: Math.min(100, Math.round((t / window) * 100)), tokens: t, at: now, over: t >= resetAt };
  }
  return out;
}

// The roles to send CONTEXT RESET to: over resetAt now and not asked since they last came back under it. before is the
// file kept from run to run, { roles: { <role>: <time asked> } }; the next one keeps only roles still over.
export function resetAsks(ctx, before, now) {
  const asked = before && typeof before.roles === "object" && before.roles && !Array.isArray(before.roles) ? before.roles : {};
  const roles = {}, fresh = [];
  for (const [role, c] of Object.entries(ctx)) {
    if (!c.over) continue;
    const t = Object.hasOwn(asked, role) ? asked[role] : null;
    if (Number.isInteger(t) && t > 0 && t <= now) roles[role] = t;
    else { roles[role] = now; fresh.push(role); }
  }
  return { roles, fresh: fresh.sort() };
}

// A role stuck (#C593): working on one prompt over STEP_MS (the same step, the turn's start unmoved), or stopped on a call
// the owner must answer over USER_MS (promptSince from the transcript). { <role>: { kind, card, since } }; the lead and
// the idle are never stuck on a step.
export const STEP_MS = 45 * 60e3, USER_MS = 15 * 60e3;
export function stuckReadings({ agents, prompts, now, lead = "" }) {
  const out = {};
  for (const [role, a] of Object.entries(agents)) {
    if (!ROLE.test(role)) continue;
    const asked = prompts[role];
    if (Number.isInteger(asked) && now - asked > USER_MS) out[role] = { kind: "user", card: a.card ?? null, since: asked };
    else if (role !== lead && a.state === "working" && Number.isInteger(a.since) && now - a.since > STEP_MS) out[role] = { kind: "step", card: a.card ?? null, since: a.since };
  }
  return out;
}

// The usage tile (#C595): the top five sources of the spend script's rows, as shares, and the week's pace. rows: the
// script's --json rows ({ source, share }); a source is a roster role, "scheduled" for "scheduled: …", else "other".
// plan: { weekPct, resetsAt } (a number and a time) when someone wrote it; pace = weekPct over the share of the week gone.
export const WEEK_MS = 7 * 24 * 3600e3, AMBER_PACE = 1.3, RED_PACE = 1.6;
export function usageReading({ rows, roster, plan, now }) {
  const by = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.source !== "string" || !Number.isFinite(r.share) || r.share < 0) continue;
    const src = roster.includes(r.source) && ROLE.test(r.source) ? r.source : r.source.startsWith("scheduled:") ? "scheduled" : "other";
    by.set(src, (by.get(src) ?? 0) + r.share);
  }
  const top = [...by].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([src, s]) => ({ src, pct: Math.min(100, Math.round(s * 100)) }));
  let weekPct = null, pace = null;
  if (plan && Number.isFinite(plan.weekPct) && plan.weekPct >= 0 && plan.weekPct <= 1000 && Number.isInteger(plan.resetsAt)) {
    weekPct = Math.round(plan.weekPct);
    const gone = 1 - (plan.resetsAt - now) / WEEK_MS;
    if (gone >= 0.02 && gone <= 1) pace = Math.min(10000, Math.round((plan.weekPct / 100 / gone) * 100));
  }
  const x = pace === null ? 0 : pace / 100;
  return { at: now, weekPct, pace, level: x >= RED_PACE ? "red" : x >= AMBER_PACE ? "amber" : "ok", top };
}
