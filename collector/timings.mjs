// A card's phase times from the evidence (#C235), so a card nobody logged steps for still shows when each phase ran:
//   plan   - the card made → its branch's first commit;
//   build  - the first commit → READY (the head's time, or the first sign-off if earlier; open while not READY); a
//            branch of one commit doesn't say when its work began, so plan and build are left to the steps;
//   review - each sign-off note's time, in the order they came: review k runs from READY (or the note before it, if later)
//            to its note; the review the card waits on runs open from there;
//   ship   - the ship run taking the work (the main-line commit that merged it, or the first commit naming the head,
//            shippedPattern, whichever came first) → the first successful deploy run on main that contains it starting
//            (main got it then: a commit's own time says nothing of its push); open until then;
//   live   - that deploy run: its start → its end.
// Out: { <phase>: { start, end | null } } in ms, only the phases the evidence shows with a length. The page puts these in place of the
// steps for those phases; steps fill the rest (a test, a design talk). git(args) and the facts come in, as in facts.mjs.
import { entryIndex } from "./facts.mjs";
import { reviewsFor } from "./derive.mjs";

const US = "\x1f";
const ms = (s) => (/^\d+$/.test(String(s ?? "").trim()) ? Number(String(s).trim()) * 1000 : null);
const tryGit = (git, args) => { try { return git(args); } catch { return ""; } };

// The time the commit's note was written in a notes ref (its last change, fan-out path or not), or null.
export function noteAt(git, ref, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  return ms(tryGit(git, ["log", "-1", "--format=%ct", ref, "--", sha, `${sha.slice(0, 2)}/${sha.slice(2)}`]).split("\n")[0]);
}

// The times of `head`'s commits that `base` doesn't have, oldest first: the branch's work.
export function branchCommits(git, head, base) {
  return tryGit(git, ["log", "--reverse", "--format=%ct", head, "--not", base]).split("\n").map(ms).filter((t) => t != null);
}

// The oldest commit after `head` on the way to `tip` whose subject names the head, in full or as the pattern's branch@sha
// (groups: branch, sha), or null: when a ship run took the work.
export function namedAt(git, head, tip, pattern) {
  if (!pattern || !tip) return null;
  const re = new RegExp(pattern, "g");
  const lines = tryGit(git, ["log", "--ancestry-path", "--reverse", "--format=%ct%x1f%s", `${head}..${tip}`]).split("\n").filter(Boolean);
  for (const l of lines) {
    const [at, subject] = l.split(US);
    // A ship run's merge names the commit in full ("Merge commit '<sha>' into …"); its version commit, branch@sha.
    if (String(subject).includes(head)) return ms(at);
    for (const m of String(subject).matchAll(re)) if (/^[0-9a-f]{7,40}$/.test(m[2] ?? "") && head.startsWith(m[2])) return ms(at);
  }
  return null;
}

// The phase times for one card. derived: derivePhase's answer for its head ({ phase, head, readyAt, ... }); head: the
// head itself ({ sha, at }); line: the main line; runs: deployRuns(); candidates: ship-run branch heads naming it.
export function evidenceTimes(git, { card, derived, head, line, runs = [], config, notes, candidate = null }) {
  const c = config.collector, out = {};
  if (!head || !derived?.phase) return out;
  const sha = head.sha;
  const k = entryIndex(git, sha, line);
  const entry = k >= 0 ? line[k] : null;
  // What main had before the work: main before the commit that brought it in, or main now. A branch of one commit (or
  // a fast-forward, which leaves no trace of where it began) shows only when the work ended: plan and build are left to
  // the steps.
  const work = branchCommits(git, sha, entry ? `${entry.sha}^1` : `${c.remote}/${c.mainBranch}`);
  const first = work.length > 1 ? work[0] : null;
  // Reviews, in the order their notes came.
  const signed = reviewsFor(card, config).map((p) => ({ p, t: notes[p] ? noteAt(git, notes[p], sha) : null })).filter((r) => r.t != null).sort((a, b) => a.t - b.t);
  // READY (derivePhase gives it once the head is READY), never after the first sign-off: a head rewritten after it was
  // signed (a rebase, notes carried over) has a later commit time than its reviews.
  const ready = derived.readyAt == null ? null : Math.min(derived.readyAt, signed[0]?.t ?? Infinity);
  if (Number.isFinite(card.createdAt) && first != null) out.plan = { start: card.createdAt, end: first };
  if (first != null) out.build = { start: first, end: ready };
  if (ready == null) return kept(out);
  let from = ready;
  for (const { p, t } of signed) { out[p] = { start: Math.min(from, t), end: t }; from = Math.max(from, t); }
  if (reviewsFor(card, config).includes(derived.phase) && !out[derived.phase]) out[derived.phase] = { start: from, end: null };
  // Ship: from the ship run taking it (its merge, or the first commit naming it) to main having it, which the first
  // deploy run that contains it shows (a commit's own time says nothing of when it was pushed). Live: that run.
  const named = namedAt(git, sha, entry ? `${c.remote}/${c.mainBranch}` : candidate, c.shippedPattern);
  const run = entry ? firstRun(k, runs, line) : null;
  const took = Math.min(named ?? Infinity, entry?.at ?? Infinity);
  // Live with no run that shows when (its deploy is older than the runs read): the ship's end is unknown.
  if (Number.isFinite(took) && !(derived.phase === c.livePhase && !run)) out[c.shipPhase] = { start: took, end: run ? run.createdAt : null };
  if (run && derived.phase === c.livePhase) out[c.livePhase] = { start: run.createdAt, end: Number.isFinite(run.updatedAt) ? run.updatedAt : null };
  return kept(out);
}

// The first deploy run that has the main-line commit at index `entry` (a run deploys a main-line commit: it has every
// one up to it), or null. Only when the run before it (older) didn't have it: the oldest run read may come long after
// the commit's own deploy. Runs off the main line read are left out.
const places = new WeakMap();
export function firstRun(entry, runs, line) {
  let at = places.get(line);
  if (!at) places.set(line, at = new Map(line.map((c, n) => [c.sha, n])));
  const old = runs.filter((r) => Number.isFinite(r.createdAt) && at.has(r.headSha)).sort((a, b) => a.createdAt - b.createdAt);
  const k = old.findIndex((r) => at.get(r.headSha) >= entry);
  return k > 0 ? old[k] : null;
}

// Only phases with a length: an end before or at its start says nothing of how long it took (steps fill it).
const kept = (out) => Object.fromEntries(Object.entries(out).filter(([, v]) => v.end == null || v.end > v.start));
