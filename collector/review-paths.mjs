// Which reviews a card needs comes from the files its branch touches (#C897, prevention: #C894, a scripts change, went to the language review
// because its card was Full with an empty skip; #C903, carded Quick, added a Worker route and needed Security). A level or a skip typed at card
// time rests on memory (principle 1). A repository's reviewPaths (board config: collector.reviewPaths for the team's repository,
// collector.repos[].reviewPaths for another) maps a review phase to path patterns: the phase is needed when a changed path matches one of them.
// A typed field can only RAISE a review, never lower it: the config's skips rule for that phase read the other way round (a level equal to
// unlessLevel, a field true for whenFalse or unlessTrue) adds it. A phase the table does not name keeps the typed rule. With no table, or no
// diff read, the typed rule decides as before. Pure: no git, no file, no clock.

import { REVIEW_PATTERN as PATTERN, reviewPathsErrors } from "../scripts/config.mjs";
export { reviewPathsErrors };

// A pattern (scripts/config.mjs REVIEW_PATTERN): a path relative to the repository, with * (any characters but /) and ** (any characters,
// / too). Nothing else is special.
export function patternRe(p) {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*" && p[i + 1] === "*") { out += ".*"; i++; }
    else if (p[i] === "*") out += "[^/]*";
    else out += p[i].replace(/[.+?^${}()|[\]\\\/-]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

// The phases of the table any of the paths matches, as a Set.
export function pathPhases(table, paths) {
  const hit = new Set();
  for (const [p, list] of Object.entries(table ?? {})) {
    if (!Array.isArray(list)) continue;
    const res = list.filter((s) => typeof s === "string" && PATTERN.test(s)).map(patternRe);
    if (paths.some((f) => res.some((re) => re.test(f)))) hit.add(p);
  }
  return hit;
}

// Whether the card's typed fields ask for the phase (the skips rules read the other way round): a raise only.
function raised(card, phase, config) {
  return (config.skips ?? []).some((k) => k.phase === phase && (
    (k.unlessLevel && card.level === k.unlessLevel) || (k.whenFalse && card[k.whenFalse] === true) || (k.unlessTrue && card[k.unlessTrue] === true)));
}

// The review phases the card needs, in the config's notes order. typed: the phases the typed rule gives (reviewsFor). table and paths: the
// repository's reviewPaths and the branch's changed paths; either missing (or paths not a list) leaves the typed rule.
export function reviewsFromPaths(card, config, typed, table, paths) {
  if (!table || typeof table !== "object" || Array.isArray(table) || !Array.isArray(paths)) return typed;
  const hit = pathPhases(table, paths);
  return Object.keys(config.collector.notes).filter((p) => (Object.hasOwn(table, p) ? hit.has(p) || raised(card, p, config) : typed.includes(p)));
}
