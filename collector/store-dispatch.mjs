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
import { mtDate, mtHour } from "../worker/team-time.mjs";
import { heldFor } from "../worker/held-by.mjs"; // #C1164: the one reading of waiting_on
import { agentRank, orderListOf, startedGroupSet, openGroupWithheld, startedGroupMembers, groupStartedByOther, ownerTurn, isHeld, dependsNotLive, isRework, stackKeyOf, stackOnFor, stackSatisfies, STALL_WAKE_AFTER_MS, reviewerOf, CHECKER_NAME } from "../worker/board-rules.mjs"; // #C1053: the one order of an agent's work (rework, started group, the owner's group order, queue_pos), shared with the stall line and the queue move
import { REVIEW_LANES, isReviewLane, reworkKind } from "../worker/reading.mjs"; // #C1385: the lane table, the review-lane test and the rework rule are the reading module's, not copies here

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

// #C1073 (11-12 ~10:45 pm: Builder's watch fired "DISPATCH #C1071 ... build it" on every re-arm, though the card had an open decision on its thread, the owner's A or B): a Decision the
// lead posts in a thread (kind "decision", with its options; no ask row is made, #C920) is a question to the owner like an open ask, but the asks list never held it, so the dispatch kept
// waking the card's owner. A decision message is OPEN until the owner has written in that thread after it (or the thread's later message is marked resolved). It names its card by the
// "Card: <id>" line the store adds when the Decision carried a card_id, else by the one #C<n> its first line names (askCardId). A card the view does not hold names none. Pure.
// Returns the Set of card ids with an open decision. idByNum: the view's cards, number to id.
// Security's L1 (17174f9b): only the LEAD's decision holds a card; any other role's (or a prompt-injected session's) "decision" holds nothing. An unnamed lead holds nothing (fails closed).
export function openDecisionCards(view, idByNum, lead = "Manager") {
  const out = new Set(), ids = new Set(idByNum.values());
  const msgs = (Array.isArray(view?.threads?.messages) ? view.threads.messages : []).filter((m) => m && typeof m.thread_id === "string" && Number.isFinite(m.created_at));
  const settledAt = new Map(); // thread id -> the time of its newest owner message or resolved message
  for (const m of msgs) if (m.author === "owner" || m.resolved) settledAt.set(m.thread_id, Math.max(settledAt.get(m.thread_id) ?? -Infinity, m.created_at));
  for (const m of msgs) {
    if (m.kind !== "decision" || typeof lead !== "string" || !lead || m.author !== lead || (settledAt.get(m.thread_id) ?? -Infinity) >= m.created_at) continue; // a resolved decision is settled by itself (settledAt counts it)
    const body = String(m.body ?? ""), line = body.split("\n")[0];
    const tagged = /^Card: ([a-z0-9][a-z0-9-]{0,63})$/m.exec(body)?.[1];
    const id = tagged && ids.has(tagged) ? tagged : askCardId({ title: line }, idByNum) ?? (ids.has(m.thread_id) ? m.thread_id : null); // else the card whose own thread it is posted in (Checker 2's note)
    if (id && ids.has(id)) out.add(id);
  }
  return out;
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
export const PHASE_LANES = REVIEW_LANES; // #C1385: the reading module's table of the review lanes and ship (plan, build and the post-landing phases are the owner's), not a copy
// The repo words of a card of the board's own repository that gets a deploy pair when it lands: kept in collector/pairs.mjs (#C1020), which the
// pinned probe imports; re-exported here for the dispatch's callers.
import { BOARD_REPO_WORDS, repoKey, isBoardRepo, isBoardCard } from "./pairs.mjs";
import { wantsSecurity as wantsSecurityOf } from "./signoff.mjs";
export { BOARD_REPO_WORDS };
const ROLE_OF_NOTE = { language: "Linguist", design: "Designer", checker: "Checker", security: "Security" };
// #C859 slice 3 (stack mode): ctx.stackBranch is the branch of the stack the card's repository has (when its switch is on), named in a
// builder's turn; a card the evidence reads as outside the stack (e.stack.outside) is told to re-cut; a reviewer is sent the stack tip.
export function turnsOf(card, e, ctx = {}) {
  const phase = e?.phase ?? e?.lit?.[0];
  // Only with the switch on for the card's repository (ctx.stackOn): evidence left from when it was on says nothing once it is off.
  const stack = ctx.stackOn === true && e?.stack && typeof e.stack === "object" ? e.stack : null;
  const tip = stack && typeof stack.tip === "string" && /^[0-9a-f]{12}$/.test(stack.tip) ? stack.tip : undefined;
  // #C1327: an outside card's own evidence names the branch it was cut away from, which may be gone: only a branch an open member carries (ctx.stackBranch) is named to it.
  const branch = ctx.stackBranch ?? (stack?.outside !== true && typeof stack?.branch === "string" ? stack.branch : undefined);
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
  // #C1228 (11-18: #C1225 was woken on every re-arm with "nothing pushed" while its tip was pushed and signed; stack-ready had refused it for a trailer): a
  // build turn for a tip that is pushed (not a WIP start push) and that no READY covers says so, and names the commit, so the line asks for the signal.
  const unready = ctx.stackOn === true && e?.stackHold === true && e?.wipHead !== true && sha ? { sha, ...where, ready: true } : {};
  // #C1239: a pushed tip whose Board-Id line is not git's trailer (the line sits in a paragraph of its own): the board cannot match the card to it, so the build turn says what is wrong with the commit.
  const misplaced = e?.trailerMisplaced === true && e?.wipHead !== true && sha ? { sha, ...where, trailer: true } : {};
  const owner = { role: card.owner_role, phase: "build", step: "build", ...(branch ? { stack: branch } : {}), ...mode, ...unready, ...misplaced };
  if (stack?.outside === true && e?.onMain !== true) return [{ role: card.owner_role, phase: "build", step: "outside", ...(branch ? { stack: branch } : {}), ...mode }];
  // #C981: a rework the store read with no reason attached (evidence `rework`; the store clears it once a reason is set) is the owner's turn
  // first: until then every other write to the card is refused, so nothing else on it can move.
  if (reworkKind(card, e) === "reason") return [{ role: card.owner_role, phase: typeof phase === "string" && /^[a-z]{2,16}$/.test(phase) ? phase : "build", step: "reason" }];
  // #C1114: the Worker holds a step back from a review phase that has no FINDINGS note and no reason as rework "unexplained" (the card stays where it was shown):
  // the reviewer of that phase is asked to file the finding on this commit, which is what fills the counters. The owner is not woken: there is nothing to fix yet.
  if (e?.rework === "unexplained" && phase !== "ship" && isReviewLane(phase)) { // PHASE_LANES has no plan or build: the review lanes, and ship (the lander's, not a review)
    return [{ role: phase === "checker" && typeof ctx.reviewer === "string" ? ctx.reviewer : PHASE_LANES[phase], phase, step: "unexplained", sha, ...where, signed: signedBy }];
  }
  if (typeof phase !== "string" || phase === "plan" || phase === "build") return [owner];
  // #C852: a review whose note on this commit starts FINDINGS has sent it back: the fix is the owner's turn, and no reviewer is woken to
  // look at a commit already rejected. It is a fact of this sha (evidence.findings), so a new commit clears it without anyone's step.
  if (reworkKind(card, e) === "findings") return [{ role: card.owner_role, phase: "build", step: "rework", sha, ...where, signed: signedBy, ...(branch ? { stack: branch } : {}), ...mode }];
  if (phase === "ship") {
    // #C1013: a pair is for the board's own repository only. A product card (any other repo word) is deployed by Release's ship, so it gets no pair turn.
    // A built pair that waits only for the owner's install and whose pinned commit descends from this card's landing already covers it: no build turn.
    if (e.onMain === true && fullSha && typeof ctx.pairCovers === "function" && ctx.pairCovers(fullSha) === true) return [];
    if (e.onMain === true) return isBoardRepo(card.repo) ? [{ role: card.owner_role, phase: "ship", step: "pair", sha, ...where, signed: signedBy, ...(batchOf(card) ? { batch: batchOf(card) } : {}) }] : [];
    // #C854: signed but no longer continuing main: Release cannot take it. The turn is the owner's, to re-cut it on main (a new commit has a new sha, so a reviewer is woken again).
    if (e.behindMain === true) return [{ role: card.owner_role, phase: "ship", step: "recut", sha, ...where, signed: signedBy, ...(branch ? { stack: branch } : {}) }];
    // #C975: a ship lane per repository. A board card's landing is the landing job's (scripts/board-land.mjs, #C967, the owner's A on #T1779): while
    // its report is fresh, Release is woken only for a tip the job refused. With no fresh report (the job is not running) Release lands it by hand,
    // as before. A product card is Release's. So a board landing never waits behind a product ship, and Release is not asked to land a board tip twice.
    const board = isBoardRepo(card.repo);
    if (board && ctx.landing?.fresh === true && fullSha && !ctx.landing.refused?.has(fullSha)) return [];
    return [{ role: PHASE_LANES.ship, phase: "ship", step: "land", sha, ...where, signed: signedBy }];
  }
  if (!isReviewLane(phase)) return [owner];
  const out = [];
  // #C1098: the checker phase's reviewer is the one the board's config names for the card's repository (ctx.reviewer, a roster role); none names the phase's lane.
  if (!signed.includes(phase)) out.push({ role: phase === "checker" && typeof ctx.reviewer === "string" ? ctx.reviewer : PHASE_LANES[phase], phase, step: "review", sha, ...where, signed: signedBy });
  // #C897: Security beside Checker for a Full card, or when the probe read a security review as needed from the branch's paths.
  // #C1163: one rule with the page's level (compat-view shownLevel): collector/signoff.mjs wantsSecurity, which also wants it for every card of the board's own repository.
  const wantsSecurity = wantsSecurityOf({ review_level: card.review_level, repo: card.repo, waitingFor: e?.waitingFor });
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
  const evidenceById = Object.fromEntries(Object.entries(ev).filter(([k]) => k.startsWith("cards.")).map(([k, v]) => [k.slice(6), v?.value]));
  const startedGroups = startedGroupMembers((Array.isArray(view?.cards) ? view.cards : []).filter(Boolean), (id) => evidenceById[id]); // #C1103 (M1): the groups already started, and by which cards
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
      held: !!(c.paused || c.blocked_reason), // #C1021 (Checker 2 F1): a paused or blocked card is no partner to wait for
      // #C1103 (Checker 2's M2): the store's own reading of "held" for the group order (orderCards: paused, isHeld = waiting_on or a blocked_reason, or a dependency not live), so the
      // pre-push check and the store's stall line agree; `held` above stays what stack-ready waits on.
      orderHeld: !!(c.paused || isHeld(c) || dependsNotLive(c, view.cards, evidenceById)),
      started: hasHeadEvidence(e),
      num: Number.isInteger(c.num) ? c.num : null, // #C1103: for the line that names the higher card
      rework: isRework(c, e), // #C1103 (M1, the owner's pick A): a card sent back with findings is never held back by the group order
      groupStarted: groupStartedByOther(startedGroups, batchOf(c), c.id), // ... nor is the next card of a group that has started
      turn: ownerTurn(c, e), // #C1103: the card needs its owner now (not pushed, in build, or in rework): the pre-push group-order check reads it
    });
    if (cards.length >= STACK_QUEUE_MAX) break;
  }
  // #C1103: the owner's order of the groups, { batch, pos }, as the store holds it (a group nobody placed is not in the list).
  // #C1372: a group nobody placed rides as { batch, num } (its #G number), so the pre-push check ranks a new group after an older one as the dispatch does.
  const groups = orderListOf(view?.groupOrder, view?.groupNames).filter((g) => /^[A-Za-z0-9._\/-]{1,100}$/.test(g.batch)).slice(0, 100);
  return { at: now, cards, groups };
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
// #C975: the landing job's report (<dir>/land-report.json, scripts/board-land.mjs: { at, landed, refused: [{ sha }], waiting }), read as
// { fresh, refused: Set of 40-hex shas }. Fresh: written at most LAND_REPORT_FRESH_MS ago and not in the future (a minute's leeway). Anything else
// (no file, no time, a stale or future one) is not fresh: the job is taken as not running, and Release lands board cards by hand.
export const LAND_REPORT_FILE = "land-report.json", LAND_REPORT_FRESH_MS = 25 * 60e3;
export function landingFrom(report, now) {
  const at = report?.at;
  const fresh = !!report && typeof report === "object" && Number.isFinite(at) && now - at <= LAND_REPORT_FRESH_MS && at - now <= 60e3;
  const refused = new Set((fresh && Array.isArray(report.refused) ? report.refused : []).map((r) => r?.sha).filter((s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s)));
  // #C1090: the report says five or more docs/DATA.d fragments wait on main (scripts/board-land.mjs: foldDue true and the count dataFragments); only a fresh report counts.
  const foldDue = fresh && report.foldDue === true && Number.isInteger(report.dataFragments) && report.dataFragments >= 1;
  return { fresh, refused, foldDue };
}
// #C1098 (11-16: the dispatch sent #C1091 v2 and #C1096 v2, flight-board code, to Checker, who woke for nothing and passed them on each time): the checker phase's
// reviewer for a card is the role the config's collector.reviewers names for the card's repository ("flight-board" is the board's own: a card with no repo word or
// one of BOARD_REPO_WORDS), when that role is on the roster; otherwise the phase's own lane (Checker). `reviewers` is { repository word: role }.
export function reviewerFor(card, reviewers, roster = []) {
  const role = reviewerOf(card, reviewers); // #C1385: the Worker's one reading of which role the config names; the dispatch only asks that the role is on the roster
  return role !== undefined && Array.isArray(roster) && roster.includes(role) ? role : undefined;
}
export function dispatchInput(view, now, { lead = "Manager", ceiling = QUOTA_CEILING_DEFAULT, pairCovers = null, landing = null, reviewers = null, roster = [] } = {}) {
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
  // #C1295: the switch is per repository: the rows that are on ("board" for the board's own repository, "product" for any other), and a card reads its own repository's.
  const switchOn = new Set((Array.isArray(view?.stackSwitch) ? view.stackSwitch : []).filter((s) => s && (s.repo === "board" || s.repo === "product") && (s.stack === true || s.stack === 1)).map((s) => s.repo));
  // #C914 (R4): in stack mode a dependency the same builder has PUSHED (not yet live) is satisfied for a card of the board's repository: card 2 of a
  // stack starts while card 1 waits for its review. Another role's card, or any other repository, still has to be live.
  const hasHead = (id) => hasHeadEvidence(ev[`cards.${id}`]?.value);
  const pushed = (id) => hasHead(id) && ev[`cards.${id}`].value.stack?.outside !== true;
  const waitsOn = (c) => dependsOf(c).filter((d) => d !== c.id && open.has(d) && phaseOf(d) !== "live"
    && !(stackSatisfies(switchOn, c, open.get(d)) && pushed(d)));
  // #C1053 (the owner, 11-12 8:18 pm: "we work on groups and don't segment them"): a group is STARTED when one of its cards (not dropped) has been pushed, landed
  // (live) or closed as done. An agent finishes every card it owns in a started group before it takes a card from another group (queueOrder below).
  const startedGroups = startedGroupSet(all.map((k) => (k && typeof k === "object" ? { ...k, batch: batchOf(k) } : k)), (id) => ev[`cards.${id}`]?.value);
  // #C953: the stack a card is told to join is one of ITS OWN repository: only a card with the same repo word (none matching none) names the
  // branch. A product card with no repo word (Builder's #C930 to #C951 stack) no longer hands its branch to a flight-board card (#C928 was told to
  // stack on #C948's product branch); with no same-repo card on a stack the card builds from main, as with the switch off.
  const sameRepoWord = (a, b) => (a.repo || null) === (b.repo || null);
  // #C1327 (11-20: with no open stack head Demos' watch told #C1326 to re-cut on build/ship-v1.215.7, a branch long gone from origin): only an OPEN card still in the stack names
  // its branch; a live, closed, dropped or outside card's leftover evidence names nothing, and with no such card the card is cut from main.
  const stackBranchFor = (card) => stackOnFor(switchOn, card) ? all.filter((k) => k && typeof k.id === "string" && open.has(k.id) && phaseOf(k.id) !== "live" && ev[`cards.${k.id}`]?.value?.stack?.outside !== true && stackKeyOf(k) === stackKeyOf(card) && sameRepoWord(k, card)).map((k) => ev[`cards.${k.id}`]?.value?.stack?.branch).find((b) => typeof b === "string") : undefined;
  // #C1018 / #C1035: the first 12 characters of every tip a checker holds a claim on (view.reviewClaims, from the store).
  const claimed12 = new Set((Array.isArray(view?.reviewClaims) ? view.reviewClaims : []).filter((k) => k && typeof k.sha === "string").map((k) => k.sha.slice(0, 12)));
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
    const inBoard = stackOnFor(switchOn, c); // #C1295: the card's own repository's switch is on (the name stays: "in a stack-mode repository")
    // #C914: a card the probe marks stackHold (pushed, no stack-ready signal covers its head) has no review turn, and is no builder turn either.
    // #C1066 (11-12 and 11-16: a WIP start push, even an empty one, woke Checker and Security on every re-arm): in a stack-mode repository a pushed tip
    // is Building until the builder's stack-ready signal covers it, with or without a declared partner; a second push after the signal is a new tip and
    // waits for its own. The signal is the READY, so only a covered tip (the probe clears stackHold) goes to the review lanes.
    const held = inBoard && e?.stackHold === true;
    const turns = turnsOf(c, e, { ...(inBoard ? { stackOn: true, stackBranch: stackBranchFor(c) } : {}), ...(pairCovers ? { pairCovers } : {}), ...(landing ? { landing } : {}), ...(reviewerFor(c, reviewers, roster) ? { reviewer: reviewerFor(c, reviewers, roster) } : {}) });
    // #C1018 / #C1035: a tip a Checker session has claimed (the store's review claim) wakes no Checker for its review again: one checker per tip.
    // #C1139: a tip whose newest commit says WIP (the probe's wipHead) is a start push, not a READY: no review turn for it, in any repository and with the stack switch on or off.
    const mine = held || e?.wipHead === true ? turns.filter((t) => t.step !== "review") : turns;
    const shown = mine.filter((t) => !(CHECKER_NAME.test(String(t.role)) && t.step === "review" && claimed12.has(String(t.fullSha ?? t.sha ?? "").slice(0, 12))));
    cards.push({ group: batchOf(c), groupStarted: startedGroups.has(batchOf(c)), rework: shown.some((t) => t.role === c.owner_role && (t.step === "rework" || t.step === "reason")), queuePos: Number.isInteger(c.queue_pos) && c.queue_pos >= 1 ? c.queue_pos : null, ownerPlaced: c.queue_set_by === "owner", id: c.id, who: c.owner_role, status: "active", num: Number.isInteger(c.num) ? c.num : null, waitingOn: typeof c.waiting_on === "string" ? c.waiting_on : null, turns: shown, inBoard, stackKey: stackKeyOf(c), inStack: inBoard && e?.stack && e.stack.outside !== true && !held });
  }
  // #C1295: a reviewer is held while a card of the SAME repository still has a build turn; another repository's builder does not hold it.
  const building = new Set(cards.filter((k) => k.inBoard && k.turns.some((t) => BUILD_STEPS.has(t.step))).map((k) => k.stackKey));
  for (const k of cards) if (k.inStack && building.has(k.stackKey)) k.turns = k.turns.filter((t) => t.step !== "review");
  for (const k of cards) { delete k.inBoard; delete k.inStack; delete k.stackKey; }
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
  const decided = openDecisionCards(view, idByNum, lead); // #C1073: a decision open on a thread holds its card as an open ask does
  for (const id of decided) askedCards.add(id);
  const notStarted = (k) => k.turns.some((t) => t.step === "build" && !t.sha) && !askedCards.has(k.id) && !heldFor(k, k.who);
  // The same order as the store's (worker/board-rules.mjs queueRank; a held card was skipped above): at one place a card the owner placed comes
  // before one an agent placed (Checker F1 on ac3d31b), then the card's number.
  // #C1053: first the owner's order of the groups (a card in no group after all of them, a group nobody has placed after the placed ones), then as before.
  const groupOrder = orderListOf(view?.groupOrder, view?.groupNames);
  // The ONE order of an agent's work (worker/board-rules.mjs agentRank, shared with the stall line and the owner's queue move): its rework first, then its
  // cards in a started group (groups are worked whole), then the owner's next group, then queue_pos as before.
  const queueOrder = (x, y) => agentRank({ rework: x.rework, groupStarted: x.groupStarted, group: x.group, queue_pos: x.queuePos, owner: x.ownerPlaced, num: x.num, id: x.id }, { rework: y.rework, groupStarted: y.groupStarted, group: y.group, queue_pos: y.queuePos, owner: y.ownerPlaced, num: y.num, id: y.id }, groupOrder);
  // Rework goes first (the owner's A on 11-12, 8:24 pm): an agent with a card to fix (findings, or a rework reason to attach) that dispatchItems would not drop
  // (no open ask, not waiting on someone else) is woken for it and for no NEW card, whatever group the new card is in.
  const waitsElsewhere = (k) => !!heldFor(k, k.who);
  const reworkWho = new Set(cards.filter((k) => k.rework && !askedCards.has(k.id) && !waitsElsewhere(k)).map((k) => k.who));
  // #C1080 (11-15/16: the dispatch woke Boardsmith three times in the middle of G9, for #C997, #C990 and #C1078, and Manager held each by hand): while a role
  // has a STARTED group that is not yet READY, it is woken to build only that group's cards. A group is not ready for a role while one of the role's cards
  // in it (active: not paused, dropped, done, blocked or live; not waiting on an open ask, on someone else or on an open hold) has nothing pushed, or is
  // pushed with no stack-ready signal covering its head (the probe's stackHold). Only NEW build turns are dropped for a card outside the open group(s):
  // reviews, rework, landing and every other turn are untouched, and with no group open the queue is dispatched as before.
  // Checker 2's F1 on 0c079bf8 (a deadlock): a group card that waits on a dependency is skipped above (waitsOn), so a dependency of the SAME role that sits
  // outside the group, with nothing pushed, must keep its build turn or the group never finishes. So: (a) a group card blocked by another role's card is not
  // the role's to build and keeps no group open; (b) the blockers of a group card that keeps its group open, and theirs in turn, are let through.
  // #C1082: the rule is ONE function (worker/board-rules.mjs openGroupWithheld), called here and by the stall line, so the two cannot name different cards.
  // (Manager's rule (b) is in it: a started group whose unfinished cards all wait on ANOTHER role's cards lets the role take a loose card, never a card of another group.)
  const withheldBy = openGroupWithheld({ now, cards: all, evidenceOf: (id) => ev[`cards.${id}`]?.value, askedCards, endPassed, stackOn: switchOn });
  for (const k of cards) {
    if (withheldBy({ role: k.who, id: k.id, group: k.group })) k.turns = k.turns.filter((t) => !(t.step === "build" && !t.sha));
  }
  const byRole = new Map();
  for (const k of cards.filter(notStarted)) byRole.set(k.who, [...(byRole.get(k.who) ?? []), k]);
  for (const [who, list] of byRole) {
    list.sort(queueOrder);
    for (const k of list.slice(reworkWho.has(who) ? 0 : 1)) k.turns = k.turns.filter((t) => !(t.step === "build" && !t.sha));
  }
  // #C991 (the owner's pick A): a reviewer's queue comes from the store, not from the lead's list. Per role, the cards whose review turn is that
  // role's, in the queue order above; a held card is out (skipped above, or its review turn dropped), and so is one dispatchItems would drop
  // for the role (an open ask, or waiting on someone else). Card numbers only: the DISPATCH line prints them as "your queue: #C.., #C..".
  const queues = {};
  for (const k of [...cards].sort(queueOrder)) {
    if (askedCards.has(k.id) || !Number.isInteger(k.num)) continue;
    for (const role of new Set(k.turns.filter((t) => t.step === "review").map((t) => t.role))) {
      if (typeof role !== "string" || heldFor(k, role)) continue;
      (queues[role] ??= []).push(k.num);
    }
  }
  // #C1068 (the owner, 11-12: "let's build that"): a lane is woken for a group's READY cards as they come when it is free, and ONCE for all of them when it was busy. The
  // dispatch wakes only a free lane, so the first wake of a lane already finds every READY, unreviewed card of the group: when a role has two or more review turns for cards of
  // ONE group (the same queue as above), the first of them in the queue's order keeps the turn and carries the others (number and tip) as one range, and the others lose
  // that role's review turn: the lane is woken once, not once per card. A card without a tip stays on its own. Another role's turn on a card is not touched.
  const togetherOf = new Map(); // `${role}\n${group}` -> the cards in queue order
  for (const k of [...cards].sort(queueOrder)) {
    if (askedCards.has(k.id) || !Number.isInteger(k.num) || !k.group) continue;
    for (const t of k.turns) {
      if (t.step !== "review" || typeof t.role !== "string" || !/^[0-9a-f]{12}$/.test(String(t.sha)) || heldFor(k, t.role)) continue;
      const key = `${t.role}\n${k.group}`;
      togetherOf.set(key, [...(togetherOf.get(key) ?? []), { k, t }]);
    }
  }
  for (const [key, list] of togetherOf) {
    if (list.length < 2) continue;
    const group = key.slice(key.indexOf("\n") + 1);
    list[0].t.together = list.slice(1).map(({ k, t }) => ({ num: k.num, sha: t.sha }));
    list[0].t.group = group;
    for (const { k, t } of list.slice(1)) k.turns = k.turns.filter((u) => u !== t);
  }
  // The cards left out of the lists above (asked, or waiting on someone else) keep their turn, which dispatchItems drops by the same rule.
  for (const k of cards) { delete k.queuePos; delete k.ownerPlaced; delete k.group; delete k.groupStarted; delete k.rework; }
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
  for (const id of decided) asked.add(id);
  return { cards, agents, asked, queues };
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

