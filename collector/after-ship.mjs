// A branch tip that moved on after its card shipped (#C527: #C521's card stayed open after its ship, because a5e30d5d, a
// dev merge and a blank line, came after the signed d1f2a699; ship cleanup deletes only a branch whose tip is the shipped
// commit, and the collector read the newer tip as unreviewed). The card's phase is its shipped commit's; what came after
// is "extra commits after ship", never a review reopened. The collector (collect.mjs) and the minute probe (state.mjs,
// pinned) both read it this way. Pure on git(args), which returns stdout and throws on a non-zero exit.

export const AFTER_SHIP_MAX = 20, MAIN_SUBJECTS = 400;
const SHA = /^[0-9a-f]{40}$/;
const ok = (fn) => { try { fn(); return true; } catch { return false; } };
const idIn = (message) => { const m = /^Board-Id:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/im.exec(String(message ?? "")); return m ? m[1].toLowerCase() : null; };

// Whether a commit on main is the card's shipped one: its Board-Id is the card's, or main's line names this branch at
// that commit (shippedPattern's groups: branch, sha; the team's "v1.170.2: <branch>@<sha>"). A sign-off alone is not
// enough: a branch cut from another card's signed commit has that commit as its fork point.
export function isShipOf(git, ref, sha, { id, branch, pattern }) {
  try { if (idIn(git(["log", "-1", "--format=%B", sha])) === id) return true; } catch { /* unreadable: not by trailer */ }
  if (!pattern || !branch) return false;
  let subjects = "";
  // The branch goes to git as a fixed string inside --grep=, never a pattern or an option.
  try { subjects = git(["log", "--first-parent", `-${MAIN_SUBJECTS}`, "--fixed-strings", `--grep=${branch}@`, "--format=%s", ref]); } catch { return false; }
  const re = new RegExp(pattern, "g");
  return subjects.split("\n").some((s) => [...s.matchAll(re)].some((m) => m[1] === branch && /^[0-9a-f]{7,40}$/.test(m[2] ?? "") && sha.startsWith(m[2])));
}

// A commit after the ship that is new READY work (#C224: a rework on the same branch is the card's phase, not the old
// ship's): it carries the card's Board-Id. A sign-off is no sign of new work: #C521's later tip was signed by Designer
// and Linguist, asked to by the very reading this fixes.
function readyWork(git, sha, { id }) {
  try { return idIn(git(["log", "-1", "--format=%B", sha])) === id; } catch { return false; }
}

// The newest commit on the tip's first-parent line that is on ref (the main branch), when it is the card's shipped one
// (isShipOf) and nothing after it is new READY work: { sha, extra (first-parent commits after it, a merge counting
// one) }. A tip on main, the fork point, a rework after the ship, or anything git can't answer is null: the tip stays
// as it is. card: { id, branch, pattern (shippedPattern) }.
export function shippedBase(git, ref, tipSha, card) {
  try {
    if (!SHA.test(String(tipSha)) || ok(() => git(["merge-base", "--is-ancestor", tipSha, ref]))) return null;
    const line = git(["rev-list", "--first-parent", `--max-count=${AFTER_SHIP_MAX + 1}`, tipSha]).split("\n").filter((s) => SHA.test(s));
    for (let k = 1; k < line.length; k++) {
      if (!ok(() => git(["merge-base", "--is-ancestor", line[k], ref]))) continue;
      if (!isShipOf(git, ref, line[k], card) || line.slice(0, k).some((s) => readyWork(git, s, card))) return null;
      return { sha: line[k], extra: k };
    }
  } catch { /* a tip git can't read stays as it is */ }
  return null;
}

// The branch fetch the collector and the probe run on their own clones (#C527, Manager: #C521's branch, deleted on
// GitHub at 16:05Z, still read as "READY at a5e30d5d" 30 min later; the clone held ~390 deleted branches). --prune
// drops a remote-tracking branch the remote no longer has. Notes are fetched apart and keep their own rule.
export const fetchBranches = (remote) => ["fetch", "-q", "--prune", remote];

export const afterShipText = (branch, tipSha, extra) => `${branch} has ${extra} extra commit${extra === 1 ? "" : "s"} after ship (tip ${String(tipSha).slice(0, 8)}): not a new review`;
