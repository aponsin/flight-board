// The facts the collector reads, from the team's repository and its CI runs. Every function takes `git(args)` (and
// `gh(args)`), returning stdout as a string and throwing on a non-zero exit, so tests run them on a scratch repository.

const US = "\x1f", RS = "\x1e";

// Every branch on the remote: [{ branch, sha, at (ms), message }].
export function remoteHeads(git, remote) {
  const out = git(["for-each-ref", `refs/remotes/${remote}`, `--format=%(refname:lstrip=3)%1f%(objectname)%1f%(committerdate:unix)%1f%(contents)%1e`]);
  return out.split(RS).map((r) => r.replace(/^\n/, "")).filter((r) => r.includes(US)).map((r) => {
    const [branch, sha, at, message] = r.split(US);
    return { branch, sha, at: Number(at) * 1000, message };
  }).filter((h) => h.branch && h.branch !== "HEAD");
}

const ok = (fn) => { try { fn(); return true; } catch { return false; } };

// The review phases whose notes ref holds a note on the commit.
export function signedPhases(git, sha, notes) {
  return new Set(Object.entries(notes).filter(([, ref]) => ok(() => git(["notes", `--ref=${ref}`, "show", sha]))).map(([p]) => p));
}

export const isAncestor = (git, a, b) => ok(() => git(["merge-base", "--is-ancestor", a, b]));

// The version a commit shipped in: the first commit on the main branch's first-parent line, from the one that brought it
// in onwards, whose subject matches the version pattern. [{ sha, subject }] is the main line, oldest first.
export function versionFor(git, sha, mainLine, pattern) {
  const re = new RegExp(pattern);
  if (!mainLine.length) return null;
  // The main-line commit that brought it in: itself, or the oldest first-parent commit that descends from it.
  let from = mainLine.findIndex((c) => c.sha === sha);
  if (from < 0) {
    const entry = git(["log", "--first-parent", "--ancestry-path", "--reverse", "--format=%H", `${sha}..${mainLine[mainLine.length - 1].sha}`]).split("\n").find(Boolean);
    from = entry ? mainLine.findIndex((c) => c.sha === entry) : -1;
  }
  if (from < 0) return null;
  for (const c of mainLine.slice(from)) { const m = re.exec(c.subject); if (m) return m[1] ?? m[0]; }
  return null;
}

export function mainLine(git, remote, main, limit = 400) {
  return git(["log", "--first-parent", `-${limit}`, "--reverse", "--format=%H%x1f%ct%x1f%s", `${remote}/${main}`]).split("\n").filter(Boolean)
    .map((l) => { const [sha, at, subject] = l.split(US); return { sha, at: Number(at) * 1000, subject }; });
}

// Branches the main line says it shipped, with the commit it shipped of each (shippedPattern's groups: branch, sha):
// the heads of branches deleted since. [{ branch, sha, at, message: "" }]
export function shippedHeads(git, line, pattern) {
  if (!pattern) return [];
  const re = new RegExp(pattern, "g");
  const out = [];
  for (const c of line) for (const m of c.subject.matchAll(re)) {
    if (!m[1] || !m[2]) continue;
    let sha = m[2];
    try { sha = git(["rev-parse", "--verify", "--quiet", `${m[2]}^{commit}`]).trim(); } catch { continue; }
    out.push({ branch: m[1], sha, at: c.at, message: "" });
  }
  return out;
}

// The newest successful deploy run's commit on the main branch, or null (no workflow named, or none succeeded).
export function deployedSha(gh, workflow, main) {
  if (!workflow) return null;
  try {
    const runs = JSON.parse(gh(["run", "list", "--branch", main, "--workflow", workflow, "--status", "success", "--limit", "1", "--json", "headSha"]));
    return runs[0]?.headSha ?? null;
  } catch { return null; }
}

// Everything derivePhase needs for one head.
export function factsFor(git, head, { config, line, deployed }) {
  const c = config.collector;
  if (!head) return { head: null };
  const onMain = isAncestor(git, head.sha, `${c.remote}/${c.mainBranch}`);
  return {
    head,
    signed: signedPhases(git, head.sha, c.notes),
    onMain,
    deployed: onMain && !!deployed && isAncestor(git, head.sha, deployed),
    version: onMain ? versionFor(git, head.sha, line, c.versionPattern) : null,
  };
}