// #C1105 (11-16: Release sat on a v1.212.4 candidate whose CI had finished green): a ship candidate's CI run that finishes wakes Release once. The
// candidate is the evidence key `ship` ({ version, ci, at }, written every run while a candidate stands, so its readAt trails the heartbeat key `board`
// by no more than SHIP_CI_PAIR_MS while it does and falls behind once there is none). Green: the candidate reads "passed". Red: it was seen and is gone
// while its version is not the live one (a failed or cancelled run drops the candidate, and a merge that went by between two reads looks the same: the
// line says so). A candidate that is gone because its version went live is done silently (Ops's after-ship turn covers it). The turn is a card of its
// own, `shipci-v<x>-<y>-<z>-green|red`; dispatch-state.json keeps `shipci`: { version, ci, at, result?, wokenAt?, done }. As the after-ship turn, it
// holds until Release has worked after it was woken (no longer idle, or idle since after the wake), so it fires once per candidate, and a candidate
// first seen more than SHIP_CI_WINDOW_MS ago is done. A stale heartbeat reads nothing: no wake and no conclusion.
export const SHIP_CI_ROLE = "Release", SHIP_CI_FRESH_MS = 10 * 60e3, SHIP_CI_PAIR_MS = 3 * 60e3, SHIP_CI_WINDOW_MS = 6 * 3600e3;
export const shipCiId = (version, result) => {
  const v = typeof version === "string" ? version.replace(/^v/, "") : "";
  return /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(v) && (result === "green" || result === "red") ? `shipci-v${v.replace(/\./g, "-")}-${result}` : null; // five dash-separated words at most (gate/reset.mjs CARD)
};
// { card: the turn to add or null, shipci: the state to keep }.
export function shipCiDone(view, before, agents, now) {
  const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
  const prev = before && isObj(before.shipci) ? before.shipci : null;
  const ev = view && isObj(view.evidence) ? view.evidence : {};
  const board = isObj(ev.board) ? ev.board : null, ship = isObj(ev.ship) ? ev.ship : null;
  if (!board || !Number.isFinite(board.readAt) || board.readAt > now || now - board.readAt > SHIP_CI_FRESH_MS) return { card: null, shipci: prev };
  const cand = ship && isObj(ship.value) && Number.isFinite(ship.readAt) && board.readAt - ship.readAt <= SHIP_CI_PAIR_MS ? ship.value : null;
  const candVersion = cand && typeof cand.version === "string" && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(cand.version.replace(/^v/, "")) ? cand.version.replace(/^v/, "") : null;
  let cur = prev && typeof prev.version === "string" ? { ...prev } : null;
  if (candVersion) {
    // A candidate is a version at a tip: the same version pushed again (a new tip time, after a red run) is a new candidate and starts over (Checker 2's M1 on e8ff165c).
    const tip = Number.isFinite(cand.at) ? cand.at : null;
    if (!cur || cur.version !== candVersion || (tip !== null && cur.tip !== undefined && cur.tip !== tip)) cur = { version: candVersion, ci: cand.ci, at: now, done: false, ...(tip === null ? {} : { tip }) };
    else { cur.ci = cand.ci; if (tip !== null && cur.tip === undefined) cur.tip = tip; }
    if (!cur.result && cand.ci === "passed") cur.result = "green";
  } else if (cur && !cur.done && !cur.result) {
    const liveV = view?.live?.state === "live" ? String(view.live.version ?? "").replace(/^v/, "") : null;
    if (liveV === cur.version) cur.done = true;
    else cur.result = "red";
  }
  if (!cur) return { card: null, shipci: prev };
  const ag = agents && Object.hasOwn(agents, SHIP_CI_ROLE) ? agents[SHIP_CI_ROLE] : null;
  const idleSince = ag && (Number.isFinite(ag.since) ? ag.since : ag.lastActivityAt);
  if (!cur.done && Number.isFinite(cur.wokenAt) && ag && (ag.state !== "idle" || (Number.isFinite(idleSince) && idleSince > cur.wokenAt))) cur.done = true;
  if (!cur.done && !(Number.isFinite(cur.at) && now - cur.at <= SHIP_CI_WINDOW_MS)) cur.done = true;
  const id = cur.done || !cur.result ? null : shipCiId(cur.version, cur.result);
  if (!id) return { card: null, shipci: cur };
  return { card: { id, who: SHIP_CI_ROLE, status: "active", num: null, waitingOn: null, turns: [{ role: SHIP_CI_ROLE, phase: "ship", step: cur.result === "green" ? "shipcigreen" : "shipcired" }] }, shipci: cur };
}

