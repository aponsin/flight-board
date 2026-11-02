// What the probe asks the lead to do about roles, once per spell, printed by the lead's wake watch (scripts/wake-watch.mjs):
//   context-reset.json  { at, roles: { <role>: <time asked> } }   a role past the board's resetAt (#C592): CONTEXT RESET <role>
//   wake-roles.json     { at, roles: {…}, missing: {…} }          a role with no open session (#C583): roles that have work
//                       are "WAKE <role>"; the rest are one "ROSTER missing: …" line, so a short roster is never silent
// Each file's seen twin (reset-seen.json, wake-roles-seen.json) has the same shape and holds what the watch has printed. A
// role is printed again only when its asked time changes (the probe forgets a role once it is back). Roles and times only.
import { ROLE } from "../collector/state-schema.mjs";

export const RESET_FILE = "context-reset.json", RESET_SEEN_FILE = "reset-seen.json";
export const WAKE_ROLES_FILE = "wake-roles.json", WAKE_ROLES_SEEN_FILE = "wake-roles-seen.json";
const rolesOf = (f, key = "roles") => (f && typeof f === "object" && f[key] && typeof f[key] === "object" && !Array.isArray(f[key]) ? f[key] : {});

// The roles asked and not yet printed: a time asked that differs from the one seen. Sorted.
export function resetPending(asked, seen, key = "roles") {
  const a = rolesOf(asked, key), s = rolesOf(seen, key);
  return Object.keys(a).filter((r) => ROLE.test(r) && Number.isInteger(a[r]) && a[r] !== s[r]).sort();
}
// What the watch has now printed: the seen file with these roles at their asked time (the other key is kept).
export function resetSeen(asked, seen, roles, key = "roles") {
  const a = rolesOf(asked, key);
  const out = { ...rolesOf(seen, key) };
  for (const r of roles) out[r] = a[r];
  return { ...(seen && typeof seen === "object" ? seen : {}), [key]: out };
}
export const resetLine = (role) => `CONTEXT RESET ${role}: past the reset limit; save its notes and clear it`;
export const wakeLine = (role) => `WAKE ${role}: no open session and it has work; wake it`;
export const missingLine = (roles) => `ROSTER missing: ${roles.join(", ")} (no open session, no work waiting)`;
