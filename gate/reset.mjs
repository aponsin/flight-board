// CONTEXT RESET for a role past the board's resetAt (#C592): the probe (collector/state.mjs) writes context-reset.json,
// { at, roles: { <role>: <time asked> } }, once per role per crossing; the lead's wake watch (scripts/wake-watch.mjs) prints
// one line per role it has not printed for (reset-seen.json, the same shape), and the lead sends that role the reset.
// Roles and times only.
import { ROLE } from "../collector/state-schema.mjs";

export const RESET_FILE = "context-reset.json", RESET_SEEN_FILE = "reset-seen.json";
const rolesOf = (f) => (f && typeof f === "object" && f.roles && typeof f.roles === "object" && !Array.isArray(f.roles) ? f.roles : {});

// The roles asked and not yet printed: a time asked that differs from the one seen. Sorted.
export function resetPending(asked, seen) {
  const a = rolesOf(asked), s = rolesOf(seen);
  return Object.keys(a).filter((r) => ROLE.test(r) && Number.isInteger(a[r]) && a[r] !== s[r]).sort();
}
// What the watch has now printed: the seen file with these roles at their asked time.
export function resetSeen(asked, seen, roles) {
  const a = rolesOf(asked), out = { ...rolesOf(seen) };
  for (const r of roles) out[r] = a[r];
  return { roles: out };
}
export const resetLine = (role) => `CONTEXT RESET ${role}: past the reset limit; save its notes and clear it`;
