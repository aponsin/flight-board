// A rework the lead must count (#C468, board-issue-kinds; the owner's #T1170: #C465 went back for Designer's two findings
// and his own menu decision, its chips still at 0). Pure, shared by the Collector's nudge and the gate's refusal, so the
// two can never disagree. A signal is a review's end whose note starts "FINDINGS", or a second build start on a card that
// already has a review step. A review phase lies between the build and the ship and isn't a lane (test is the builder's).
// The lead counts it in the card's issues and sets issuesAt; a card counted before this rule (issues, no issuesAt) is
// taken as counted.
export const ISSUE_KINDS = ["bugs", "security", "language", "design", "owner"];

// The known kinds only (Security on 505d4901: a junk key would clear the refusal while no chip shows it).
export function issueTotal(issues) {
  if (!issues || typeof issues !== "object") return 0;
  return ISSUE_KINDS.reduce((s, k) => s + (Number.isInteger(issues[k]) && issues[k] >= 0 ? issues[k] : 0), 0);
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
  // Oldest first. A build start after a review is a signal only when no FINDINGS came since the build start before it:
  // a FINDINGS already stands for that rework (Checker on 505d4901: Manager counts it, then the fix starts).
  const signals = [];
  let reviewed = false, findingsSince = false;
  for (const s of own.slice().sort((a, b) => a.at - b.at)) {
    if (reviews.has(s.phase)) {
      reviewed = true;
      if (s.kind === "end" && /^FINDINGS\b/.test(String(s.note ?? ""))) { signals.push({ at: s.at, kind: "findings", who: s.who }); findingsSince = true; }
    } else if (s.kind === "start" && s.phase === build) {
      if (reviewed && !findingsSince) signals.push({ at: s.at, kind: "build", who: s.who });
      findingsSince = false;
    }
  }
  if (!signals.length) return null;
  const last = signals.reduce((a, b) => (b.at > a.at ? b : a));
  if (Number.isFinite(card.issuesAt) ? card.issuesAt >= last.at : issueTotal(card.issues) > 0) return null;
  return last;
}

const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
// What the signal was, for the nudge and the refusal: "FINDINGS by Designer at 20:52 UTC". who goes through the caller's
// idText.
export const signalText = (s, idText) => `${s.kind === "build" ? "a new build start" : "FINDINGS"} by ${idText(s.who ?? "someone")} at ${hhmm(s.at)} UTC`;
