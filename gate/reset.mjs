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
// A question for the owner with no Needs-you item (#C584), owner-asks.json { at, asks: [{ card, role, since }] }: printed
// once per card and first-seen time (owner-asks-seen.json { asks: { <card>: <since> } }); gone from the file, forgotten.
export const ASKS_FILE = "owner-asks.json", ASKS_SEEN_FILE = "owner-asks-seen.json";
const CARD = /^[a-z0-9]{1,16}(?:-[a-z0-9]{1,16}){0,4}$/;
const askList = (f) => (Array.isArray(f?.asks) ? f.asks.filter((a) => a && CARD.test(String(a.card)) && ROLE.test(String(a.role)) && Number.isInteger(a.since)) : []);
export function asksPending(asked, seen) {
  const s = seen && typeof seen.asks === "object" && seen.asks && !Array.isArray(seen.asks) ? seen.asks : {};
  return askList(asked).filter((a) => s[a.card] !== a.since);
}
// The seen file after printing: the listed asks only, so one that comes back is printed again.
export const asksSeen = (asked) => ({ asks: Object.fromEntries(askList(asked).map((a) => [a.card, a.since])) });
export const askLine = (a) => `ASK ${a.role} ${a.card}: ${a.role} is waiting on the owner and has no Needs-you item; write one`;
export const resetLine = (role) => `CONTEXT RESET ${role}: past the reset limit; save its notes and clear it`;
export const wakeLine = (role) => `WAKE ${role}: no open session and it has work; wake it`;
export const missingLine = (roles) => `ROSTER missing: ${roles.join(", ")} (no open session, no work waiting)`;
