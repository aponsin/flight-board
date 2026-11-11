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

// #C850 (dispatch by phase): whose turn it is on a card, and for what, from the card's evidence. The lanes are whoForPhase's
// (worker/board-rules.mjs PHASE_LANES; a test pins that they are the same). [{ role, phase, step, sha?, signed? }]:
//   no phase or build        the owner builds and pushes (the push is the READY)
//   language, design         the lane's agent reviews the pushed commit
//   checker, security        the lane's agent reviews; with review level Full, Security too while its note is missing
//   ship, not on main        Release lands it (the notes on that exact commit, a clean dry run, the owner's standing go)
//   ship, on main, repo word the owner builds the deploy pair (the board's own repository: landed, not deployed)
//   live, or on main with no repo word: nobody (the lead closes it)
export const PHASE_LANES = { language: "Linguist", design: "Designer", checker: "Checker", security: "Security", ship: "Release" };
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
  const owner = { role: card.owner_role, phase: "build", step: "build", ...(branch ? { stack: branch } : {}) };
  if (stack?.outside === true && e?.onMain !== true) return [{ role: card.owner_role, phase: "build", step: "outside", ...(branch ? { stack: branch } : {}) }];
  if (typeof phase !== "string" || phase === "plan" || phase === "build") return [owner];
  // #C852: a review whose note on this commit starts FINDINGS has sent it back: the fix is the owner's turn, and no reviewer is woken to
  // look at a commit already rejected. It is a fact of this sha (evidence.findings), so a new commit clears it without anyone's step.
  const findings = (Array.isArray(e?.findings) ? e.findings : []).filter((s) => typeof s === "string" && Object.hasOwn(ROLE_OF_NOTE, s));
  if (findings.length && Object.hasOwn(ROLE_OF_NOTE, phase)) return [{ role: card.owner_role, phase: "build", step: "rework", sha, ...where, signed: signedBy, ...(branch ? { stack: branch } : {}) }];
  if (phase === "ship") {
    if (e.onMain === true) return typeof card.repo === "string" && card.repo !== "" ? [{ role: card.owner_role, phase: "ship", step: "pair", sha, ...where, signed: signedBy }] : [];
    // #C854: signed but no longer continuing main: Release cannot take it. The turn is the owner's, to re-cut it on main (a new commit has a new sha, so a reviewer is woken again).
    if (e.behindMain === true) return [{ role: card.owner_role, phase: "ship", step: "recut", sha, ...where, signed: signedBy, ...(branch ? { stack: branch } : {}) }];
    return [{ role: PHASE_LANES.ship, phase: "ship", step: "land", sha, ...where, signed: signedBy }];
  }
  if (!Object.hasOwn(PHASE_LANES, phase)) return [owner];
  const out = [];
  if (!signed.includes(phase)) out.push({ role: PHASE_LANES[phase], phase, step: "review", sha, ...where, signed: signedBy });
  if (phase === "checker" && card.review_level === "Full" && !signed.includes("security")) out.push({ role: "Security", phase, step: "review", sha, ...where, signed: signedBy });
  return out;
}

// The store's view -> { cards, agents, asked } in the shapes dispatchItems reads, or null when the view cannot say who is idle.
export function dispatchInput(view, now) {
  const ev = view?.evidence ?? {};
  const agents = ev.agents?.value;
  const readAt = ev.agents?.readAt;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return null;
  if (!Number.isFinite(readAt) || now - readAt > AGENTS_FRESH_MS || readAt > now + 5_000) return null;
  const cards = [];
  const all = Array.isArray(view?.cards) ? view.cards : [];
  const phaseOf = (id) => { const e = ev[`cards.${id}`]?.value; return e?.phase ?? e?.lit?.[0]; };
  // #C845: a card waits for the cards it depends on (depends_on, a JSON list of ids) until each is live. A dependency the board doesn't
  // have, or one that was dropped, holds nothing (as the gate's dependsOnErrors reads it).
  const open = new Map(all.filter((k) => k && typeof k.id === "string" && !k.dropped && !k.done_at).map((k) => [k.id, k]));
  const waitsOn = (c) => {
    let list = c.depends_on;
    if (typeof list === "string") { try { list = JSON.parse(list); } catch { return []; } }
    return Array.isArray(list) ? list.filter((d) => typeof d === "string" && d !== c.id && open.has(d) && phaseOf(d) !== "live") : [];
  };
  // #C859 slice 3 (stack mode): the board repository's switch is on (a card with no repo word, or "flight-board", is the board's). The stack's
  // branch is the one the evidence names on any of its cards; a builder's turn carries it, and a reviewer is not woken for a card in the stack
  // while a card of the same repository still has a build turn (design 3: Checker and Security are woken once, when no builder has a card queued).
  const switchOn = (Array.isArray(view?.stackSwitch) ? view.stackSwitch : []).some((s) => s && s.repo === "board" && (s.stack === true || s.stack === 1));
  const boardCard = (c) => !c.repo || c.repo === "flight-board";
  const stackBranch = switchOn ? all.filter((c) => c && typeof c.id === "string" && boardCard(c)).map((c) => ev[`cards.${c.id}`]?.value?.stack?.branch).find((b) => typeof b === "string") : undefined;
  const BUILD_STEPS = new Set(["build", "rework", "outside"]);
  for (const c of all) {
    if (!c || typeof c.id !== "string" || !CARD_ID.test(c.id) || typeof c.owner_role !== "string") continue;
    if (waitsOn(c).length) continue;
    // Active: not paused, not dropped, not blocked (a blocked card is "blocked" on the old shape and the store's stall rule skips it), and
    // not already live (a live card waits for the lead to close it, not for its owner). The phase is read as compat-view reads it.
    if (c.paused || c.dropped || c.done_at || c.blocked_reason) continue; // #C902: a card closed as done is never dispatched
    const e = ev[`cards.${c.id}`]?.value;
    if ((e?.phase ?? e?.lit?.[0]) === "live") continue;
    // #C850: a hold with an end (a card the lead put on hold) is skipped; the stall rule brings it back when the hold ends.
    if (c.hold_end) continue;
    const inBoard = switchOn && boardCard(c);
    cards.push({ queuePos: Number.isInteger(c.queue_pos) && c.queue_pos >= 1 ? c.queue_pos : null, ownerPlaced: c.queue_set_by === "owner", id: c.id, who: c.owner_role, status: "active", num: Number.isInteger(c.num) ? c.num : null, waitingOn: typeof c.waiting_on === "string" ? c.waiting_on : null, turns: turnsOf(c, e, inBoard ? { stackOn: true, stackBranch } : {}), inBoard, inStack: inBoard && e?.stack && e.stack.outside !== true });
  }
  if (switchOn && cards.some((k) => k.inBoard && k.turns.some((t) => BUILD_STEPS.has(t.step)))) {
    for (const k of cards) if (k.inStack) k.turns = k.turns.filter((t) => t.step !== "review");
  }
  for (const k of cards) { delete k.inBoard; delete k.inStack; }
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

// One run over a view. Returns { wrote, why?, items }. `dir` is <stateDir>/<board>.
export function dispatchRun(view, { dir, roster, lead, now = Date.now(), log = () => {} }) {
  const input = dispatchInput(view, now);
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
  log(`dispatch: ${r.items.length} item(s)`);
  return { wrote: true, items: r.items };
}
