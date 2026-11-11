// What the probe asks the lead to do about roles, once per spell, printed by the lead's wake watch (scripts/wake-watch.mjs):
//   context-reset.json  { at, roles: { <role>: <time asked> } }   a role past the board's resetAt (#C592): CONTEXT RESET <role>
//   wake-roles.json     { at, roles: {…}, missing: {…} }          a role with no open session (#C583): roles that have work
//                       are "WAKE <role>"; the rest are one "ROSTER missing: …" line, so a short roster is never silent
// Each file's seen twin (reset-seen.json, wake-roles-seen.json) has the same shape and holds what the watch has printed. A
// role is printed again only when its asked time changes (the probe forgets a role once it is back). Roles and times only.
import { readFileSync } from "node:fs";
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
// #C682: CLOSE repeated every 10 minutes, which woke the lead for a card that is open on purpose (it waits on a real test); it
// now repeats after 2 hours (a changed tip still prints at once), like LINE_AGAIN_MS below.
export const CLOSE_AGAIN_MS = 2 * 3600e3, GAP_AGAIN_MS = 30 * 60e3;
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
// The lines the derive step finds for the lead (#C642): the Collector reads and sends nothing, so the probe derives from the mirror
// and writes collector-lines.json { at, lines }, which the lead's watch prints once per batch (the seen file keeps the batch's at).
// Only the line kinds the Collector used to send are shown, a few and short: the file is on disk, a planted one says nothing more.
export const LINES_FILE = "collector-lines.json", LINES_SEEN_FILE = "collector-lines-seen.json";
export const LINE_KINDS = /^(CONFLICT|LIVE BUT OPEN|NUDGE|KEEPER|MIRROR DRIFT)\b/;
export const LINES_MAX = 20, LINE_MAX = 600;
export const linesOf = (f) => (Number.isInteger(f?.at) && Array.isArray(f.lines) ? f.lines.filter((l) => typeof l === "string" && LINE_KINDS.test(l)).slice(0, LINES_MAX).map((l) => l.slice(0, LINE_MAX)) : []);
// #C678: a NUDGE or CONFLICT about one agent's card carries "@<Role>" after its word ("NUDGE @Builder #C12: ..."). It goes to
// that role's own watch, not the lead's, unless the role is not on the roster, is the lead, or has no open session (its name
// is in `away`, the roles the probe asked to wake or found missing): then the lead still gets it, to act on.
export const LINE_ROUTE = /^(CONFLICT|NUDGE) @([A-Za-z][A-Za-z0-9_-]{0,31}) /;
export const routeOf = (line) => LINE_ROUTE.exec(line)?.[2] ?? null;
export const routedLine = (kind, role, text) => `${kind} @${role} ${text}`;
// A line that is not routed never starts its text with "@": a card id may (idText allows it), and "NUDGE @Security (#C5): ..." would
// read as a line for that role and leave the lead's watch (Security on 3eb2450).
export const plainLine = (kind, text) => `${kind} ${String(text).replace(/^@/, "?@")}`;
// The lines a reader prints: role null is the lead's (needs lead, roster, away), a role name is that role's own watch.
export function linesFor(lines, role, { lead = null, roster = null, away = [] } = {}) {
  return lines.filter((l) => {
    const to = routeOf(l);
    if (role) return to === role;
    return !to || to === lead || (Array.isArray(roster) && !roster.includes(to)) || away.includes(to);
  });
}
// #C682: the probe stamps every batch with a new `at`, so a card that waits on purpose (its text unchanged) made the same lines wake
// the lead every run. The seen file now keeps { at, lines: { <line text>: printedAt } }: a line is printed when its text is not there
// (a card that changed reads differently) or was printed LINE_AGAIN_MS ago or more, and a line the batch no longer holds is forgotten
// (when it comes back it prints again). An older seen file ({ at } alone) has no lines: everything prints once, as before.
export const LINE_AGAIN_MS = 2 * 3600e3;
const seenLines = (seen) => (seen && typeof seen.lines === "object" && seen.lines && !Array.isArray(seen.lines) ? seen.lines : {});
// #C441's overdue nudge is "every run, no quiet period" (collector/nudges.mjs, nudge 7): it is never held back here.
export const EVERY_RUN = /^NUDGE (@[A-Za-z][A-Za-z0-9_-]{0,31} )?overdue: /;
const quiet = (seen, line, now) => { if (EVERY_RUN.test(line)) return false; const t = seenLines(seen)[line]; return Number.isInteger(t) && t <= now + 5_000 && now - t < LINE_AGAIN_MS; };
export const linesPending = (file, seen, opts = {}) => (Number.isInteger(file?.at) && file.at !== seen?.at
  ? linesFor(linesOf(file), opts.role ?? null, opts).filter((l) => !quiet(seen, l, opts.now ?? Date.now()))
  : []);
