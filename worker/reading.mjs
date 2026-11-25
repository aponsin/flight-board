// #C1380 step 1 (the owner's pick A on #T2194; the contract is docs/DATA.d/one-reading-module.md): the ONE place that says where a card is.
// `reading(card, evidence, claims, agents, config, now, ctx)` is pure: the card's row, the probe's evidence value for it (cards.<id>), the review claims,
// the agents' reading, the config and the time go in; { phase, state, wait, with, working, since, asOf, why } come out. Step 1 adds the module, its
// fixtures and its laws; no view calls it yet (the Worker, the dispatch, the page and the crew panel move to it in steps 2 and 3).
// It imports only worker/ files (the Worker bundle holds nothing of the collector).
import { isRework, reworkKind, holdOpen, repoKey, repoKind, reviewerOf, PHASE_LANES } from "./board-rules.mjs";
import { groupWaitsFor } from "./group-rule.mjs";

// #C1385 (the gates read this module): the shared readings the dispatch and the stall lines used to keep copies of. ONE lane table (board-rules' PHASE_LANES, phase -> role), the review lanes
// of it (the phases a lane's agent reviews, and ship, which Release lands) as a table of their own, and `isReviewLane`; `isRework` and `reworkKind` (the dispatch's two kinds of rework) and
// `reworkKind` (the one rework rule, worker/group-rule.mjs) re-exported so every reader names this module for them.
export { isRework, reworkKind, PHASE_LANES };
export const REVIEW_LANES = Object.freeze(Object.fromEntries(["language", "design", "checker", "security", "ship"].map((p) => [p, PHASE_LANES[p]])));
export const isReviewLane = (phase) => typeof phase === "string" && Object.hasOwn(REVIEW_LANES, phase);

// The phases a group row's strip draws, in order (the card row's tiles), and the tile a card has at each (#C1381). A tile is chosen from `state` and `wait` only
// (the contract's "Tile looks"); "future" is a phase the card has not reached and "done" one it has passed.
export const STRIP = ["build", "test", "language", "design", "checker", "security", "ship", "pack", "install", "live"];
// The rule of #C1343, written once and over readings, never over drawn tiles: when a group's cards differ at a phase the group takes the first tile in this order
// that any card has: stuck, working, unknown, a decision asked of the owner, a wait on someone, queued, not reached, a card that has done all it can (pack, install, deploy), done.
export const TILE_ORDER = ["stuck", "working", "unknown", "ask", "wait", "queued", "future", "afterwork", "done"];
export function tileOf(r) {
  if (!r) return "future";
  if (r.state === "done") return "done";
  if (r.overlay) return "wait"; // Paused and Blocked stay overlays (#C1383): yellow, still, whatever the reading under them says
  if (r.state === "stuck" || r.state === "working" || r.state === "unknown" || r.state === "queued") return r.state;
  if (r.working && r.state === "rework") return "working";
  if (r.wait === "ask") return "ask";
  if (r.wait === "pack" || r.wait === "install" || r.wait === "deploy") return "afterwork";
  return "wait"; // turn, group, land, hold, and a card sent back (it waits for its owner)
}
export function tileAt(r, phase) {
  if (r?.state === "done") return "done";
  const here = STRIP.indexOf(r?.phase), at = STRIP.indexOf(phase);
  if (here < 0 || at < 0) return phase === r?.phase ? tileOf(r) : "future";
  return at < here ? "done" : at === here ? tileOf(r) : "future";
}
const rank = (tile) => TILE_ORDER.indexOf(tile);
// A group's row: per phase the cards' tile when they agree, else the first tile in TILE_ORDER that any card has; its count is members done of members; its phase is the
// least-finished card's. Only the members' readings go in. `readings` is the members' [{ id, phase, state, wait, working, ... }].
// #C1417 (board-roll-1's Checker tile stayed orange for a card closed days ago still read "sent back" at checker): a card the store closed is a done member of its group, whatever its last
// reading says, so it never holds a tile, the phase or the lead; it still counts in `count` and `done`.
export function groupReading(readings) {
  const rs = (readings ?? []).filter(Boolean).map((r) => (r.closed === true && r.state !== "done" ? { ...r, state: "done" } : r));
  const tiles = Object.fromEntries(STRIP.map((p) => [p, rs.length ? rs.map((r) => tileAt(r, p)).sort((a, b) => rank(a) - rank(b))[0] : "future"]));
  const open = rs.filter((r) => r.state !== "done");
  const furthest = (r) => STRIP.indexOf(r.phase);
  const phase = open.length ? open.slice().sort((a, b) => furthest(a) - furthest(b))[0].phase : rs.length ? "live" : null;
  const lead = rs.slice().sort((a, b) => rank(tileOf(a)) - rank(tileOf(b)))[0];
  return { count: rs.length, done: rs.length - open.length, phase, state: lead ? lead.state : null, tile: lead ? tileOf(lead) : null, tiles };
}
// "Who is on what": every open card is in exactly one column, the one of the role it is `with` now (a built card waiting for its review sits under the reviewer);
// number 1 goes to the card a session is on, then the rest in order; a badge blinks only when `working` is true (a stale reading never is). Done cards are in no column.
export function crewColumns(readings) {
  const columns = {};
  for (const r of (readings ?? []).filter((x) => x && x.state !== "done" && x.closed !== true && typeof x.with === "string")) (columns[r.with] ??= []).push(r);
  const out = {};
  for (const [role, list] of Object.entries(columns)) {
    list.sort((a, b) => (b.working === true) - (a.working === true) || (a.num ?? 0) - (b.num ?? 0) || (a.id < b.id ? -1 : 1));
    out[role] = list.map((r, i) => ({ n: i + 1, id: r.id, ...(Number.isInteger(r.num) ? { num: r.num } : {}), state: r.state, wait: r.wait, working: r.working === true, ...(r.stale ? { stale: true } : {}), ...(Number.isFinite(r.staleSince) ? { staleSince: r.staleSince } : {}) }));
  }
  return out;
}