// #C1007 (Director 11-11: the Ops daily scheduled task was a model run whose whole job was one fixed line to one session): the dispatch wakes Ops
// once a day for its daily check, from DAILY_CHECK_HOUR o'clock MT on, with no card queued and no version shipped. The turn is a card of its own,
// `ops-daily-<yyyy-mm-dd>` (the MT day), so the DISPATCH line names the day. dispatch-state.json keeps `daily`: { date, wokenAt?, done }. As with
// the after-ship turn, it holds until Ops has worked after it was woken (no longer idle, or idle since after the wake), so it fires once per day, and
// a busy Ops is woken when it goes idle. It does not fire before the hour, nor twice in a day; the first run ever wakes Ops once for that day. Steward
// has no turn here: it is woken only by cards queued for it (#C850), so it stays quiet when it has none.
export const DAILY_CHECK_ROLE = "Ops", DAILY_CHECK_HOUR = 7;
export const dailyCheckId = (date) => (/^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? `ops-daily-${date}` : null);
// { card: the turn to add or null, daily: the state to keep }.
export function dailyCheck(before, agents, now) {
  const prev = before && typeof before.daily === "object" && before.daily && !Array.isArray(before.daily) ? before.daily : null;
  const date = mtDate(now), hour = mtHour(now), id = dailyCheckId(date);
  if (!(hour >= DAILY_CHECK_HOUR)) return { card: null, daily: prev };
  let daily = prev?.date === date ? { ...prev } : { date, done: false };
  const ag = agents && Object.hasOwn(agents, DAILY_CHECK_ROLE) ? agents[DAILY_CHECK_ROLE] : null;
  const idleSince = ag && (Number.isFinite(ag.since) ? ag.since : ag.lastActivityAt);
  if (Number.isFinite(daily.wokenAt) && ag && (ag.state !== "idle" || (Number.isFinite(idleSince) && idleSince > daily.wokenAt))) daily.done = true;
  if (daily.done) return { card: null, daily };
  return { card: { id, who: DAILY_CHECK_ROLE, status: "active", num: null, waitingOn: null, turns: [{ role: DAILY_CHECK_ROLE, phase: "live", step: "dailycheck" }] }, daily };
}

