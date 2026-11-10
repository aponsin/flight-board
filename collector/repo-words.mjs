// The repo word of a card, filled in by the probe from git (#C742). A card of another repository (the board's own) has to carry that
// repository's name as its repo word: the live rule (#C737) and the stall-wake exemption read it. Agents forgot it (every store card had none),
// and the Worker cannot see git, so the probe, which can, writes it: a card with NO repo word whose Board-Id line is on a commit of that
// repository's main branch, or on the tip of one of its remote build/ branches (work not landed yet), gets that repository's name from the
// board config's collector.repos. It NEVER changes a repo word that is already set: the probe skips a card that has one, and the Worker's
// write only takes a card whose word is empty. Pure over an injected `git(args) -> text` per repository.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { FETCH_TIMEOUT_MS } from "./probe-board.mjs";

// The Board-Id lines of a git log output, from the whole message (a trailer block would miss an id above the co-author line).
export const idsOf = (text) => new Set([...String(text).matchAll(/^Board-Id:[ \t]*([a-z0-9][a-z0-9-]{0,63})[ \t]*$/gm)].map((m) => m[1]));

// Which card ids the repository holds work for: commits on <remote>/<main>, and the tip of each <remote>/build/ branch.
export function boardIdsFromGit(git, { remote = "origin", main = "main" } = {}) {
  const ids = idsOf(git(["log", `${remote}/${main}`, "--format=%B"]));
  const refs = git(["for-each-ref", "--format=%(refname)", `refs/remotes/${remote}/build/`]).split("\n").map((s) => s.trim()).filter(Boolean);
  for (const ref of refs) for (const id of idsOf(git(["log", "-1", "--format=%B", ref]))) ids.add(id);
  return ids;
}

const WORD = /^[a-z0-9][a-z0-9-]{0,39}$/;
const expandHome = (p, home = homedir()) => String(p).replace(/^~(?=\/|$)/, home);

// The cards (the store's, as /api/view gives them) that have no repo word and the repository that holds work for them.
// repos: collector.repos of the board config; idsFor(repo) -> Set of Board-Ids (or null when it cannot be read). A card two repositories claim is left alone.
export function repoWordsToFill(cards, repos, idsFor) {
  const have = [];
  for (const r of Array.isArray(repos) ? repos : []) {
    if (!r || !WORD.test(String(r.name ?? ""))) continue;
    const ids = idsFor(r);
    if (ids) have.push({ name: r.name, ids });
  }
  const out = [];
  for (const c of cards) {
    if (!c || typeof c.id !== "string" || (typeof c.repo === "string" && c.repo !== "")) continue;
    const owners = have.filter((h) => h.ids.has(c.id));
    if (owners.length === 1) out.push({ id: c.id, repo: owners[0].name });
  }
  return out;
}

// The probe's run: read git for each repository of the config and post each word (POST /api/probe/card-repo). Anything that goes wrong is logged
// and never fails the evidence job.
export async function fillRepoWords({ cards, repos, base, headers, fetchImpl = fetch, log = () => {}, gitIn = (dir) => (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }) }) {
  let posted = 0;
  try {
    const idsFor = (r) => {
      try { return boardIdsFromGit(gitIn(expandHome(r.path)), { remote: r.remote ?? "origin", main: r.mainBranch ?? "main" }); } catch { log(`repo words: ${String(r.name).slice(0, 40)} could not be read from git`); return null; }
    };
    for (const w of repoWordsToFill(cards, repos, idsFor)) {
      const r = await fetchImpl(`${base}/api/probe/card-repo`, { method: "POST", headers, body: JSON.stringify(w), redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (r.ok) posted++; else log(`repo word for ${w.id} answered ${r.status}`);
    }
    if (posted) log(`repo words: ${posted} card(s) given their repository`);
  } catch (e) { log(`repo words failed: ${String(e.message).slice(0, 120)}`); }
  return posted;
}
