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
  const from = entryIndex(git, sha, mainLine);
  if (from < 0) return null;
  for (const c of mainLine.slice(from)) { const m = re.exec(c.subject); if (m) return m[1] ?? m[0]; }
  return null;
}

// The main-line commit that brought a commit in: itself, or the oldest first-parent commit that descends from it. Its
// index in mainLine, or -1.
export function entryIndex(git, sha, mainLine) {
  if (!mainLine.length) return -1;
  const at = mainLine.findIndex((c) => c.sha === sha);
  if (at >= 0) return at;
  const entry = git(["log", "--first-parent", "--ancestry-path", "--reverse", "--format=%H", `${sha}..${mainLine[mainLine.length - 1].sha}`]).split("\n").find(Boolean);
  return entry ? mainLine.findIndex((c) => c.sha === entry) : -1;
}

// The main branch's recent successful deploy runs, newest first: [{ headSha, createdAt (ms), updatedAt (ms) }]; [] when
// no workflow is named or gh can't answer. One call per collector run.
export function deployRuns(gh, workflow, main, limit = 30) {
  if (!workflow) return [];
  try {
    const runs = JSON.parse(gh(["run", "list", "--branch", main, "--workflow", workflow, "--status", "success", "--limit", String(limit), "--json", "headSha,createdAt,updatedAt"]));
    return (Array.isArray(runs) ? runs : []).filter((r) => /^[0-9a-f]{40}$/.test(r?.headSha ?? "")).map((r) => ({ headSha: r.headSha, createdAt: Date.parse(r.createdAt ?? ""), updatedAt: Date.parse(r.updatedAt ?? "") }));
  } catch { return []; }
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
    // Only a plain hex sha reaches git: subject text must never look like an option.
    if (!m[1] || !/^[0-9a-f]{7,40}$/.test(m[2])) continue;
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

// The newest version the main line names (versionPattern), or null: what main will serve once deployed.
export function mainVersion(line, pattern) {
  const re = new RegExp(pattern);
  for (let k = line.length - 1; k >= 0; k--) { const m = re.exec(line[k].subject); if (m) return m[1] ?? m[0]; }
  return null;
}

// A response body's first max bytes as text, reading no further (the rest is cancelled) (Security).
const CAP = 262144;
async function capped(r, max) {
  if (!r.body?.getReader) return "";
  const reader = r.body.getReader(), parts = [];
  let n = 0;
  while (n < max) { const { done, value } = await reader.read(); if (done) break; parts.push(value); n += value.length; }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(n, max));
  let k = 0;
  for (const p of parts) { const take = p.subarray(0, all.length - k); all.set(take, k); k += take.length; if (k >= all.length) break; }
  return new TextDecoder().decode(all);
}

// The build the live site serves, from its page (liveTag's groups: version, commit), or null when it can't be read.
// fetchImpl: fetch; one GET, 10 seconds at most, no cookies, https to the end; only the page's first 256 KB are read.
export async function liveBuild(fetchImpl, url, tag) {
  if (!url) return null;
  try {
    const r = await fetchImpl(url, { redirect: "follow", credentials: "omit", headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok || (r.redirected && !String(r.url).startsWith("https://"))) return null;
    const m = new RegExp(tag).exec(await capped(r, CAP));
    return m && /^\d+\.\d+\.\d+$/.test(m[1] ?? "") && /^[0-9a-f]{7,40}$/.test(m[2] ?? "") ? { version: m[1], commit: m[2] } : null;
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