// The seen file after a look at `file`: the batch's lines only, each with the time it was last printed (`printed` are the lines
// this look returned; a held-back line keeps its earlier time).
export const linesSeen = (file, seen = null, printed = [], now = Date.now()) => {
  const out = {}, old = seenLines(seen);
  for (const l of linesOf(file)) {
    if (printed.includes(l)) out[l] = now;
    else if (Number.isInteger(old[l])) out[l] = old[l];
  }
  return { at: file.at, lines: out };
};
export const linesSeenFile = (role) => `collector-lines-seen-${role}.json`;
export const NOEVIDENCE_FILE = "no-evidence.json", NOEVIDENCE_SEEN_FILE = "no-evidence-seen.json";
export const EVIDENCE_STALE_MS = 10 * 60e3, EVIDENCE_MIN_CARDS = 3;
// Only cards before ship count (skip: the ship and live phases): a card past its merge usually has no branch left to show (Checker
// on 25f2bb8: three live-but-open cards on a quiet evening would have raised the alarm).
export function evidenceAt(cards, now, before, skip = []) {
  const built = Object.values(cards ?? {}).filter((c) => c && typeof c.phase === "string" && c.phase !== "plan" && !skip.includes(c.phase));
  if (built.length < EVIDENCE_MIN_CARDS || built.some((c) => c.headSha12)) return now;
  return Number.isInteger(before) && before >= 1577836800000 && before <= now ? before : now;
}
export const noEvidenceSince = (at, now) => (Number.isInteger(at) && now - at > EVIDENCE_STALE_MS ? at : null);
export const noEvidencePending = (asked, seen) => Number.isInteger(asked?.since) && asked.since !== seen?.since;
export const noEvidenceLine = (since) => `NOEVIDENCE: the probe's card checks found no branch for any open card since ${new Date(since).toISOString().slice(11, 16)} UTC; the cards' evidence (phase tiles, READY, ship) is blind: read the probe's log and the repository lookup`;
// Dispatch is mechanical (#C631, the owner's A): an active card whose owner (a roster role, not the lead) has been idle
// DISPATCH_IDLE_MS with nothing to wait for (no open ask on the card, no waitingOn that names someone else) is dispatched: level 1 the
// moment it holds, and the owner's own `wake-watch --role <Role> --once` (a background Bash that blocks until then) prints one
// DISPATCH line and exits, which wakes the idle session; level 2 when it still holds DISPATCH_LATE_MS after level 1, and the
// lead's watch prints one DISPATCH-LATE line. The probe writes dispatch.json { at, items: [{ card, role, level, since }] } (ids,
// times and levels only); dispatch-state.json keeps when each pair first held (a pair that stops holding is forgotten, so a new
// stall starts again at level 1); each watch keeps what it printed in its seen file.
export const DISPATCH_FILE = "dispatch.json", DISPATCH_STATE_FILE = "dispatch-state.json", DISPATCH_LATE_SEEN_FILE = "dispatch-late-seen.json";
export const DISPATCH_IDLE_MS = 15 * 60e3, DISPATCH_LATE_MS = 30 * 60e3;
// #C850 (dispatch by phase): a card that carries `turns` ([{ role, phase, step, sha?, signed? }], whose turn it is now and what for) is
// dispatched to those roles, not to its owner, and the wake comes after DISPATCH_TURN_IDLE_MS of the role's idleness (a phase change wakes
// an idle agent at once; the 15 minutes above stay for a card without turns, the old rule). A pair is a role, a card AND the phase, so a
// new phase is a new first wake, and an old phase's pair is forgotten when the card moves on.
export const DISPATCH_TURN_IDLE_MS = 60e3;
export const DISPATCH_STEPS = {
  build: "has nothing pushed; build it and push the branch (the push is the READY)",
  rework: "came back with findings; fix them and push the new commit (the push hands it back to review)",
  review: "is pushed; review it (your verdict is the git note on that commit)",
  land: "is signed; land it (the notes on that exact commit, a clean dry run, the owner's standing go)",
  pair: "is landed and not deployed: build the deploy pair (node scripts/make-pair.mjs <sha> <n>) and, if hooks changed, the pack",
  recut: "is signed but behind main, so Release cannot take it; re-cut it on main and push (a new commit needs new signatures)",
  outside: "is outside the stack (its branch was not cut from the stack tip); re-cut it on the stack tip and push",
  decision: "had its decision answered; act on the answer",
  // #C916: the lead posted on the card's thread after its owner went idle.
  post: "has a new post from the lead on its thread; read the thread on the board and act on it",
};
// #C872: an answered Decision on a card wakes the card's owner with the answer quoted. The answer is the owner's choice (an option Manager
// wrote, or the owner's own words), so it is cut to plain words before it goes in a line an agent reads: letters, digits, spaces and
// ordinary punctuation, 120 characters at most, one line. Empty when nothing is left.
export const plainAnswer = (s) => (typeof s === "string" ? s.replace(/[^\p{L}\p{N} .,:;'()\/&+%#?!-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 120).trim() : "");
// #C859 slice 3 (stack mode, design 3): the stack branch a builder's turn names, a plain branch name only (the line is built from fixed text).
export const STACK_BRANCH = /^[A-Za-z0-9._\/-]{1,100}$/;
const stackBranch = (b) => (typeof b === "string" && STACK_BRANCH.test(b) && !b.startsWith("-") ? b : null);
export const dispatchSeenFile = (role) => `dispatch-seen-${role}.json`, dispatchPidFile = (role) => `dispatch-watch-${role}.json`;
// #C848: what the board woke a role for, kept past the moment dispatch.json drops the pair (the role is working then, not idle). The role's
// watch writes { at, cards } when it prints a DISPATCH line; the Stop hook reads it, and writes { at } in the checked file once it has judged
// the turn that followed, so a wake is judged once.
export const dispatchWokenFile = (role) => `dispatch-woken-${role}.json`, dispatchWaitCheckedFile = (role) => `dispatch-wait-checked-${role}.json`;
const pairKey = (role, card, phase = null) => (phase === null ? `${role} ${card}` : `${role} ${card} ${phase}`);
const SHA40 = /^[0-9a-f]{40}$/, REPO_FULL = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const SHA12 = /^[0-9a-f]{12}$/, TURN_PHASE = /^[a-z]{2,16}$/, PLAIN_ROLE = /^[A-Za-z][A-Za-z0-9 _-]{0,40}$/;
export function dispatchItems({ cards, agents, asked = new Set(), roster = [], lead = "", now, before = null }) {
  const first = before && typeof before.items === "object" && before.items && !Array.isArray(before.items) ? before.items : {};
  const items = [], kept = {};
  for (const card of cards ?? []) {
    if (card?.status !== "active" || !CARD.test(String(card.id)) || asked.has(card.id)) continue;
    // Whose turn: the card's turns, else its owner (the old rule).
    const turns = Array.isArray(card.turns) ? card.turns : [{ role: card.who, phase: null }];
    for (const t of turns) {
      const role = t?.role, a = agents && typeof role === "string" && Object.hasOwn(agents, role) ? agents[role] : null;
      if (typeof role !== "string" || role === lead || !roster.includes(role)) continue;
      if (!a || a.state !== "idle") continue;
      const idleSince = Number.isFinite(a.since) ? a.since : a.lastActivityAt;
      const need = Array.isArray(card.turns) ? DISPATCH_TURN_IDLE_MS : DISPATCH_IDLE_MS;
      if (!Number.isFinite(idleSince) || now - idleSince < need) continue;
      if (typeof card.waitingOn === "string" && card.waitingOn.trim() && !card.waitingOn.trim().startsWith(role)) continue;
      const phase = Array.isArray(card.turns) && TURN_PHASE.test(String(t.phase)) ? t.phase : null;
      const k = pairKey(role, card.id, phase), since = Number.isInteger(first[k]) && first[k] <= now ? first[k] : now;
      kept[k] = since;
      items.push({
        card: card.id, role, level: now - since >= DISPATCH_LATE_MS ? 2 : 1, since,
        ...(phase && Object.hasOwn(DISPATCH_STEPS, t.step) ? { phase, step: t.step } : {}),
        ...(phase && Number.isInteger(card.num) && card.num >= 1 && card.num <= 1e6 ? { num: card.num } : {}),
        ...(phase && SHA12.test(String(t.sha)) ? { sha: t.sha } : {}),
        // #C895: the full sha (it must be the 12 the line would have named), the repository (owner/name) and the branch.
        ...(phase && SHA12.test(String(t.sha)) && SHA40.test(String(t.fullSha)) && String(t.fullSha).startsWith(t.sha) ? { fullSha: t.fullSha } : {}),
        ...(phase && SHA12.test(String(t.sha)) && REPO_FULL.test(String(t.repo)) ? { repo: t.repo } : {}),
        ...(phase && SHA12.test(String(t.sha)) && stackBranch(t.onBranch) ? { onBranch: t.onBranch } : {}),
        ...(phase && stackBranch(t.stack) ? { stack: t.stack } : {}),
        ...(phase && Array.isArray(t.signed) ? { signed: t.signed.filter((s) => PLAIN_ROLE.test(String(s))).slice(0, 4) } : {}),
        ...(phase && t.step === "decision" && Number.isInteger(t.ask) && t.ask >= 1 && t.ask <= 1e7 ? { ask: t.ask, answer: plainAnswer(t.answer) } : {}),
      });
    }
  }
  items.sort((x, y) => (x.role + x.card < y.role + y.card ? -1 : 1));
  return { items, state: { items: kept } };
}
// The level-1 items of a role the role's watch has not printed (the seen file keeps "card since" per card); the lead's late ones likewise.
const dispatchSeenItems = (seen) => (seen && typeof seen.items === "object" && seen.items && !Array.isArray(seen.items) ? seen.items : {});
const dispatchList = (f) => (Array.isArray(f?.items) ? f.items.filter((i) => i && CARD.test(String(i.card)) && /^[A-Za-z][A-Za-z0-9 _-]{0,40}$/.test(String(i.role)) && [1, 2].includes(i.level) && Number.isInteger(i.since)) : []);
export const dispatchPending = (asked, seen, { role = null, level }) => dispatchList(asked).filter((i) => i.level >= level && (role === null || i.role === role) && dispatchSeenItems(seen)[i.card] !== i.since);
export const dispatchSeen = (seen, printed) => ({ items: { ...dispatchSeenItems(seen), ...Object.fromEntries(printed.map((i) => [i.card, i.since])) } });
// The line of a card with a turn names the step and the exact commit, built only from the fixed step texts, a 12-hex sha and plain
// role names: `DISPATCH #C844 at ship: 8b3855f0f672 signed by Checker and Security; it is signed; land it (...)`.
export const dispatchLine = (i) => {
  // dispatch.json is read back from disk, so the phase and signers are checked again here, not trusted from the write.
  if (typeof i.phase === "string" && TURN_PHASE.test(i.phase) && Object.hasOwn(DISPATCH_STEPS, i.step)) {
    const signers = Array.isArray(i.signed) ? i.signed.filter((s) => typeof s === "string" && PLAIN_ROLE.test(s)).slice(0, 4) : [];
    const who = signers.length ? ` signed by ${signers.join(" and ")}` : "";
    const card = Number.isInteger(i.num) ? `#C${i.num}` : i.card;
    const on = stackBranch(i.stack) ? `; stack mode is on, the stack branch is ${i.stack}: one commit per card, rebased on its tip before you push` : "";
    // #C872: `DISPATCH #C862 at decision: DECISION #T1782 answered: "A, the ship's run too"; go (Builder's turn; ...)`. The answer is cut again here.
    if (i.step === "decision" && Number.isInteger(i.ask) && i.ask >= 1 && i.ask <= 1e7) return `DISPATCH ${card} at decision: DECISION #T${i.ask} answered: "${plainAnswer(i.answer)}"; go (${i.role}'s turn; read the answer on the ask's thread, act on it, push your own build branch and send READY: no go needed from anyone)`;
    // #C895: with the full sha the line says where the commit is (repository, branch, all 40 characters), so nobody has to ask or guess; checked again here.
    const at = SHA40.test(String(i.fullSha)) && SHA12.test(String(i.sha)) && String(i.fullSha).startsWith(i.sha)
      ? `${REPO_FULL.test(String(i.repo)) ? `repo ${i.repo}, ` : ""}${stackBranch(i.onBranch) ? `branch ${i.onBranch}, ` : ""}commit ${i.fullSha}` : SHA12.test(String(i.sha)) ? i.sha : "";
    return `DISPATCH ${card} at ${i.phase}: ${at ? `${at}${who}; ` : ""}it ${DISPATCH_STEPS[i.step]}${on} (${i.role}'s turn; pushing your own build branch, sending READY and taking your next queued card need no go from anyone, act on this)`;
  }
  return `DISPATCH ${i.card}: it waits on you (${i.role}) and your session has been idle; pick it up now (pushing your own build branch, sending READY and taking your next queued card need no go from anyone)`;
};
export const dispatchLateLine = (i) => `DISPATCH-LATE ${i.card}: ${i.role} was woken at ${new Date(i.since).toISOString().slice(11, 16)} UTC and nothing has moved in 30 minutes; look at it`;
// Whether a role's dispatch watch is running: its pid file names a live process and was beaten within DISPATCH_ALIVE_MS.
export const DISPATCH_ALIVE_MS = 90e3;
export function dispatchWatchAlive(file, now, kill = (pid) => process.kill(pid, 0)) {
  try {
    const a = JSON.parse(readFileSync(file, "utf8"));
    if (!Number.isInteger(a?.pid) || !Number.isFinite(a.at) || now - a.at > DISPATCH_ALIVE_MS || a.at > now + 5_000) return false;
    kill(a.pid);
    return true;
  } catch (e) { return e?.code === "EPERM"; }
}
export const resetLine = (role) => `CONTEXT RESET ${role}: past the reset limit; save its notes and clear it`;
export const wakeLine = (role) => `WAKE ${role}: no open session and it has work; wake it`;
export const missingLine = (roles) => `ROSTER missing: ${roles.join(", ")} (no open session, no work waiting)`;