export const STATES = ["done", "unknown", "rework", "working", "waiting", "stuck", "queued"];
export const WAITS = ["turn", "group", "land", "pack", "install", "deploy", "ask", "hold"];
// The phases a reviewer holds, and the work phases the card's owner holds.
const REVIEW = ["language", "design", "checker", "security"];
// #C1387: the unread sources (collector/state-schema.mjs UNREAD_SOURCES) a card's phase rests on: a failed read of one makes the card `unknown` with a why naming it. Others (start, behind) set a flag only.
// #C1395: notes (the sign-offs: a review phase rests on them), install (the install wait) and pair (the pack and install waits) join them; ci is not here: it is the ship tile's own word, never a card's state.
const UNKNOWN_BY = ["main", "deploy", "version", "stack", "notes", "install", "pair"];
const UNREAD_WORDS = { main: "main", deploy: "the live deploy", version: "the live version", stack: "the stack", notes: "the sign-offs", install: "the install state", pair: "the deploy pairs" };
const OWNER_PHASES = ["plan", "build", "test"];
export const TIP_FUTURE_MS = 5 * 60e3; // #C1399: how far past now a tip's own date may be before it is ignored (clock skew between machines, not a setting)
export const STUCK_TIMES = 2; // over twice the phase's median (the Tile states line: "slow N× usual")

// What kind of repository the card lives in, from the config's list ({ name, kind } rows: board or product). A word the list does not know is null (reads unknown).
// With no list in the config (the Worker has none yet, #C1380 step 2) the word lists of board-rules answer, as they do today.
export function kindOf(card, config) {
  const list = config?.repos;
  if (!Array.isArray(list)) return repoKind(card?.repo);
  const word = repoKey(card?.repo);
  const row = list.find((r) => r && repoKey(r.name) === word);
  return row && (row.kind === "board" || row.kind === "product") ? row.kind : null;
}

