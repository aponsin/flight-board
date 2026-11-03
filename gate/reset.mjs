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
// live (on main and deployed, or in the installed pack) while the card is open (status done, with its live step, is to be written);
// gap (#C619): an open card with no owner or no ETA ({ kind: "gap", card, miss: "owner" | "eta" | "owner eta" }, kept in the seen
// file in place of the sha, so a card that misses something else is a new line).
export const TRUTH_FILE = "board-truth.json", TRUTH_SEEN_FILE = "board-truth-seen.json";
export const TRUTH_KINDS = ["ship", "close", "gap"], SHIP_ROLE = "Release";
const tipOf = (a) => (a.kind === "gap" ? a.miss : a.sha);
const truthList = (f) => (Array.isArray(f?.items) ? f.items.filter((a) => a && TRUTH_KINDS.includes(a.kind) && CARD.test(String(a.card)) && (a.kind === "gap" ? /^(owner|eta|owner eta)$/.test(String(a.miss)) : /^[0-9a-f]{12}$/.test(String(a.sha)))) : []);
// A CLOSE line repeats every CLOSE_AGAIN_MS until the card is no longer listed (its status done: the probe reads the export), so a
// line the lead missed can't sit for hours (the lead, 23:50Z), and a GAP line every GAP_AGAIN_MS; a SHIP line is printed once per
// tip. The seen file keeps { sha, at } per "<kind> <card>" (an older file kept the sha alone: read as printed at 0).
export const CLOSE_AGAIN_MS = 10 * 60e3, GAP_AGAIN_MS = 30 * 60e3;
const AGAIN = { close: CLOSE_AGAIN_MS, gap: GAP_AGAIN_MS };
const seenItems = (seen) => (seen && typeof seen.items === "object" && seen.items && !Array.isArray(seen.items) ? seen.items : {});
const seenEntry = (v) => (typeof v === "string" ? { sha: v, at: 0 } : v && typeof v === "object" && typeof v.sha === "string" ? { sha: v.sha, at: Number.isInteger(v.at) ? v.at : 0 } : null);
export function truthPending(asked, seen, now = Date.now()) {
  const s = seenItems(seen);
  return truthList(asked).filter((a) => {
    const e = seenEntry(s[`${a.kind} ${a.card}`]);
    return !e || e.sha !== tipOf(a) || (a.kind in AGAIN && now - e.at >= AGAIN[a.kind]);
  });
}
// The seen file after a look: the listed items only (one that comes back is printed again), each with the time it was last printed.
export function truthSeen(asked, seen = null, printed = [], now = Date.now()) {
  const s = seenItems(seen), out = {};
  for (const a of truthList(asked)) {
    const key = `${a.kind} ${a.card}`, e = seenEntry(s[key]);
    if (printed.some((p) => p.kind === a.kind && p.card === a.card)) out[key] = { sha: tipOf(a), at: now };
    else if (e && e.sha === tipOf(a)) out[key] = e;
  }
  return { items: out };
}
export const truthLine = (a) => (a.kind === "ship"
  ? `SHIP ${a.card}: every sign-off its level needs is on ${a.sha.slice(0, 7)} and it is not on main; tell ${SHIP_ROLE} to ship it`
  : a.kind === "gap"
  ? `GAP ${a.card}: no ${a.miss.split(" ").map((m) => (m === "eta" ? "ETA" : m)).join(" and no ")}; write ${a.miss.split(" ").map((m) => (m === "eta" ? "etaLive" : "who")).join(" and ")} on the card`
  : `CLOSE ${a.card}: its commits are live (on main and deployed, or in the installed pack); write its live step and set status done in the same batch`);
// The probe's evidence self-check (#C632): with EVIDENCE_MIN_CARDS or more open cards past plan and not one of them showing a
// branch commit (headSha12), the probe is reading nothing (the day every flight-board card went to the wrong repository). evidenceAt
// is the last run any did, or this run's when there are too few cards to say; with none before, the clock starts at the first
// empty run. The page's chip goes red EVIDENCE_STALE_MS later, and the probe writes no-evidence.json { since } so the lead's
// watch prints one NOEVIDENCE line per outage (the seen file keeps the since it printed); evidence back clears both.
export const NOEVIDENCE_FILE = "no-evidence.json", NOEVIDENCE_SEEN_FILE = "no-evidence-seen.json";
export const EVIDENCE_STALE_MS = 10 * 60e3, EVIDENCE_MIN_CARDS = 3;
export function evidenceAt(cards, now, before) {
  const built = Object.values(cards ?? {}).filter((c) => c && typeof c.phase === "string" && c.phase !== "plan");
  if (built.length < EVIDENCE_MIN_CARDS || built.some((c) => c.headSha12)) return now;
  return Number.isInteger(before) && before >= 1577836800000 && before <= now ? before : now;
}
export const noEvidenceSince = (at, now) => (Number.isInteger(at) && now - at > EVIDENCE_STALE_MS ? at : null);
export const noEvidencePending = (asked, seen) => Number.isInteger(asked?.since) && asked.since !== seen?.since;
export const noEvidenceLine = (since) => `NOEVIDENCE: the probe's card checks found no branch for any open card since ${new Date(since).toISOString().slice(11, 16)} UTC; the cards' evidence (phase tiles, READY, ship) is blind: read the probe's log and the repository lookup`;
export const resetLine = (role) => `CONTEXT RESET ${role}: past the reset limit; save its notes and clear it`;
export const wakeLine = (role) => `WAKE ${role}: no open session and it has work; wake it`;
export const missingLine = (roles) => `ROSTER missing: ${roles.join(", ")} (no open session, no work waiting)`;
