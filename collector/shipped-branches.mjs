// #C1112: shipped branches are listed for deletion by the board, not by Manager's memory. The rule was "delete shipped branches without asking", but the app blocks
// agents from deleting them, so Manager batched them into a Terminal item by hand and forgot. This lists, for each configured repository, the remote and local
// branches whose tip is already on main, and posts one evidence key, branches.shipped:
//   { at, repos: [{ name, dir, remote, main, remoteBranches: [{ name, sha }], localBranches: [name] }] }   (plain names, the remote branch's tip sha for the delete's
//   lease; 60 branches of each kind and 6 repositories at most)
// The store raises one Terminal ask a week from it (worker/board-store.mjs syncBranchSweep) with the delete lines. Never listed: the main branch, dev, master,
// HEAD, a branch whose tip IS main's tip (a branch just cut, with nothing of its own yet), and the branch of a card that is still open, tied to it as the board
// does (collector/derive.mjs headsFor): the branch's last path segment is the card's id, or its tip carries the card's Board-Id trailer, or its subject starts
// "#C<number>:". A branch with commits main does not have is never "merged", so an unmerged branch is never listed. Pure but for the git function given.
import { basename } from "node:path";
import { boardIdOf, subjectNum } from "./state.mjs"; // the probe's own copies of derive.mjs's two readers (state.mjs is the file the probe pins)

export const BRANCH_MAX = 60, SWEEP_REPO_MAX = 6;
// #C1124: the sweep's git reads (for-each-ref carries every branch tip's whole message) run with this buffer, not Node's 1 MB default; output past it is an error, never a partial list.
export const SWEEP_GIT_MAX_BUFFER = 64 * 1024 * 1024;
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
  // One record per branch: refname, tip sha and the tip's whole message (the board ties a branch to a card by the Board-Id trailer and the "#C<n>:" subject as
  // well as by the branch name: collector/derive.mjs headsFor), records ended by \x1e and fields by \x1f.
  const refs = (prefix) => String(git(r, ["for-each-ref", `--merged=refs/remotes/${mainRef}`, "--format=%(refname)%1f%(objectname)%1f%(contents)%1e", prefix]))
    .split("\x1e").map((rec) => rec.replace(/^\n/, "").split("\x1f")).filter((p) => p.length === 3 && p[0]).map(([ref, sha, message]) => ({ ref, sha, message }));
  const isOpen = (name, message) => open.ids.has(name.split("/").pop()) || open.ids.has(boardIdOf(message)) || (Number.isInteger(subjectNum(message)) && open.nums.has(subjectNum(message)));
  const clean = (name, sha, message) => plainBranch(name) && !NEVER.has(name) && name !== r.main && sha !== tip && !isOpen(name, message);
  const pick = (prefix) => refs(prefix).map((x) => ({ ...x, name: x.ref.slice(prefix.length) })).filter((x) => clean(x.name, x.sha, x.message));
  const remote = pick(`refs/remotes/${r.remote}/`).filter((x) => /^[0-9a-f]{40}$/.test(x.sha)).map((x) => ({ name: x.name, sha: x.sha }));
  const local = pick("refs/heads/").map((x) => x.name);
  return { name: r.name, dir: r.dir, remote: r.remote, main: r.main, remoteBranches: remote.slice(0, BRANCH_MAX), localBranches: local.slice(0, BRANCH_MAX) };
}

// A repository git cannot read is left out (logged), never a reason to post nothing for the others.
export function shippedBranchesWrite(configText, { git, openIds, now, log = () => {} }) {
  const repos = sweepRepos(configText, log);
  if (!repos || !repos.length) return null;
  // The cards still open: ids (a string) or { id, num }; a branch is theirs by name, by Board-Id trailer or by "#C<num>:" subject.
  const cards = (Array.isArray(openIds) ? openIds : []).map((c) => (typeof c === "string" ? { id: c } : c)).filter((c) => c && typeof c.id === "string");
  const open = { ids: new Set(cards.map((c) => c.id)), nums: new Set(cards.map((c) => c.num).filter(Number.isInteger)) };
  const out = [];
  for (const r of repos) {
    try { const l = listRepo(r, git, open); if (l.remoteBranches.length || l.localBranches.length) out.push(l); } catch (e) {
      // #C1124: git's output longer than the buffer is cut (ENOBUFS). A cut list is never swept: the repository is left out and the log says why, not "could not be read".
      if (e && (e.code === "ENOBUFS" || /ENOBUFS|maxBuffer/.test(String(e.message)))) log(`sweep: ${r.name} git's output was longer than the ${SWEEP_GIT_MAX_BUFFER}-byte buffer and was cut: nothing was swept for it`);
      else log(`sweep: ${r.name} could not be read: ${String(e.message).split("\n")[0].slice(0, 80)}`);
    }
  }
  return { key: "branches.shipped", value: { at: now, repos: out } };
}
