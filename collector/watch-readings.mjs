// #C1005 part c: what the old stuck-agent watchdog task told Manager besides stuck sessions, now probe readings with no cross-repository script:
//   - "app restarted" (the product repository's watchdog-restart.mjs): every session the probe knew is gone and some are running.
//   - the permission-prompt ledger (watchdog-prompts.mjs): the prompts and other notifications the ledger gained since the last run, and "Prompt ledger
//     silent" when it has had no line for a day while agents worked.
// Pure: lines and ids in, a reading out. The probe (collector/state.mjs) keeps `before` in its own small file and posts the reading as the state's `watch`
// (collector/state-schema.mjs); nothing here carries a command, a message or a title, only roles, tool words, counts and times.
export const QUIET_MS = 24 * 60 * 60_000;
const ROLE = /^[A-Za-z][A-Za-z0-9]{1,23}$/, TOOL = /^[A-Za-z][A-Za-z0-9_.:-]{0,47}$/;
export const MAX_PROMPTS = 12;

// ids: the roster's session ids now; before: { ids } as kept. A restart: the probe knew sessions and none of them is among today's. The ids it keeps are
// today's, or the old ones when none runs (so a return after a gap still reads against them). The watchdog's second rule (its own runs missed) has no
// meaning for a probe that runs every minute and is left out.
export function restartReading({ ids, before }) {
  const now = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && x))].sort();
  const known = Array.isArray(before?.ids) ? before.ids.filter((x) => typeof x === "string") : [];
  const restart = known.length > 0 && now.length > 0 && !now.some((id) => known.includes(id));
  return { restart, ids: now.length ? now : known };
}

const parse = (l) => { try { const p = JSON.parse(l); return p && typeof p === "object" && !Array.isArray(p) ? p : null; } catch { return null; } };

// lines: the ledger's lines; before: { seen, quiet } as kept (seen: how many lines were reported; quiet: the key of the silence already told); now (ms);
// running: how many agents are working. The first run (seen not a number) only takes the ledger's length: its history is not "new". A ledger shorter than
// `seen` was started again: all of it is new. Returns { seen, quiet, ledger?, silence? } where ledger is { prompts: [{ role, tool, n }], others } (only when
// something is new) and silence is { since, days, running } (only the first time a silence is seen; `quiet` is its key).
export function ledgerReading({ lines, before, now, running }) {
  const all = Array.isArray(lines) ? lines : [];
  const first = !Number.isInteger(before?.seen);
  const from = first ? all.length : before.seen >= 0 && before.seen <= all.length ? before.seen : 0;
  const items = all.slice(from).map(parse).filter(Boolean);
  const out = { seen: all.length, quiet: before?.quiet ?? null };
  const counts = new Map();
  for (const p of items.filter((x) => x.kind !== "other")) {
    const role = typeof p.who === "string" && ROLE.test(p.who) ? p.who : "?", tool = typeof p.tool === "string" && TOOL.test(p.tool) ? p.tool : "?";
    counts.set(`${role} ${tool}`, (counts.get(`${role} ${tool}`) ?? 0) + 1);
  }
  const others = items.filter((x) => x.kind === "other" && x.type !== "idle_prompt").length;
  const prompts = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_PROMPTS).map(([k, n]) => { const [role, tool] = k.split(" "); return { role: role === "?" ? "Unknown" : role, tool: tool === "?" ? "other" : tool, n }; });
  if (prompts.length || others) out.ledger = { prompts, others };
  if (Number.isFinite(now) && running > 0) {
    const newest = all.map(parse).filter(Boolean).map((p) => Date.parse(p.at)).filter((t) => !Number.isNaN(t)).reduce((a, b) => Math.max(a, b), -Infinity);
    const key = Number.isFinite(newest) ? new Date(newest).toISOString() : "none";
    if ((!Number.isFinite(newest) || now - newest >= QUIET_MS) && before?.quiet !== key) {
      out.silence = { since: Number.isFinite(newest) ? newest : null, days: Number.isFinite(newest) ? Math.floor((now - newest) / 86_400_000) : null, running };
      out.quiet = key;
    }
  }
  return out;
}

// The state's `watch` from the two readings; null when there is nothing to say.
export function watchReading({ now, restart, ledger }) {
  const w = { at: now };
  if (restart) w.restart = true;
  if (ledger?.ledger) w.ledger = ledger.ledger;
  if (ledger?.silence) w.quiet = ledger.silence;
  return w.restart || w.ledger || w.quiet ? w : null;
}