// A card's branch records (the page's liveBranches, #C621, moved here): each tip read on its own, an odd one skipped (name an id word, phase a word, at most 6, no repeated name); fewer than two good ones is none.
const BRANCH_WORD = /^[a-z0-9]{1,16}(?:-[a-z0-9]{1,16}){0,4}$/, PHASE_WORD = /^[a-z][a-z0-9-]{0,23}$/;
export function branchReadings(list) {
  if (!Array.isArray(list)) return [];
  const names = new Set(), out = [];
  for (const b of list.slice(0, 6)) {
    if (!b || typeof b !== "object" || typeof b.name !== "string" || !BRANCH_WORD.test(b.name) || names.has(b.name) || typeof b.phase !== "string" || !PHASE_WORD.test(b.phase) || typeof b.headSha12 !== "string" || !/^[0-9a-f]{12}$/.test(b.headSha12)) continue;
    names.add(b.name);
    const reached = Array.isArray(b.seen) ? b.seen.filter((k) => typeof k === "string" && PHASE_WORD.test(k)) : [];
    out.push({ name: b.name, phase: b.phase, landed: b.onMain === true, reached, live: reached.includes("live") });
  }
  return out.length > 1 ? out : [];
}

const pushed = (e) => !!e && typeof e === "object" && (typeof e.headSha === "string" || typeof e.headSha12 === "string");
// #C1427: a session on several cards (the probe's `cards`, two or more, `card` the newest) is on each of them; a session on one has `card` alone.
const onCard = (a, cardId) => a.card === cardId || (Array.isArray(a.cards) && a.cards.includes(cardId));
const isWorking = (agents, role, cardId) => !!role && agents?.[role]?.state === "working" && onCard(agents[role], cardId);
const busyElsewhere = (agents, role, cardId) => !!role && agents?.[role]?.state === "working" && !!agents[role].card && !onCard(agents[role], cardId);

// `with`: one role. The card's owner at plan, build, test and rework; at a review phase the role that holds the open claim on the tip, else the repository's reviewer
// from the config (#C1100), else the lane's role; the release role at land, ship and the live read; the owner of the board at install and ask.
export function withOf(card, e, phase, wait, state, claims, config) {
  if (wait === "install" || wait === "ask") return config?.owner ?? "owner";
  if (state === "rework" || OWNER_PHASES.includes(phase) || !phase) return card?.owner_role ?? null;
  if (REVIEW.includes(phase)) {
    // #C1406: at the checker phase a reviewer's open claim on the card holds it, on the current tip first, else on an older one (the claim is the reviewer's, not the tip's): the crew row never reads that
    // reviewer idle. At the other review phases only a claim on the current tip counts: a Checker claim left open on an older tip does not make language, design or security read "with Checker 2" (Checker 2's F1).
    const open = (claims ?? []).filter((c) => c && !c.released_at && c.card_id === card?.id);
    const onTip = open.find((c) => typeof e?.headSha === "string" && c.sha === e.headSha);
    const claim = phase === "checker" ? onTip ?? open[0] : onTip;
    if (claim?.checker) return claim.checker;
    return (phase === "checker" ? reviewerOf(card, config?.reviewers) : undefined) ?? PHASE_LANES[phase] ?? null;
  }
  return PHASE_LANES[phase] ?? config?.release ?? "Release";
}

