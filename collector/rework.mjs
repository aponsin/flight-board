// A rework the lead must count (#C468, board-issue-kinds; the owner's #T1170: #C465 went back for Designer's two findings
// and his own menu decision, its chips still at 0). Pure, shared by the Collector's nudge and the gate's refusal, so the
// two can never disagree. A signal is a review's end whose note starts "FINDINGS", or a second build start on a card that
// already has a review step. A review phase lies between the build and the ship and isn't a lane (test is the builder's).
// The lead counts it in the card's issues and sets issuesAt; a card counted before this rule (issues, no issuesAt) is
// taken as counted.
export const ISSUE_KINDS = ["bugs", "security", "language", "design", "owner"];

export function issueTotal(issues) {
  if (!issues || typeof issues !== "object") return 0;
  return Object.values(issues).reduce((s, v) => s + (Number.isInteger(v) && v >= 0 ? v : 0), 0);
}

function reviewPhases(config) {
  const order = config.phases.map((p) => p[0]), c = config.collector, lanes = new Set(c.lanePhases ?? []);
  return new Set(order.slice(order.indexOf(c.buildPhase) + 1, order.indexOf(c.shipPhase)).filter((p) => !lanes.has(p)));
}

// The newest signal on the card the lead hasn't counted yet: { at, kind: "findings" | "build", who }, or null.
export function reworkOwed(card, steps, config) {
  if (!card || card.status === "done" || card.status === "dropped") return null;
  const reviews = reviewPhases(config), build = config.collector.buildPhase;
  const own = (Array.isArray(steps) ? steps : []).filter((s) => s && s.init === card.id && Number.isFinite(s.at) && !s.wait);
  const firstReview = Math.min(...own.filter((s) => reviews.has(s.phase)).map((s) => s.at));
  const signals = own.filter((s) => (s.kind === "end" && reviews.has(s.phase) && /^FINDINGS\b/.test(String(s.note ?? ""))) || (s.kind === "start" && s.phase === build && s.at > firstReview))
    .map((s) => ({ at: s.at, kind: s.phase === build ? "build" : "findings", who: s.who }));
  if (!signals.length) return null;
  const last = signals.reduce((a, b) => (b.at > a.at ? b : a));
  if (Number.isFinite(card.issuesAt) ? card.issuesAt >= last.at : issueTotal(card.issues) > 0) return null;
  return last;
}

const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
// What the signal was, for the nudge and the refusal: "FINDINGS by Designer at 20:52 UTC". who goes through the caller's
// idText.
export const signalText = (s, idText) => `${s.kind === "build" ? "a new build start" : "FINDINGS"} by ${idText(s.who ?? "someone")} at ${hhmm(s.at)} UTC`;
