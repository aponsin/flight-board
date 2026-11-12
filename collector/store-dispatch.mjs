// The owners' dispatch from the store (#C821). The old state job (collector/state.mjs) writes <stateDir>/<board>/dispatch.json from
// the old board's documents; scripts/wake-watch.mjs --role <Role> --once reads that file and prints one DISPATCH line to wake an idle
// owner whose active card waits on them. When the old Collector stops that file goes stale and no owner is woken. This job writes the
// same two files (dispatch.json, dispatch-state.json) from the store's view, with the same rule (gate/reset.mjs dispatchItems: an
// active card, its owner idle for 15 minutes, nothing to wait for), so the watch, the Stop hook and the pinned hooks stay as they are.
// The lead's own WAKE is not here: the ask job's headless send into Manager's session already covers it (probe-board.mjs askJob).
// Tokens stay with the launchd job: an agent's watch only reads local files, never the board's credentials.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH_FILE, DISPATCH_STATE_FILE, dispatchItems } from "../gate/reset.mjs";
import { sessionWeek } from "./week-usage.mjs";

// The agents' reading (evidence.agents) is written by the evidence job every minute; older than this it says nothing about who is idle.
export const AGENTS_FRESH_MS = 5 * 60e3;
// A dispatch.json another writer (the old state job) made this recently is left alone: two writers would each reset the other's `since`.
export const FOREIGN_WRITER_MS = 5 * 60e3;
// #C872: how long an answered Decision may still wake its card's owner (a day: an owner idle longer than that is someone else's problem).
export const DECISION_FRESH_MS = 24 * 3600e3;
// #C872 (Checker's F1): the card an ask is about. Its card_id when the store has one; else the one card its title names, as the lead writes
// them ("#C862: should ship CI…"): on the live store none of the 528 answered Decisions carried a card_id, and 25 began with "#C<n>". A
// title naming two cards, or a card the view doesn't hold, names none. idByNum: the view's cards, number to id.
export function askCardId(ask, idByNum) {
  if (typeof ask?.card_id === "string" && ask.card_id) return ask.card_id;
  const named = [...new Set(String(ask?.title ?? "").match(/#C\d{1,7}\b/g) ?? [])];
  return named.length === 1 ? idByNum.get(Number(named[0].slice(2))) ?? null : null;
}

const CARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// #C915 (b): worker/board-rules.mjs holdOpen, copied (this pinned file imports only gate/): a hold_end whose end has not come (endPassed(ref) false),
// or a check_at in the future. A test fails if the two differ.
export const holdOpen = (c, now, endPassed) => !!c && ((typeof c.hold_end === "string" && c.hold_end.trim() !== "" && !endPassed(c.hold_end)) || (Number.isInteger(c.check_at) && c.check_at > now));

// #C850 (dispatch by phase): whose turn it is on a card, and for what, from the card's evidence. The lanes are whoForPhase's
// (worker/board-rules.mjs PHASE_LANES; a test pins that they are the same). [{ role, phase, step, sha?, signed? }]:
//   no phase or build        the owner builds and pushes (the push is the READY)
//   language, design         the lane's agent reviews the pushed commit
//   checker, security        the lane's agent reviews; with review level Full, Security too while its note is missing
//   ship, not on main        Release lands it (the notes on that exact commit, a clean dry run, the owner's standing go)
//   ship, on main, repo word the owner builds the deploy pair (the board's own repository: landed, not deployed)
//   live, or on main with no repo word: nobody (the lead closes it)
export const PHASE_LANES = { language: "Linguist", design: "Designer", checker: "Checker", security: "Security", ship: "Release" };
// The repo words of a card of the board's own repository that gets a deploy pair when it lands: kept in collector/pairs.mjs (#C1020), which the
// pinned probe imports; re-exported here for the dispatch's callers.
import { BOARD_REPO_WORDS } from "./pairs.mjs";
export { BOARD_REPO_WORDS };
const ROLE_OF_NOTE = { language: "Linguist", design: "Designer", checker: "Checker", security: "Security" };
// #C859 slice 3 (stack mode): ctx.stackBranch is the branch of the stack the card's repository has (when its switch is on), named in a
// builder's turn; a card the evidence reads as outside the stack (e.stack.outside) is told to re-cut; a reviewer is sent the stack tip.
export function turnsOf(card, e, ctx = {}) {
  const phase = e?.phase ?? e?.lit?.[0];
  // Only with the switch on for the card's repository (ctx.stackOn): evidence left from when it was on says nothing once it is off.
  const stack = ctx.stackOn === true && e?.stack && typeof e.stack === "object" ? e.stack : null;
  const tip = stack && typeof stack.tip === "string" && /^[0-9a-f]{12}$/.test(stack.tip) ? stack.tip : undefined;
  const branch = ctx.stackBranch ?? (typeof stack?.branch === "string" ? stack.branch : undefined);
  const sha = tip ?? (typeof e?.headSha12 === "string" && /^[0-9a-f]{12}$/.test(e.headSha12) ? e.headSha12 : undefined);
  // #C895: where to find the commit without asking: its full sha, the repository (owner/name) and the branch (the stack tip's full sha and
  // the stack's branch when the line names the stack tip; otherwise the card's head, on its own branch, or on main). Each only when the
  // evidence has it in the plain shape, and the full sha only when it is the 12 the line would have named.
  const full = (s, short) => (typeof s === "string" && /^[0-9a-f]{40}$/.test(s) && short && s.startsWith(short) ? s : undefined);
  const fullSha = tip ? full(stack.tipSha, tip) : full(e?.headSha, sha);
  const onBranch = tip ? (typeof stack?.branch === "string" ? stack.branch : undefined) : (typeof e?.headBranch === "string" ? e.headBranch : undefined);
  const inRepo = typeof e?.repoFull === "string" ? e.repoFull : undefined;
  const where = { ...(fullSha ? { fullSha } : {}), ...(inRepo ? { repo: inRepo } : {}), ...(fullSha && onBranch ? { onBranch } : {}) };
  const signed = (Array.isArray(e?.signed) ? e.signed : []).filter((s) => typeof s === "string" && Object.hasOwn(ROLE_OF_NOTE, s));
  const signedBy = signed.map((s) => ROLE_OF_NOTE[s]);
  // #C914: stackMode marks a builder's turn for a card of a stack-mode repository: its wake names the stack-ready command as the push.
  const mode = ctx.stackOn === true ? { stackMode: true } : {};
  const owner = { role: card.owner_role, phase: "build", step: "build", ...(branch ? { stack: branch } : {}), ...mode };
  if (stack?.outside === true && e?.onMain !== true) return [{ role: card.owner_role, phase: "build", step: "outside", ...(branch ? { stack: branch } : {}), ...mode }];
  // #C981: a rework the store read with no reason attached (evidence `rework`; the store clears it once a reason is set) is the owner's turn
  // first: until then every other write to the card is refused, so nothing else on it can move.
  if (e?.rework === true && !(typeof card.rework_reason === "string" && card.rework_reason !== "")) return [{ role: card.owner_role, phase: typeof phase === "string" && /^[a-z]{2,16}$/.test(phase) ? phase : "build", step: "reason" }];
  if (typeof phase !== "string" || phase === "plan" || phase === "build") return [owner];
  // #C852: a review whose note on this commit starts FINDINGS has sent it back: the fix is the owner's turn, and no reviewer is woken to
  // look at a commit already rejected. It is a fact of this sha (evidence.findings), so a new commit clears it without anyone's step.
  const findings = (Array.isArray(e?.findings) ? e.findings : []).filter((s) => typeof s === "string" && Object.hasOwn(ROLE_OF_NOTE, s));
  if (findings.length && Object.hasOwn(ROLE_OF_NOTE, phase)) return [{ role: card.owner_role, phase: "build", step: "rework", sha, ...where, signed: signedBy, ...(branch ? { stack: branch } : {}), ...mode }];
  if (phase === "ship") {
    // #C1013: a pair is for the board's own repository only. A product card (any other repo word) is deployed by Release's ship, so it gets no pair turn.
    // A built pair that waits only for the owner's install and whose pinned commit descends from this card's landing already covers it: no build turn.
    if (e.onMain === true && fullSha && typeof ctx.pairCovers === "function" && ctx.pairCovers(fullSha) === true) return [];
    if (e.onMain === true) return typeof card.repo === "string" && BOARD_REPO_WORDS.has(card.repo) ? [{ role: card.owner_role, phase: "ship", step: "pair", sha, ...where, signed: signedBy }] : [];
    // #C854: signed but no longer continuing main: Release cannot take it. The turn is the owner's, to re-cut it on main (a new commit has a new sha, so a reviewer is woken again).
    if (e.behindMain === true) return [{ role: card.owner_role, phase: "ship", step: "recut", sha, ...where, signed: signedBy, ...(branch ? { stack: branch } : {}) }];
    return [{ role: PHASE_LANES.ship, phase: "ship", step: "land", sha, ...where, signed: signedBy }];
  }
  if (!Object.hasOwn(PHASE_LANES, phase)) return [owner];
  const out = [];
  if (!signed.includes(phase)) out.push({ role: PHASE_LANES[phase], phase, step: "review", sha, ...where, signed: signedBy });
  // #C897: Security beside Checker for a Full card, or when the probe read a security review as needed from the branch's paths.
  const wantsSecurity = card.review_level === "Full" || (Array.isArray(e?.waitingFor) && e.waitingFor.includes("security"));
  if (phase === "checker" && wantsSecurity && !signed.includes("security")) out.push({ role: "Security", phase, step: "review", sha, ...where, signed: signedBy });
  return out;
}

// A card's depends_on (a JSON list of ids, or a list) as plain strings; a list that does not parse is none.
const dependsOf = (c) => {
  let list = c?.depends_on;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch { return []; } }
  return Array.isArray(list) ? list.filter((d) => typeof d === "string") : [];
};
// #C1021: a card's batch (the group it ships with, set by the lead; clearing it pulls the card out) as a plain word, "" for none or an odd value.
export const batchOf = (c) => (typeof c?.batch === "string" && /^[A-Za-z0-9._\/-]{1,100}$/.test(c.batch.trim()) ? c.batch.trim() : "");
const hasHeadEvidence = (v) => !!v && typeof v === "object" && (typeof v.headSha12 === "string" || typeof v.headSha === "string");

// #C914 (R6): what the stack-ready command (scripts/stack-ready.mjs) reads to tell whether cards are still queued behind the one just pushed:
// { at, cards: [{ id, owner_role, repo, dependsOn: [ids], started }] } for every open (not dropped, not live) card, ids and plain words only,
// 500 cards at most. started = the card has a pushed head. Pure: the view in, the object out.
export const STACK_QUEUE_FILE = "stack-queue.json", STACK_QUEUE_MAX = 500;
export function stackQueueFile(view, now) {
  const ev = view?.evidence ?? {};
  const cards = [];
  for (const c of Array.isArray(view?.cards) ? view.cards : []) {
    if (!c || typeof c.id !== "string" || !CARD_ID.test(c.id) || c.dropped || c.done_at) continue; // a card closed as done is no queued partner (#C902)
    const e = ev[`cards.${c.id}`]?.value;
    if ((e?.phase ?? e?.lit?.[0]) === "live") continue;
    cards.push({
      id: c.id,
      owner_role: typeof c.owner_role === "string" && /^[A-Za-z][A-Za-z0-9 _-]{0,40}$/.test(c.owner_role) ? c.owner_role : "",
      repo: typeof c.repo === "string" && /^[A-Za-z0-9._\/-]{1,100}$/.test(c.repo) ? c.repo : "",
      dependsOn: [...new Set(dependsOf(c).filter((d) => CARD_ID.test(d) && d !== c.id))].slice(0, 50),
      batch: batchOf(c), // #C1021: the group the lead put the card in ("" for none); stack-ready waits for every open card of it
      held: !!(c.paused || c.blocked_reason), // #C1021 (Checker 2 F1): a paused or blocked card is no partner to wait for, as the dispatch's activeCard has it
      started: hasHeadEvidence(e),
    });
    if (cards.length >= STACK_QUEUE_MAX) break;
  }
  return { at: now, cards };
}

// The store's view -> { cards, agents, asked } in the shapes dispatchItems reads, or null when the view cannot say who is idle.
// #C973: the week's share of quota used, from the probe's usage reading (evidence.usage weekPct), when it is fresh; null when unknown. At or past
// the ceiling (collector.quotaCeilingPct, 90 by default) no builder is woken for new build work; reviews, landing, fixes and the rest go on, so what
// is built still ships. An unknown or stale reading never stops anything.
// #C988: a session's own reading (usage.week, collector/week-usage.mjs) wins while it is fresh; once written, an hour-old one is unknown (no
// stop, a warning in the dispatch log), never the probe's estimate. The estimate counts only while no session has written a reading.
export const USAGE_FRESH_MS = 26 * 3600e3, QUOTA_CEILING_DEFAULT = 90;
export function weekPctOf(view, now) {
  const s = sessionWeek(view, now);
  if (s.state === "fresh") return s.pct;
  if (s.state === "stale") return null;
  const u = view?.evidence?.usage, pct = u?.value?.weekPct, at = u?.readAt;
  if (!Number.isFinite(pct) || pct < 0 || pct > 1000 || !Number.isFinite(at) || now - at > USAGE_FRESH_MS || at > now + 60e3) return null;
  return pct;
}
export const atCeiling = (view, now, ceiling = QUOTA_CEILING_DEFAULT) => {
  const pct = weekPctOf(view, now), c = Number.isInteger(ceiling) && ceiling >= 1 && ceiling <= 100 ? ceiling : QUOTA_CEILING_DEFAULT;
  return pct !== null && pct >= c;
};
export function dispatchInput(view, now, { lead = "Manager", ceiling = QUOTA_CEILING_DEFAULT, pairCovers = null } = {}) {
  const ev = view?.evidence ?? {};
  const agents = ev.agents?.value;
  const readAt = ev.agents?.readAt;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return null;
  if (!Number.isFinite(readAt) || now - readAt > AGENTS_FRESH_MS || readAt > now + 5_000) return null;
  const stopBuild = atCeiling(view, now, ceiling);
  const cards = [];
  const all = Array.isArray(view?.cards) ? view.cards : [];
  const phaseOf = (id) => { const e = ev[`cards.${id}`]?.value; return e?.phase ?? e?.lit?.[0]; };
  // #C845: a card waits for the cards it depends on (depends_on, a JSON list of ids) until each is live. A dependency the board doesn't
  // have, or one that was dropped, holds nothing (as the gate's dependsOnErrors reads it).
  const open = new Map(all.filter((k) => k && typeof k.id === "string" && !k.dropped && !k.done_at).map((k) => [k.id, k]));
  // #C859 slice 3 (stack mode): the board repository's switch is on (a card with no repo word, or "flight-board", is the board's). The stack's
  // branch is the one the evidence names on any of its cards; a builder's turn carries it, and a reviewer is not woken for a card in the stack
  // while a card of the same repository still has a build turn (design 3: Checker and Security are woken once, when no builder has a card queued).
  const switchOn = (Array.isArray(view?.stackSwitch) ? view.stackSwitch : []).some((s) => s && s.repo === "board" && (s.stack === true || s.stack === 1));
  const boardCard = (c) => !c.repo || c.repo === "flight-board";
  // #C914 (R4): in stack mode a dependency the same builder has PUSHED (not yet live) is satisfied for a card of the board's repository: card 2 of a
  // stack starts while card 1 waits for its review. Another role's card, or any other repository, still has to be live.
  const hasHead = (id) => hasHeadEvidence(ev[`cards.${id}`]?.value);
  const pushed = (id) => hasHead(id) && ev[`cards.${id}`].value.stack?.outside !== true;
  const waitsOn = (c) => dependsOf(c).filter((d) => d !== c.id && open.has(d) && phaseOf(d) !== "live"
    && !(switchOn && boardCard(c) && boardCard(open.get(d)) && open.get(d).owner_role === c.owner_role && pushed(d)));
  // #C914 (R3): a card WAITS (the probe's stackHold is applied) only when it has a declared stack partner: another open card of the same builder
  // and repository that depends on it and has nothing pushed yet. The instant the partner is pushed the hold lifts by itself.
  const activeCard = (k) => !k.paused && !k.dropped && !k.done_at && !k.blocked_reason && phaseOf(k.id) !== "live"; // #C902: a card closed as done is no partner
  const hasPartner = (c) => all.some((k) => k && typeof k.id === "string" && k.id !== c.id && activeCard(k) && k.owner_role === c.owner_role && boardCard(k) === boardCard(c)
    && (boardCard(c) || k.repo === c.repo) && !hasHead(k.id) && dependsOf(k).includes(c.id))
    // #C1021: a card of the same batch (any builder, the same repository) that is not built yet is a partner too: the batch is one review and one pack.
    || (batchOf(c) !== "" && all.some((k) => k && typeof k.id === "string" && k.id !== c.id && activeCard(k) && batchOf(k) === batchOf(c) && (k.repo || null) === (c.repo || null) && !hasHead(k.id)));
  // #C953: the stack a card is told to join is one of ITS OWN repository: only a card with the same repo word (none matching none) names the
  // branch. A product card with no repo word (Builder's #C930 to #C951 stack) no longer hands its branch to a flight-board card (#C928 was told to
  // stack on #C948's product branch); with no same-repo card on a stack the card builds from main, as with the switch off.
  const sameRepoWord = (a, b) => (a.repo || null) === (b.repo || null);
  const stackBranchFor = (card) => switchOn ? all.filter((k) => k && typeof k.id === "string" && boardCard(k) && sameRepoWord(k, card)).map((k) => ev[`cards.${k.id}`]?.value?.stack?.branch).find((b) => typeof b === "string") : undefined;
  const BUILD_STEPS = new Set(["build", "rework", "outside"]);
  // #C915 (b): whether a hold_end has come: its ask is closed, or its card is dropped, done or live. An id the view does not hold stays open.
  // (A hold that stays open for 2 h raises a line to Manager in the store, heldWakes: it cannot hide a card for ever.)
  const endPassed = (ref) => {
    const ask = (Array.isArray(view?.asks) ? view.asks : []).find((a) => a && a.id === ref);
    if (ask) return ask.closed_at != null;
    const k = all.find((x) => x && x.id === ref);
    return !!k && (!!k.dropped || !!k.done_at || phaseOf(ref) === "live");
  };
  for (const c of all) {
    if (!c || typeof c.id !== "string" || !CARD_ID.test(c.id) || typeof c.owner_role !== "string") continue;
    if (waitsOn(c).length) continue;
    // Active: not paused, not dropped, not blocked (a blocked card is "blocked" on the old shape and the store's stall rule skips it), and
    // not already live (a live card waits for the lead to close it, not for its owner). The phase is read as compat-view reads it.
    if (c.paused || c.dropped || c.done_at || c.blocked_reason) continue; // #C902: a card closed as done is never dispatched
    const e = ev[`cards.${c.id}`]?.value;
    if ((e?.phase ?? e?.lit?.[0]) === "live") continue;
    // #C850: a hold with an end (a card the lead put on hold) is skipped; the stall rule brings it back when the hold ends.
    // #C915 (b): skipped while the hold is OPEN (holdOpen: hold_end on an open ask or card, or a check_at to come); once its end has passed the
    // card is dispatched again, and the store's held-card line has already told Manager to lift or renew it.
    if (holdOpen(c, now, endPassed)) continue;
    const inBoard = switchOn && boardCard(c);
    // #C914: a card the probe marks stackHold (pushed, no stack-ready signal covers its head) AND that has a declared stack partner waiting to
    // start has no review turn, and is no builder turn either. Any other card dispatches as it always did.
    const held = inBoard && e?.stackHold === true && hasPartner(c);
    const turns = turnsOf(c, e, { ...(inBoard ? { stackOn: true, stackBranch: stackBranchFor(c) } : {}), ...(pairCovers ? { pairCovers } : {}) });
    cards.push({ queuePos: Number.isInteger(c.queue_pos) && c.queue_pos >= 1 ? c.queue_pos : null, ownerPlaced: c.queue_set_by === "owner", id: c.id, who: c.owner_role, status: "active", num: Number.isInteger(c.num) ? c.num : null, waitingOn: typeof c.waiting_on === "string" ? c.waiting_on : null, turns: held ? turns.filter((t) => t.step !== "review") : turns, inBoard, inStack: inBoard && e?.stack && e.stack.outside !== true && !held });
  }
  if (switchOn && cards.some((k) => k.inBoard && k.turns.some((t) => BUILD_STEPS.has(t.step)))) {
    for (const k of cards) if (k.inStack) k.turns = k.turns.filter((t) => t.step !== "review");
  }
  for (const k of cards) { delete k.inBoard; delete k.inStack; }
  // #C973: at the quota ceiling, no new build work: a build turn is dropped; a fix (rework, reason, outside, recut) and every other turn stay.
  if (stopBuild) for (const k of cards) k.turns = k.turns.filter((t) => t.step !== "build");
  // #C872 (2026-11-10: the owner answered A on #T1782 for #C862 and Builder sat idle 20 minutes; the answer only reached it through Manager's
  // chat): a Decision on a card that the owner answered in the last DECISION_FRESH_MS is that card's owner's turn while the owner has stayed
  // idle since the answer came. The wake ends the idleness, so the turn goes by itself: once per answer, with no state of its own. It takes the
  // place of the owner's other turns on that card (one turn per role and card). The newest answered Decision of a card counts; a closed one
  // too, since the lead may close it at once and the owner still has not heard.
  const answered = new Map();
  const idByNum = new Map((Array.isArray(view?.cards) ? view.cards : []).filter((c) => Number.isInteger(c?.num) && typeof c.id === "string").map((c) => [c.num, c.id]));
  for (const a of Array.isArray(view?.asks) ? view.asks : []) {
    const card = askCardId(a, idByNum);
    if (!a || a.type !== "Decision" || !card || !Number.isFinite(a.answered_at) || !Number.isInteger(a.num)) continue;
    if (now - a.answered_at > DECISION_FRESH_MS || a.answered_at > now + 5_000) continue;
    const had = answered.get(card);
    if (!had || a.answered_at > had.answered_at) answered.set(card, a);
  }
  for (const k of cards) {
    const d = answered.get(k.id), ag = d && Object.hasOwn(agents, k.who) ? agents[k.who] : null;
    const idleSince = ag && (Number.isFinite(ag.since) ? ag.since : ag.lastActivityAt);
    if (!d || ag?.state !== "idle" || !Number.isFinite(idleSince) || idleSince > d.answered_at) continue;
    k.turns = [...k.turns.filter((t) => t.role !== k.who), { role: k.who, phase: "decision", step: "decision", ask: d.num, answer: d.answer }];
  }
  // #C916 (11-11 ~3 am MT: the app capped Manager's SendMessage; Manager posted the #C914 pick on the card's thread and Boardsmith never saw
  // it): a post by the lead on a card's thread in the last DECISION_FRESH_MS is that card's owner's turn while the owner has stayed idle since
  // the post, as an answered Decision is (#C872): once per post, with no state of its own. A card whose owner is the lead, or that already has a
  // decision turn, is left as it is.
  const posted = new Map();
  for (const m of Array.isArray(view?.threads?.messages) ? view.threads.messages : []) {
    if (!m || m.author !== lead || typeof m.thread_id !== "string" || !Number.isFinite(m.created_at)) continue;
    if (now - m.created_at > DECISION_FRESH_MS || m.created_at > now + 5_000) continue;
    if ((posted.get(m.thread_id) ?? -Infinity) < m.created_at) posted.set(m.thread_id, m.created_at);
  }
  for (const k of cards) {
    const at = posted.get(k.id), ag = Number.isFinite(at) && k.who !== lead && Object.hasOwn(agents, k.who) ? agents[k.who] : null;
    const idleSince = ag && (Number.isFinite(ag.since) ? ag.since : ag.lastActivityAt);
    if (!ag || ag.state !== "idle" || !Number.isFinite(idleSince) || idleSince > at || k.turns.some((t) => t.step === "decision")) continue;
    k.turns = [...k.turns.filter((t) => t.role !== k.who), { role: k.who, phase: "post", step: "post" }];
  }
  // #C871 (item 4): an agent's queue is in the owner's order (queue_pos, then the card's number), and an idle agent is woken for the FIRST card
  // of it that can start (nothing pushed, not held by a depends_on, which was skipped above), not for every queued card at once.
  // #C910: the first card that can start is the first one dispatchItems would not drop. Choosing before its filters let a first card with an open
  // ask, or waiting on someone else, take the agent's only turn and then be dropped: the agent was woken for nothing and its 22 other cards lost theirs.
  const askedCards = new Set();
  for (const a of Array.isArray(view?.asks) ? view.asks : []) if (a && typeof a.card_id === "string" && a.closed_at == null && a.answered_at == null) askedCards.add(a.card_id);
  const notStarted = (k) => k.turns.some((t) => t.step === "build" && !t.sha) && !askedCards.has(k.id) && !(typeof k.waitingOn === "string" && k.waitingOn.trim() && !k.waitingOn.trim().startsWith(k.who));
  const byRole = new Map();
  for (const k of cards.filter(notStarted)) byRole.set(k.who, [...(byRole.get(k.who) ?? []), k]);
  for (const list of byRole.values()) {
    // The same order as the store's (worker/board-rules.mjs queueRank; a held card was skipped above): at one place a card the owner placed comes
    // before one an agent placed (Checker F1 on ac3d31b), then the card's number.
    list.sort((x, y) => (x.queuePos ?? 1e6) - (y.queuePos ?? 1e6) || (x.ownerPlaced ? 0 : 1) - (y.ownerPlaced ? 0 : 1) || (x.num ?? 1e9) - (y.num ?? 1e9) || (x.id < y.id ? -1 : 1));
    for (const k of list.slice(1)) k.turns = k.turns.filter((t) => !(t.step === "build" && !t.sha));
  }
  // The cards left out of the lists above (asked, or waiting on someone else) keep their turn, which dispatchItems drops by the same rule.
  for (const k of cards) { delete k.queuePos; delete k.ownerPlaced; }
  // #C858: the deploy pair is one per repository main, not one per landed card: of the cards a role is woken for to build the pair, the newest
  // (highest number) keeps the turn, and the line names the step; the others are covered by the same pair.
  const pairs = new Map();
  for (const k of cards) if (k.turns.some((t) => t.step === "pair")) pairs.set(k.who, [...(pairs.get(k.who) ?? []), k]);
  for (const list of pairs.values()) {
    list.sort((x, y) => (y.num ?? 0) - (x.num ?? 0) || (x.id < y.id ? -1 : 1));
    for (const k of list.slice(1)) k.turns = k.turns.filter((t) => t.step !== "pair");
  }
  // A card with an open ask is waiting for the owner or the lead, not for its agent. Open = not closed and not answered, as on the old
  // board (!done && !response): a withdrawn approval has its answer cleared and waits for the owner's Approve again, so it is still open.
  const asked = new Set();
  for (const a of Array.isArray(view?.asks) ? view.asks : []) if (a && typeof a.card_id === "string" && a.closed_at == null && a.answered_at == null) asked.add(a.card_id);
  return { cards, agents, asked };
}

// #C909 (prevention, 11-11: after v1.209.8 Release thought Ops was archived and asked Manager to wake it by hand; a hand-off resting on a
// model): a new live product version (the view's `live`, as the page header reads it) wakes Ops once for its after-ship check, the way a
// pushed commit wakes a reviewer. The turn is a card of its own, `after-ship-v<x>-<y>-<z>`, so the DISPATCH line names the version.
// dispatch-state.json keeps `live`: { version, at (first seen), wokenAt?, done }. The turn holds until Ops has worked after it was woken
// (no longer idle, or idle since after the wake), so it fires once per version. The version already live the first time this runs, a
// version older than AFTER_SHIP_WINDOW_MS, and an unchanged version wake nobody.
export const AFTER_SHIP_ROLE = "Ops", AFTER_SHIP_WINDOW_MS = 24 * 3600e3;
export const afterShipId = (version) => {
  const v = typeof version === "string" ? version.replace(/^v/, "") : "";
  return /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(v) ? `after-ship-v${v.replace(/\./g, "-")}` : null;
};
// { card: the turn to add or null, live: the state to keep }.
export function afterShip(view, before, agents, now) {
  const prev = before && typeof before.live === "object" && before.live && !Array.isArray(before.live) ? before.live : null;
  const id = view?.live?.state === "live" ? afterShipId(String(view.live.version ?? "")) : null;
  if (!id) return { card: null, live: prev };
  const version = String(view.live.version).replace(/^v/, "");
  if (!prev || typeof prev.version !== "string") return { card: null, live: { version, at: now, done: true } };
  let live = prev.version === version ? { ...prev } : { version, at: now, done: false };
  const ag = agents && Object.hasOwn(agents, AFTER_SHIP_ROLE) ? agents[AFTER_SHIP_ROLE] : null;
  const idleSince = ag && (Number.isFinite(ag.since) ? ag.since : ag.lastActivityAt);
  if (!live.done && Number.isFinite(live.wokenAt) && ag && (ag.state !== "idle" || (Number.isFinite(idleSince) && idleSince > live.wokenAt))) live.done = true;
  if (!live.done && !(Number.isFinite(live.at) && now - live.at <= AFTER_SHIP_WINDOW_MS)) live.done = true;
  if (live.done) return { card: null, live };
  return { card: { id, who: AFTER_SHIP_ROLE, status: "active", num: null, waitingOn: null, turns: [{ role: AFTER_SHIP_ROLE, phase: "live", step: "aftership" }] }, live };
}

const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const writeAtomic = (path, text) => { const tmp = `${path}.${process.pid}.part`; writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, path); };

// #C914 (R6): <dir>/stack-queue.json, by the same atomic writer as dispatch.json (mode 0600, rename into place). Read-only for the builder.
export function writeStackQueue(view, { dir, now = Date.now() }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(join(dir, STACK_QUEUE_FILE), JSON.stringify(stackQueueFile(view, now)));
}

// #C957: <dir>/open-asks.json { at, asks: [<ask number>, ...] }, the asks the store holds open (not closed, not withdrawn), by the same atomic
// writer. The Stop hook reads it so a reply whose red line names an ask that is already open does not demand a second one. 1000 numbers at most.
export const OPEN_ASKS_FILE = "open-asks.json", OPEN_ASKS_MAX = 1000;
export function openAsksFile(view, now) {
  const asks = (Array.isArray(view?.asks) ? view.asks : []).filter((a) => a && Number.isInteger(a.num) && a.num > 0 && !a.closed_at && !a.withdrawn_at).map((a) => a.num).sort((a, b) => a - b).slice(-OPEN_ASKS_MAX);
  return { at: now, asks };
}
export function writeOpenAsks(view, { dir, now = Date.now() }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(join(dir, OPEN_ASKS_FILE), JSON.stringify(openAsksFile(view, now)));
}

// #C967: <dir>/land-holds.json { at, cards: { <card id>: "" | "paused" | "dropped" | "blocked" | "asked" | "waiting_on" } }, what the landing job
// (scripts/board-land.mjs) reads to tell a card held from a card free to land. One entry per card the store knows ("" = no hold), plain words
// only (never a reason text), by the same atomic writer. A card the file does not list is unknown to the job, which then lands nothing for it.
export const LAND_HOLDS_FILE = "land-holds.json", LAND_HOLDS_MAX = 2000;
// Checker 2 on 98cefa1: (F1) an open ask on a card (not closed, not answered, not withdrawn) is the owner's or the lead's to settle, so it holds the
// card ("asked"); an install (Terminal) ask from an earlier landing of the same card holds a v2 too, the safe side until the owner says otherwise.
// (F2) `waiting_on` is the lead's routine "next is" pointer ("Checker: PASS at ...", "Release"): one that starts with a review or landing role is no
// hold, since after Checker and Security sign the landing is the very next step; any other (the owner, Manager, another builder) still is.
export const LANDING_ROLES = /^\s*(?:Checker|Security|Release)\b/i;
export function landHoldsFile(view, now) {
  const cards = {};
  const asked = new Set();
  for (const a of Array.isArray(view?.asks) ? view.asks : []) if (a && typeof a.card_id === "string" && a.closed_at == null && a.answered_at == null && a.withdrawn_at == null) asked.add(a.card_id);
  for (const c of Array.isArray(view?.cards) ? view.cards : []) {
    if (!c || typeof c.id !== "string" || !CARD_ID.test(c.id) || Object.keys(cards).length >= LAND_HOLDS_MAX) continue;
    const has = (v) => typeof v === "string" && v.trim() !== "";
    cards[c.id] = c.dropped ? "dropped" : c.paused ? "paused" : has(c.blocked_reason) ? "blocked" : asked.has(c.id) ? "asked" : has(c.waiting_on) && !LANDING_ROLES.test(c.waiting_on) ? "waiting_on" : "";
  }
  return { at: now, cards };
}
export function writeLandHolds(view, { dir, now = Date.now() }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(join(dir, LAND_HOLDS_FILE), JSON.stringify(landHoldsFile(view, now)));
}

// One run over a view. Returns { wrote, why?, items }. `dir` is <stateDir>/<board>.
export function dispatchRun(view, { dir, roster, lead, ceiling = QUOTA_CEILING_DEFAULT, now = Date.now(), log = () => {}, pairCovers = null }) {
  const input = dispatchInput(view, now, { lead, ceiling, pairCovers });
  const sw = sessionWeek(view, now);
  if (sw.state === "stale") log(`dispatch: warning: the session's week reading is ${Math.round(sw.ageMs / 60e3)} min old (or from a week that reset): week usage unknown, the quota stop is off until a session writes it again`);
  if (input && atCeiling(view, now, ceiling)) log(`dispatch: week at ${Math.round(weekPctOf(view, now))}% of quota, ceiling ${ceiling}%: no new build work dispatched`);
  if (!input) { log("dispatch: the store's agent reading is missing or older than 5 minutes; nothing written"); return { wrote: false, why: "agents-stale", items: [] }; }
  const file = readJson(join(dir, DISPATCH_FILE));
  if (file && file.source !== "store" && Number.isFinite(file.at) && now - file.at < FOREIGN_WRITER_MS) {
    log("dispatch: the old state job still writes dispatch.json; nothing written");
    return { wrote: false, why: "foreign-writer", items: [] };
  }
  const state = readJson(join(dir, DISPATCH_STATE_FILE));
  mkdirSync(dir, { recursive: true, mode: 0o700 }); // the board's state folder may not exist yet when the old state job never ran here
  const ship = afterShip(view, state, input.agents, now);
  const r = dispatchItems({ cards: ship.card ? [...input.cards, ship.card] : input.cards, agents: input.agents, asked: input.asked, roster, lead, now, before: state });
  const live = ship.card && r.items.some((i) => i.card === ship.card.id) && !Number.isFinite(ship.live.wokenAt) ? { ...ship.live, wokenAt: now } : ship.live;
  writeAtomic(join(dir, DISPATCH_FILE), JSON.stringify({ at: now, source: "store", items: r.items }));
  writeAtomic(join(dir, DISPATCH_STATE_FILE), JSON.stringify(live ? { ...r.state, live } : r.state));
  // #C940: the roles' states in the log, so a minute with nothing dispatched can be told from a blind or missing session (role names and one word each).
  log(`dispatch: agents ${(Array.isArray(roster) ? roster : []).filter((x) => typeof x === "string" && /^[A-Za-z][A-Za-z0-9 _-]{0,40}$/.test(x)).map((x) => `${x}=${input.agents[x] ? String(input.agents[x].state).replace(/[^a-z]/g, "") || "?" : "none"}`).join(" ")}`);
  log(`dispatch: ${r.items.length} item(s)`);
  return { wrote: true, items: r.items };
}
