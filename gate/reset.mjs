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
// What the probe finds true of the cards that no one has to remember to write (#C617), board-truth.json { at, items: [{ kind, card,
// sha }] }, printed once per card, kind and tip (board-truth-seen.json { items: { "<kind> <card>": <sha> } }); gone from the file,
// forgotten. ship: every sign-off its level needs is on the tip and it is not on main (Release is to ship it); close: its commits are
// live (on main and deployed, or in the installed pack) while the card is open (status done, with its live step, is to be written).
export const TRUTH_FILE = "board-truth.json", TRUTH_SEEN_FILE = "board-truth-seen.json";
export const TRUTH_KINDS = ["ship", "close"], SHIP_ROLE = "Release";
const truthList = (f) => (Array.isArray(f?.items) ? f.items.filter((a) => a && TRUTH_KINDS.includes(a.kind) && CARD.test(String(a.card)) && /^[0-9a-f]{12}$/.test(String(a.sha))) : []);
export function truthPending(asked, seen) {
  const s = seen && typeof seen.items === "object" && seen.items && !Array.isArray(seen.items) ? seen.items : {};
  return truthList(asked).filter((a) => s[`${a.kind} ${a.card}`] !== a.sha);
}
export const truthSeen = (asked) => ({ items: Object.fromEntries(truthList(asked).map((a) => [`${a.kind} ${a.card}`, a.sha])) });
export const truthLine = (a) => (a.kind === "ship"
  ? `SHIP ${a.card}: every sign-off its level needs is on ${a.sha.slice(0, 7)} and it is not on main; tell ${SHIP_ROLE} to ship it`
  : `CLOSE ${a.card}: its commits are live (on main and deployed, or in the installed pack); write its live step and set status done in the same batch`);
export const resetLine = (role) => `CONTEXT RESET ${role}: past the reset limit; save its notes and clear it`;
export const wakeLine = (role) => `WAKE ${role}: no open session and it has work; wake it`;
export const missingLine = (roles) => `ROSTER missing: ${roles.join(", ")} (no open session, no work waiting)`;