// The wait that explains a card standing still, or null. First that holds wins (the contract's order): an open ask, a hold with an end, a groupmate not built, a landing, a pack or install
// (a board repository only), a deploy (a product repository: its commit is on main and the deploy that carries it is not green yet), the phase's role busy on another card.
export function waitOf({ card, e, phase, kind, now, claims, agents, config, ctx }) {
  const asks = (ctx?.asks ?? []).filter((a) => a && (a.card_id === card.id || a.card === card.id));
  if (asks.length) return { kind: "ask", ask: asks[0].num ?? null };
  if (holdOpen(card, now, ctx?.endsPassed ?? new Set())) return { kind: "hold" };
  const gw = groupWaitsFor(card, e, ctx?.cards, ctx?.evidence);
  if (gw.length) return { kind: "group", for: gw };
  if (phase === "ship" || phase === "pack" || phase === "install") {
    if (e?.onMain !== true) return e?.signed?.length ? { kind: "land" } : null;
    if (kind === "board" && e?.noInstall !== true) return e?.packed !== true ? { kind: "pack" } : e?.installed !== true ? { kind: "install" } : null;
    return { kind: "deploy" };
  }
  if (REVIEW.includes(phase)) {
    const role = withOf(card, e, phase, null, "waiting", claims, config);
    if (busyElsewhere(agents, role, card.id)) return { kind: "turn" };
  }
  return null;
}