// #C1090 (Manager, 11-16: "so it wakes you rather than sitting in a log nobody reads"): while the landing job's fresh report says 5 or more DATA fragments wait
// on main (foldDue), Boardsmith is woken once a day (the MT day) to cut the fold card. As the daily check: the turn is a card of its own, `fold-due-<yyyy-mm-dd>`,
// dispatch-state.json keeps `fold`: { date, wokenAt?, done }, and it holds until Boardsmith has worked after it was woken (no longer idle, or idle since after the
// wake). When the report no longer says foldDue (the fold landed, or the report is stale) the state is dropped, so the next time it falls due it wakes again.
export const FOLD_DUE_ROLE = "Boardsmith";
export const foldDueId = (date) => (/^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? `fold-due-${date}` : null);
// { card: the turn to add or null, fold: the state to keep or null }.
export function foldDueCheck(landing, before, agents, now) {
  if (!landing || landing.foldDue !== true) return { card: null, fold: null };
  const prev = before && typeof before.fold === "object" && before.fold && !Array.isArray(before.fold) ? before.fold : null;
  const date = mtDate(now), id = foldDueId(date);
  if (!id) return { card: null, fold: null };
  const fold = prev?.date === date ? { ...prev } : { date, done: false };
  const ag = agents && Object.hasOwn(agents, FOLD_DUE_ROLE) ? agents[FOLD_DUE_ROLE] : null;
  const idleSince = ag && (Number.isFinite(ag.since) ? ag.since : ag.lastActivityAt);
  if (Number.isFinite(fold.wokenAt) && ag && (ag.state !== "idle" || (Number.isFinite(idleSince) && idleSince > fold.wokenAt))) fold.done = true;
  if (fold.done) return { card: null, fold };
  return { card: { id, who: FOLD_DUE_ROLE, status: "active", num: null, waitingOn: null, turns: [{ role: FOLD_DUE_ROLE, phase: "live", step: "folddue" }] }, fold };
}

