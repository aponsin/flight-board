// #C1391 (the one "group ready" rule; option A, the owner's pick on #T2255): the ONE place that says what stage a card is at, what stage a group is at, and what "rework" is. It imports nothing, so
// the owner's pinned scripts and the probe's dispatch can take it without taking board-rules. Every reader asks these functions and none re-reads a head, `stackHold`, `wipHead`, a signed phase or
// `onMain` to decide about a group: the reading's group wait (worker/reading.mjs), the dispatch and the idle stall line (worker/board-rules.mjs openGroupWithheld), the slow line, stack-ready
// (scripts/stack-ready.mjs, through the queue file's `stage`) and the landing's words (collector/store-dispatch.mjs landHoldsFile). docs/DATA.d/one-group-ready-rule.md is the definition.

// The phases a review lane works on (a lane's note: language, design, checker, security): a card here is built and waits for a sign-off.
export const REVIEW_PHASES = ["language", "design", "checker", "security"];
// A card's stages, lowest first. `ready` for a group means `built` or later.
export const STAGES = ["unbuilt", "built", "signed", "landed", "live"];
export const stageRank = (s) => STAGES.indexOf(s);

const phaseOf = (e) => e?.phase ?? e?.lit?.[0];
const hasHead = (e) => !!e && typeof e === "object" && (typeof e.headSha12 === "string" || typeof e.headSha === "string");

// The three kinds of rework (#C875, #C981, #C1114). `findings` and `reason` are the OWNER's rework (the card is unbuilt, with its owner, first in the owner's queue); `unexplained` is the reviewer's turn
// and leaves the card's stage alone. A new head after sign-offs alone (a re-cut) is NOT rework: it is unbuilt until its READY is declared again, like any new head.
//   reason      - the store read a step back and no reason is attached yet (the owner's turn first);
//   findings    - a review's note on the card's head says FINDINGS while the card sits at that review's phase;
//   unexplained - a step back from a review phase with no FINDINGS note and no reason: the Worker holds the card where it was and flags it (e.rework === "unexplained").
// `e` is the card's evidence value (cards.<id>), `card` its row. Returns the kind, or null.
const noReason = (card, e) => e?.rework === true && !(typeof card?.rework_reason === "string" && card.rework_reason !== "");
const hasFindings = (e) => { const phase = phaseOf(e); return typeof phase === "string" && REVIEW_PHASES.includes(phase) && (Array.isArray(e?.findings) ? e.findings : []).some((s) => typeof s === "string" && REVIEW_PHASES.includes(s)); };
// The order is the dispatch's: a step back with no reason is the owner's turn first; an unexplained hold is shown before the findings turn (which follows once the note is on the commit and the hold is gone).
export function reworkKind(card, e) {
  if (noReason(card, e)) return "reason";
  const phase = phaseOf(e);
  if (e?.rework === "unexplained" && typeof phase === "string" && REVIEW_PHASES.includes(phase)) return "unexplained";
  return hasFindings(e) ? "findings" : null;
}
// The owner's rework: a step back with no reason, or FINDINGS on the head (whatever else the card shows): the card is with its owner again.
export const ownerRework = (card, e) => noReason(card, e) || hasFindings(e);

// A card's one stage. `unbuilt`: nothing pushed, only a start push (wipHead), no READY declared on the head (stackHold), a reading not past build, or in the owner's rework. `built`: a head declared ready
// whose reading is past build. `signed`: built, and every review it needs is signed (the reading is at ship, or the pack or install after it). `landed`: its commit is on main. `live`: its reading is live.
export function stageOf(card, e) {
  const phase = phaseOf(e);
  if (phase === "live") return "live";
  if (e?.onMain === true) return "landed";
  if (ownerRework(card, e) || e?.wipHead === true) return "unbuilt";
  // A pushed card of a stack repository that no signal covers is `stackHold` and the probe reads it at build; a head that carries a waiting note (`builtWaiting`: its builder ran stack-ready and was
  // told to wait for the group) DECLARED READY, so it is built and its groupmates' READY can go out. Without that note it has no READY yet.
  if (e?.stackHold === true) return e.builtWaiting === true && hasHead(e) ? "built" : "unbuilt";
  if (phase === "ship" || phase === "pack" || phase === "install") return "signed"; // every review is signed: a reading at ship has a head by construction
  if (!hasHead(e) || typeof phase !== "string" || phase === "" || phase === "plan" || phase === "build" || phase === "test") return "unbuilt";
  return "built";
}

