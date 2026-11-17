// #C1112: shipped branches are listed for deletion by the board, not by Manager's memory. The rule was "delete shipped branches without asking", but the app blocks
// agents from deleting them, so Manager batched them into a Terminal item by hand and forgot. This lists, for each configured repository, the remote and local
// branches whose tip is already on main, and posts one evidence key, branches.shipped:
//   { at, repos: [{ name, dir, remote, remoteBranches: [branch], localBranches: [branch] }] }   (plain names only; 60 branches of each kind and 6 repositories at most)
// The store raises one Terminal ask a week from it (worker/board-store.mjs syncBranchSweep) with the delete lines. Never listed: the main branch, dev, master,
// HEAD, a branch whose tip IS main's tip (a branch just cut, with nothing of its own yet), and the branch of a card that is still open (its id is the branch's
// last path segment). A branch with commits main does not have is never "merged", so an unmerged branch is never listed. Pure but for the git function given.
import { basename } from "node:path";

export const BRANCH_MAX = 60, SWEEP_REPO_MAX = 6;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
const DIR = /^~\/[A-Za-z0-9._\/-]{1,200}$/;
const NEVER = new Set(["main", "master", "dev", "HEAD"]);

export const plainBranch = (b) => typeof b === "string" && NAME.test(b) && !b.includes("..") && !b.endsWith("/") && !b.endsWith(".lock");

// The repositories of the board config that have a "~/" folder: the team's own (collector.repoPath) first, then collector.repos[].
export function sweepRepos(configText, log = () => {}) {
  let c;
  try { c = JSON.parse(configText)?.collector; } catch { log("sweep: the board config could not be read"); return null; }
  if (!c || typeof c !== "object") return [];
  const out = [];
  const add = (dir, remote, main, name) => {
    if (typeof dir !== "string" || !DIR.test(dir) || dir.split("/").includes("..")) return;
    const r = typeof remote === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(remote) ? remote : "origin";
    const m = typeof main === "string" && plainBranch(main) ? main : "main";
    out.push({ dir, remote: r, main: m, name: typeof name === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(name) ? name : basename(dir) });
  };
  add(c.repoPath, c.remote, c.mainBranch, undefined);
  for (const x of Array.isArray(c.repos) ? c.repos : []) if (x && typeof x === "object") add(x.path, x.remote, x.mainBranch, x.name);
  return out.slice(0, SWEEP_REPO_MAX);
}

// git: (repo, args) => stdout (throws on a failure); openIds: the ids of the cards still open.
function listRepo(r, git, open) {
  const mainRef = `${r.remote}/${r.main}`;
  const tip = String(git(r, ["rev-parse", "--verify", `refs/remotes/${mainRef}`])).trim();
  const refs = (prefix) => String(git(r, ["for-each-ref", `--merged=refs/remotes/${mainRef}`, "--format=%(refname)%09%(objectname)", prefix]))
    .split("\n").map((l) => l.split("\t")).filter((p) => p.length === 2 && p[0]);
  const clean = (name, sha) => plainBranch(name) && !NEVER.has(name) && name !== r.main && sha !== tip && !open.has(name.split("/").pop());
  const remote = refs(`refs/remotes/${r.remote}/`).map(([ref, sha]) => [ref.slice(`refs/remotes/${r.remote}/`.length), sha]).filter(([n, s]) => clean(n, s)).map(([n]) => n);
  const local = refs("refs/heads/").map(([ref, sha]) => [ref.slice("refs/heads/".length), sha]).filter(([n, s]) => clean(n, s)).map(([n]) => n);
  return { name: r.name, dir: r.dir, remote: r.remote, remoteBranches: remote.slice(0, BRANCH_MAX), localBranches: local.slice(0, BRANCH_MAX) };
}

// A repository git cannot read is left out (logged), never a reason to post nothing for the others.
export function shippedBranchesWrite(configText, { git, openIds, now, log = () => {} }) {
  const repos = sweepRepos(configText, log);
  if (!repos || !repos.length) return null;
  const open = new Set(openIds ?? []);
  const out = [];
  for (const r of repos) {
    try { const l = listRepo(r, git, open); if (l.remoteBranches.length || l.localBranches.length) out.push(l); } catch (e) { log(`sweep: ${r.name} could not be read: ${String(e.message).split("\n")[0].slice(0, 80)}`); }
  }
  return { key: "branches.shipped", value: { at: now, repos: out } };
}
