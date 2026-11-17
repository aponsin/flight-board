// #C1111: each role's session is checked against the model and effort it was meant to run on, every run. Models and effort drift after a crash and were
// re-checked by hand. The app's session file of a role's session carries the model and the effort it runs on (appSessions keeps both, as plain words
// or null); what no file carries is what each role was MEANT to have, so the board config does: `roleSessions: [{ role, model?, effort? }]`
// (scripts/config.mjs). This reads the two together and posts one evidence key, session.checks:
//   { at, roles: [{ role, chosen, ran, chosenEffort, ranEffort, at }] }   (words, model and effort names and times only; a field is null when not known)
// One entry for each configured role, in the config's order, 20 at most; the session read is the role's newest open one (an archived session is left
// out by appSessions) whose title is the role name. A role with no open session is listed with ran and ranEffort null and at null. A session whose title
// is not in the config is never listed. The page draws the verdict (page/board.template.html roleSessionsHtml) and says the fix; nothing is decided here
// beyond what to post. Remote Control is not in a session file the probe can read (#C865's spike): it is not part of this reading.
import { MODEL_WORD, EFFORT_WORD, ROLE_NAME, ROLE_MAX } from "../scripts/config.mjs";

// The configured list, or null (with a logged reason) when it is not a list of plain entries: the store then keeps its last good reading.
export function configuredRoles(configText, log = () => {}) {
  let list;
  try { list = JSON.parse(configText)?.roleSessions; } catch { log("roles: the board config could not be read"); return null; }
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > ROLE_MAX) { log(`roles: roleSessions is not a list of up to ${ROLE_MAX} roles; not posted`); return null; }
  const seen = new Set(), out = [];
  for (const t of list) {
    const ok = t && typeof t === "object" && !Array.isArray(t) && Object.keys(t).every((k) => ["role", "model", "effort"].includes(k))
      && typeof t.role === "string" && ROLE_NAME.test(t.role) && !seen.has(t.role)
      && (t.model === undefined || t.model === null || (typeof t.model === "string" && MODEL_WORD.test(t.model)))
      && (t.effort === undefined || t.effort === null || (typeof t.effort === "string" && EFFORT_WORD.test(t.effort)));
    if (!ok) { log("roles: an entry of roleSessions is not { role, model, effort } with plain words; not posted"); return null; }
    seen.add(t.role);
    out.push({ role: t.role, model: t.model ?? null, effort: t.effort ?? null });
  }
  return out;
}

// sessions: appSessions' rows. The newest session of each role, by the session's last activity, whose title is exactly the role name.
export function newestRoleSessions(sessions, roles) {
  const want = new Set(roles), by = new Map();
  for (const s of sessions) {
    if (typeof s?.title !== "string" || !want.has(s.title)) continue;
    const at = Number.isFinite(s.at) ? s.at : 0, held = by.get(s.title);
    if (!held || at > held.at) by.set(s.title, {
      at, known: Number.isFinite(s.at),
      model: typeof s.model === "string" && MODEL_WORD.test(s.model) ? s.model : null,
      effort: typeof s.effort === "string" && EFFORT_WORD.test(s.effort) ? s.effort : null,
    });
  }
  return by;
}

export function roleSessionsWrite(configText, { sessions, now, log = () => {} }) {
  const roles = configuredRoles(configText, log);
  if (!roles) return null;
  if (!roles.length) return null;
  const runs = newestRoleSessions(sessions ?? [], roles.map((r) => r.role));
  const entry = (r) => { const s = runs.get(r.role); return { role: r.role, chosen: r.model, ran: s?.model ?? null, chosenEffort: r.effort, ranEffort: s?.effort ?? null, at: s?.known ? s.at : null }; };
  return { key: "session.checks", value: { at: now, roles: roles.map(entry).slice(0, ROLE_MAX) } };
}