// #C1097 (11-16: three signed cards sat with Boardsmith and #C1095 with Release for hours; the stalls were in Manager's inbox and nothing woke the agents): an
// idle-agent stall (the store's view.agentStalls, each with the time the store first raised it) that is STALL_WAKE_AFTER_MS old is a turn for the stalled role,
// as a pair or a post turn is: the card is a pseudo-card `stall-<num>-<hash of the reason>`, so the watch's seen file prints its line once, and a stall whose reason
// changes is a new card and fires again. The stall still goes to Manager's inbox as before (the store). The lead gets no such line (its own wake is the inbox).
const fnv = (s) => { let h = 0x811c9dc5; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };
export function agentStallCards(view, now, lead = "Manager") {
  const out = [];
  for (const s of Array.isArray(view?.agentStalls) ? view.agentStalls : []) {
    if (!s || typeof s.role !== "string" || s.role === lead || typeof s.reason !== "string" || !Number.isFinite(s.at) || s.at > now + 5_000 || now - s.at < STALL_WAKE_AFTER_MS) continue;
    const num = (Array.isArray(view?.cards) ? view.cards : []).find((c) => c && c.id === s.card_id)?.num;
    if (!Number.isInteger(num)) continue;
    out.push({ id: `stall-${num}-${fnv(`${s.role}|${s.reason}`)}`, who: s.role, status: "active", num, waitingOn: null, turns: [{ role: s.role, phase: "stall", step: "stall" }] });
  }
  return out;
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

// #C967: <dir>/land-holds.json { at, cards: { <card id>: "" | "paused" | "dropped" | "blocked" | "asked" | "waiting_on" | "group" } }, what the landing job
// (scripts/board-land.mjs) reads to tell a card held from a card free to land. One entry per card the store knows ("" = no hold), plain words
// only (never a reason text), by the same atomic writer. A card the file does not list is unknown to the job, which then lands nothing for it.
export const LAND_HOLDS_FILE = "land-holds.json", LAND_HOLDS_MAX = 2000;
// Checker 2 on 98cefa1: (F1) an open ask on a card (not closed, not answered, not withdrawn) is the owner's or the lead's to settle, so it holds the
// card ("asked"); an install (Terminal) ask from an earlier landing of the same card holds a v2 too, the safe side until the owner says otherwise.
// (F2) `waiting_on` is the lead's routine "next is" pointer ("Checker: PASS at ...", "Release"): one that starts with a review or landing role is no
// hold, since after Checker and Security sign the landing is the very next step; any other (the owner, Manager, another builder) still is.
export const LANDING_ROLES = /^\s*(?:Checker|Security|Release)\b/i;
// #C1119 (11-16, 5:35 pm: the land job landed #C863 alone the moment it was signed, with G17 mostly unbuilt; the only stop was a hand-written waiting_on on each
// signed card): a card in a group is held ("group") while any other card of its group is open and not yet signed. A member is open unless it is dropped or
// closed (done_at), and signed once its reading is at ship (every review signed) or live; a card with no reading yet (nothing pushed) is not signed. A card
// with no group is untouched. The word is checked last, so a card's own hold (dropped, paused, blocked, asked, waiting_on) still names itself.
const signedOrLanded = (e) => { const p = e?.phase ?? e?.lit?.[0]; return p === "ship" || p === "live"; };
// #C1138: a member that has landed: its reading is live, or its commit is on main (a card at ship with onMain true waits only for its pack).
const landedOnMain = (e) => (e?.phase ?? e?.lit?.[0]) === "live" || e?.onMain === true;
export function landHoldsFile(view, now) {
  const cards = {};
  const asked = new Set();
  for (const a of Array.isArray(view?.asks) ? view.asks : []) if (a && typeof a.card_id === "string" && a.closed_at == null && a.answered_at == null && a.withdrawn_at == null) asked.add(a.card_id);
  const all = (Array.isArray(view?.cards) ? view.cards : []).filter((c) => c && typeof c.id === "string" && CARD_ID.test(c.id));
  const ev = view && typeof view.evidence === "object" && view.evidence !== null && !Array.isArray(view.evidence) ? view.evidence : {};
  // The groups that have an open member not yet signed: group word -> how many.
  const open = (c) => !c.dropped && c.done_at == null; // a member still to land: not dropped, not closed
  const waits = (c) => open(c) && !signedOrLanded(ev[`cards.${c.id}`]?.value); // ... and not yet signed
  const unsigned = new Map();
  for (const c of all) { const g = batchOf(c); if (g && waits(c)) unsigned.set(g, (unsigned.get(g) ?? 0) + 1); }
  for (const c of all) {
    if (Object.keys(cards).length >= LAND_HOLDS_MAX) continue;
    const has = (v) => typeof v === "string" && v.trim() !== "";
    const g = batchOf(c), others = g ? (unsigned.get(g) ?? 0) - (waits(c) ? 1 : 0) : 0; // the unsigned members of its group besides itself
    cards[c.id] = c.dropped ? "dropped" : c.paused ? "paused" : has(c.blocked_reason) ? "blocked" : asked.has(c.id) ? "asked" : has(c.waiting_on) && !LANDING_ROLES.test(c.waiting_on) ? "waiting_on" : others > 0 ? "group" : "";
  }
  // #C1138 (11-16 late: the land job landed #C1126 alone at 32438ae1, with G10's group head not built): signed members of one group are each free to land on their own once every member
  // is signed, so the first tip the job tried went out alone and the group head no longer continued main. `groups` lists, for each card of a group, the OTHER members still to land
  // (open, and not on main or live): the job lands a tip only when it carries every one of them (board-land.mjs landPlan), that is, only the group's head. A card with no group, or
  // no other member to land, is not listed. Plain card ids only.
  // #C1144 (Checker 2's LOW on #C1138): a member of ANOTHER repository has no commit here, so no head of this repository could ever carry it and the group would never land (it failed closed;
  // Release landed it by hand): it is no peer. Security's M1 (cf4eb085): the repo word is not reliable (null until the probe fills it at the first push; one repository has the words
  // ''/null, 'board' and 'flight-board', as BOARD_REPO_WORDS and the dispatch's reviewer key read them), so a peer is dropped only when BOTH cards name a repository (a non-empty word) and the two
  // words, with every board word read as 'flight-board', differ. A card with no word yet, or a word that is not a string, is unknown and stays a peer: it fails closed (the lone tip waits).
  const toLand = (c) => open(c) && !landedOnMain(ev[`cards.${c.id}`]?.value);
  // #C1145: the words are compared as one repository's names, not as typed: case, spaces, an `<owner>/` front and a `.git` end do not make another repository ("Flight-Board", "aponsin/flight-board"
  // and "flight-board.git" are the board's), so a spelling difference never drops a peer and lets a lone tip land. A card with NO commit yet is no different: it is still a member to land
  // (toLand reads no commit, only that the card is open and not on main), and its word, if it has none yet, is unknown and keeps it a peer.
  const repoOf = new Map(all.map((c) => { const w = repoKey(c.repo); return [c.id, w === "" ? "" : BOARD_REPO_WORDS.has(w) ? "flight-board" : w]; }));
  const sameRepo = (a, b) => { const x = repoOf.get(a), y = repoOf.get(b); return x === "" || y === "" || x === y; };
  const members = new Map();
  for (const c of all) { const g = batchOf(c); if (g && toLand(c)) members.set(g, [...(members.get(g) ?? []), c.id]); }
  const groups = {};
  for (const c of all) {
    const g = batchOf(c), peers = g && toLand(c) ? (members.get(g) ?? []).filter((id) => id !== c.id && sameRepo(id, c.id)) : [];
    if (peers.length && Object.keys(groups).length < LAND_HOLDS_MAX) groups[c.id] = peers;
  }
  return { at: now, cards, groups };
}
export function writeLandHolds(view, { dir, now = Date.now() }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(join(dir, LAND_HOLDS_FILE), JSON.stringify(landHoldsFile(view, now)));
}

// One run over a view. Returns { wrote, why?, items }. `dir` is <stateDir>/<board>.
export function dispatchRun(view, { dir, roster, lead, ceiling = QUOTA_CEILING_DEFAULT, now = Date.now(), log = () => {}, pairCovers = null, reviewers = null }) {
  const landing = landingFrom(readJson(join(dir, LAND_REPORT_FILE)), now);
  // #C1098: an entry whose role is not on the roster is ignored (the reviewer would never be woken), and the log says so.
  for (const [repo, role] of Object.entries(reviewers && typeof reviewers === "object" && !Array.isArray(reviewers) ? reviewers : {})) if (!Array.isArray(roster) || !roster.includes(role)) log(`dispatch: warning: collector.reviewers names ${String(role).replace(/[^A-Za-z0-9 _-]/g, "")} for ${String(repo).replace(/[^A-Za-z0-9._-]/g, "")}, which is not on the roster: that repository's checker reviews go to the phase's own lane`);
  const input = dispatchInput(view, now, { lead, ceiling, pairCovers, landing, reviewers, roster });
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
  const daily = dailyCheck(state, input.agents, now);
  const fold = foldDueCheck(landing, state, input.agents, now);
  const shipci = shipCiDone(view, state, input.agents, now);
  const r = dispatchItems({ cards: [...input.cards, ...(ship.card ? [ship.card] : []), ...(daily.card ? [daily.card] : []), ...(fold.card ? [fold.card] : []), ...(shipci.card ? [shipci.card] : []), ...agentStallCards(view, now, lead)], agents: input.agents, asked: input.asked, queues: input.queues, roster, lead, now, before: state });
  const shipCiKept = shipci.shipci && shipci.card && r.items.some((i) => i.card === shipci.card.id) && !Number.isFinite(shipci.shipci.wokenAt) ? { ...shipci.shipci, wokenAt: now } : shipci.shipci;
  const live = ship.card && r.items.some((i) => i.card === ship.card.id) && !Number.isFinite(ship.live.wokenAt) ? { ...ship.live, wokenAt: now } : ship.live;
  const day = daily.card && r.items.some((i) => i.card === daily.card.id) && !Number.isFinite(daily.daily.wokenAt) ? { ...daily.daily, wokenAt: now } : daily.daily;
  const folded = fold.card && r.items.some((i) => i.card === fold.card.id) && !Number.isFinite(fold.fold.wokenAt) ? { ...fold.fold, wokenAt: now } : fold.fold;
  writeAtomic(join(dir, DISPATCH_FILE), JSON.stringify({ at: now, source: "store", items: r.items }));
  writeAtomic(join(dir, DISPATCH_STATE_FILE), JSON.stringify({ ...r.state, ...(live ? { live } : {}), ...(day ? { daily: day } : {}), ...(folded ? { fold: folded } : {}), ...(shipCiKept ? { shipci: shipCiKept } : {}) }));
  // #C940: the roles' states in the log, so a minute with nothing dispatched can be told from a blind or missing session (role names and one word each).
  log(`dispatch: agents ${(Array.isArray(roster) ? roster : []).filter((x) => typeof x === "string" && /^[A-Za-z][A-Za-z0-9 _-]{0,40}$/.test(x)).map((x) => `${x}=${input.agents[x] ? String(input.agents[x].state).replace(/[^a-z]/g, "") || "?" : "none"}`).join(" ")}`);
  log(`dispatch: ${r.items.length} item(s)`);
  return { wrote: true, items: r.items };
}
