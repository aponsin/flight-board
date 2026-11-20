// #C1380 step 1 (the owner's pick A on #T2194; the contract is docs/DATA.d/one-reading-module.md): the ONE place that says where a card is.
// `reading(card, evidence, claims, agents, config, now, ctx)` is pure: the card's row, the probe's evidence value for it (cards.<id>), the review claims,
// the agents' reading, the config and the time go in; { phase, state, wait, with, working, since, asOf, why } come out. Step 1 adds the module, its
// fixtures and its laws; no view calls it yet (the Worker, the dispatch, the page and the crew panel move to it in steps 2 and 3).
// It imports only worker/ files (the Worker bundle holds nothing of the collector).
import { isRework, holdOpen, groupWaits, repoKey, repoKind, reviewerOf, PHASE_LANES } from "./board-rules.mjs";

export const STATES = ["done", "unknown", "rework", "working", "waiting", "stuck", "queued"];
export const WAITS = ["turn", "group", "land", "pack", "install", "deploy", "ask", "hold"];
// The phases a reviewer holds, and the work phases the card's owner holds.
const REVIEW = ["language", "design", "checker", "security"];
const OWNER_PHASES = ["plan", "build", "test"];
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

const pushed = (e) => !!e && typeof e === "object" && (typeof e.headSha === "string" || typeof e.headSha12 === "string");
const isWorking = (agents, role, cardId) => !!role && agents?.[role]?.state === "working" && agents[role].card === cardId;
const busyElsewhere = (agents, role, cardId) => !!role && agents?.[role]?.state === "working" && !!agents[role].card && agents[role].card !== cardId;

// `with`: one role. The card's owner at plan, build, test and rework; at a review phase the role that holds the open claim on the tip, else the repository's reviewer
// from the config (#C1100), else the lane's role; the release role at land, ship and the live read; the owner of the board at install and ask.
export function withOf(card, e, phase, wait, state, claims, config) {
  if (wait === "install" || wait === "ask") return config?.owner ?? "owner";
  if (state === "rework" || OWNER_PHASES.includes(phase) || !phase) return card?.owner_role ?? null;
  if (REVIEW.includes(phase)) {
    const claim = (claims ?? []).find((c) => c && !c.released_at && c.card_id === card?.id && typeof e?.headSha === "string" && c.sha === e.headSha);
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
  if (groupWaits(card, e, ctx?.cards, ctx?.evidence)) return { kind: "group" };
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
  // queued: nothing of its own pushed yet.
  if (!pushed(e)) {
    const role = card?.owner_role ?? null;
    return out("queued", busyElsewhere(agents, role, card?.id) ? { kind: "turn" } : null, "not started: no push of its own yet", { working: isWorking(agents, role, card?.id) });
  }
  // A stale reading is never working: an old reading cannot say a session is on the card now, so it falls through to the wait or the turn it last had.
  const working = (role) => !stale && (isWorking(agents, role, card.id) || e.ci === "queued" || e.shipping === true);
  // rework: findings on its tip, or a tip newer than its last sign-off: with its owner again, whatever phase is lit.
  if (isRework(card, e)) return out("rework", null, "sent back: findings or a newer tip than its last sign-off", { working: working(card.owner_role) });
  const wait = waitOf({ card, e, phase, kind, now, claims, agents, config, ctx });
  const role = withOf(card, e, phase, wait?.kind ?? null, "waiting", claims, config);
  if (working(role)) return out("working", wait, `${role} is on it`, { working: true });
  if (wait) return out("waiting", wait, `waits: ${wait.kind}`);
  const since = ctx.phaseStart?.get?.(`${card.id}|${phase}`), median = ctx.medians?.[phase];
  if (Number.isFinite(since) && Number.isFinite(median) && now - since > STUCK_TIMES * median) return out("stuck", null, `at ${phase} over ${STUCK_TIMES}× its usual time, nobody on it`);
  return out("waiting", { kind: "turn" }, `at ${phase}, with ${role ?? "no one"}`);
}