// Why a member is below the stage asked, in one word: paused, blocked, sent back, not pushed, start push, no READY (a head with no READY declared, or a reading still at build).
export function whyBelow(card, e) {
  if (card?.paused) return "paused";
  if (typeof card?.blocked_reason === "string" && card.blocked_reason.trim() !== "") return "blocked";
  if (ownerRework(card, e)) return "sent back";
  if (!hasHead(e)) return "not pushed";
  if (e.wipHead === true) return "start push";
  return "no READY";
}

// One repository's names, as the store and the landing read them (case, spaces, an `<owner>/` front and a `.git` end are not another repository; "board" is the board's repository too). "" = unknown.
const BOARD_WORDS = new Set(["flight-board", "board"]);
export function repoWord(r) {
  const w = typeof r === "string" ? r.trim().toLowerCase().replace(/^.*\//, "").replace(/\.git$/, "") : "";
  return w === "" ? "" : BOARD_WORDS.has(w) ? "flight-board" : w;
}
// A card with no repository word yet, or either word unknown, is in the same repository as anything (it fails closed, #C1144); two known words that differ are two repositories.
export const sameRepo = (a, b) => { const x = repoWord(a), y = repoWord(b); return x === "" || y === "" || x === y; };

const batchWord = (c) => (typeof c?.batch === "string" && /^[A-Za-z0-9._\/-]{1,100}$/.test(c.batch.trim()) ? c.batch.trim() : "");
const isOpen = (c) => !c.dropped && c.done_at == null;

// The counted members of a card's group: every card of its batch that is open (not dropped, not closed) and belongs to the asked repository; the card itself is always one of them. A card in no
// group is a group of one. `repo` is the repository word the question is asked for (default: the card's own).
export function groupMembers(card, cards, repo = card?.repo) {
  const g = batchWord(card);
  if (!g) return card ? [card] : [];
  return (cards ?? []).filter((k) => k && typeof k.id === "string" && (k.id === card.id || (batchWord(k) === g && isOpen(k) && sameRepo(k.repo, repo))));
}

// The group's stage: the lowest stage among its counted members (a paused or blocked card counts). `evidenceOf(id)` gives a card's evidence value. `need` is the stage the asker wants every member at
// (`built` is "ready"; the landing asks `signed` and `landed`); `waitsFor` lists the members below it, [{ id, num?, stage, why }], each with the reason; `except` leaves one card out of that list (the
// asker itself). The group is `ready` when its stage is `built` or later.
export function groupStage(card, cards, evidenceOf, { need = "built", repo = card?.repo, except = null } = {}) {
  const members = groupMembers(card, cards, repo).map((k) => ({ card: k, stage: stageOf(k, evidenceOf(k.id)) }));
  const stage = members.length ? members.reduce((lo, m) => (stageRank(m.stage) < stageRank(lo) ? m.stage : lo), "live") : "unbuilt";
  const waitsFor = members.filter((m) => m.card.id !== except && stageRank(m.stage) < stageRank(need))
    .map((m) => ({ id: m.card.id, ...(Number.isInteger(m.card.num) ? { num: m.card.num } : {}), stage: m.stage, why: whyBelow(m.card, evidenceOf(m.card.id)) }));
  return { stage, ready: stageRank(stage) >= stageRank("built"), waitsFor };
}

// The reading's question: a `built` card whose group is not ready waits for its group; the cards it waits for are [{ id, num }] (the page names them). [] for any other card.
export function groupWaitsFor(card, e, cards, evidence) {
  if (stageOf(card, e) !== "built") return [];
  return groupStage(card, cards, (id) => evidence?.[id], { need: "built", except: card.id }).waitsFor.map(({ id, num }) => ({ id, ...(num !== undefined ? { num } : {}) }));
}