export function reading(card, evidence, claims, agents, config, now, ctx = {}) {
  const e = evidence && typeof evidence === "object" ? evidence : null;
  const kind = kindOf(card, config);
  const phase = e?.phase ?? e?.lit?.[0] ?? "build";
  const stale = e?.stale === true, staleSince = stale && Number.isFinite(e.staleSince) ? e.staleSince : null;
  const asOf = stale ? staleSince : Number.isFinite(e?.at) ? e.at : null;
  const out = (state, wait, why, extra = {}) => {
    const w = wait ? wait.kind : null, who = withOf(card, e, phase, w, state, claims, config);
    const r = { phase, state, wait: w, with: who, working: false, since: ctx.phaseStart?.get?.(`${card?.id}|${phase}`) ?? (Number.isFinite(e?.readyAt) && REVIEW.includes(phase) ? e.readyAt : null), asOf, why, ...extra };
    if (wait?.ask != null) r.ask = wait.ask;
    // #C1388: the version a live card went out in ("1.226.10") as a plain fact, null otherwise; the Live tile of a product card names it.
    r.version = typeof e?.liveVersion === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(e.liveVersion) && e.phase === "live" ? e.liveVersion : null;
    // #C1388: the cards a `group` wait is for, [{ id, num }] (the page words it "Waiting for #C1357"), so it never reads the group's evidence.
    if (wait?.for) r.waitsFor = wait.for;
    // #C1388: `building`, true while the card's work is in progress: a session is on it, or it has a push of its own that is not on main yet (a card on main waits for pack, install or deploy, not "building").
    r.building = state === "working" || (pushed(e) && e.onMain !== true && ["waiting", "rework", "stuck"].includes(state));
    // #C1388: a card with two or more branches carries one reading per branch, the card row draws a track for each; `live` is the Pack and Install tiles' only light, `reached` the phases that branch shows evidence of, `landed` its tip on main.
    const bs = branchReadings(e?.branches);
    if (bs.length) r.branches = bs;
    // #C1382: the pack's number as a plain fact ("pc111"), only for a board card at the pack or install wait; null when there is none, so the page never reads the evidence for it.
    r.pack = kind === "board" && (w === "pack" || w === "install") && Number.isInteger(e?.pack) && e.pack > 0 && e.pack < 1e6 ? `pc${e.pack}` : null;
    if (kind === null || kind) r.kind = kind;
    if (stale) { r.stale = true; if (staleSince !== null) r.staleSince = staleSince; }
    // A stale reading is never working: no badge blinks on an old reading.
    r.working = !stale && (extra.working ?? false);
    return r;
  };
  // done: it read live (fresh), or it is a closed card with no commit of its own (typed done).
  if (e && e.phase === "live" && !stale) return out("done", null, `live${e.liveVersion ? ` in ${e.liveVersion}` : ""}`);
  if (card?.done_at && !pushed(e)) return out("done", null, "closed with no commit of its own");
  // unknown: a repository word the config does not list, or a stale reading with no earlier good one.
  if (kind === null) return out("unknown", null, `the repository word "${card?.repo ?? ""}" is not in the config`);
  if (stale && staleSince === null) return out("unknown", null, "no fresh reading and no earlier good one");
  // #C1387: a read the phase rests on failed this run (a failed call is never "no"): the card is unknown, naming the source, never working and never done. A minor source (start, behind) is no state.
  const unread = Array.isArray(e?.unread) ? UNKNOWN_BY.filter((s) => e.unread.includes(s)) : [];
  if (!stale && unread.length) return out("unknown", null, `could not read ${unread.map((s) => UNREAD_WORDS[s]).join(" and ")}`);
  // queued: nothing of its own pushed yet.
  if (!pushed(e)) {
    const role = card?.owner_role ?? null;
    // A session on a card that has pushed nothing yet is working on it (the state order puts working before queued): the first edit makes it Building, as it always did.
    if (!stale && isWorking(agents, role, card?.id)) return out("working", null, `${role} is on it, nothing pushed yet`, { working: true });
    return out("queued", busyElsewhere(agents, role, card?.id) ? { kind: "turn" } : null, "not started: no push of its own yet");
  }
  // A stale reading is never working: an old reading cannot say a session is on the card now, so it falls through to the wait or the turn it last had.
  const working = (role) => !stale && (isWorking(agents, role, card.id) || e.ci === "queued" || e.ci === "running" || e.shipping === true); // #C1426: CI running is active (DATA.md, Tile states), as queued is
  // rework (#C1391): FINDINGS on its tip, or a step back with no reason yet: with its owner again, whatever phase is lit. A re-cut after sign-offs is not rework.
  // #C1406 (Checker 2's F2, the owner's third screenshot): a card sent back by findings reads at BUILD, with its owner, and says why in the lane's words ("review findings", or "security finding" from the
  // security lane); `reviewPhase` keeps the lane that sent it back. A step back with no reason yet keeps the phase the probe read.
  if (isRework(card, e)) {
    if (reworkKind(card, e) === "findings") {
      const lane = (Array.isArray(e.findings) ? e.findings : []).find((s) => REVIEW.includes(s)) ?? phase, reason = lane === "security" ? "security finding" : "review findings";
      return out("rework", null, `sent back by ${lane}: ${reason}`, { working: working(card.owner_role), phase: "build", reviewPhase: lane, reason, since: ctx.phaseStart?.get?.(`${card?.id}|build`) ?? null });
    }
    return out("rework", null, "sent back: a step back has no reason yet", { working: working(card.owner_role) });
  }
  const wait = waitOf({ card, e, phase, kind, now, claims, agents, config, ctx });
  const role = withOf(card, e, phase, wait?.kind ?? null, "waiting", claims, config);
  if (working(role)) return out("working", wait, `${role} is on it`, { working: true });
  if (wait) return out("waiting", wait, `waits: ${wait.kind}`);
  const since = ctx.phaseStart?.get?.(`${card.id}|${phase}`), median = ctx.medians?.[phase];
  // #C1396: a push resets the clock: stuck also needs the tip itself (evidence.headAt, else readyAt: the head's time) older than the same limit; with no tip time, the phase's age alone decides, as before.
  // #C1399: a commit's date is its author's to set: a tip time more than TIP_FUTURE_MS after now is no reading of when the card last pushed, so it counts as no tip time (the phase's age alone decides) and cannot keep a card from reading stuck.
  const tipAt = e.headAt ?? e.readyAt, tipOld = !Number.isFinite(tipAt) || tipAt > now + TIP_FUTURE_MS || now - tipAt > STUCK_TIMES * median;
  if (Number.isFinite(since) && Number.isFinite(median) && now - since > STUCK_TIMES * median && tipOld) return out("stuck", null, `at ${phase} over ${STUCK_TIMES}× its usual time, nobody on it`);
  return out("waiting", { kind: "turn" }, `at ${phase}, with ${role ?? "no one"}`);
}
