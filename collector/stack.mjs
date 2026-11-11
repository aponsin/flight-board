// #C859 slice 2: the stack, read from git and never typed. For a repository with its stack switch on, the stack is every open card whose commit
// (its Board-Id line) is an ancestor of one branch's tip: the build branch that carries the most open cards. A card whose commit is on another
// branch that is not under the stack tip is "outside the stack". An open card with nothing pushed is "next in the stack", by queue order.
// Plain functions over a git runner git(args) -> stdout; ids go to git as fixed strings, never patterns; nothing is written.
const CARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9._\/-]{1,120}$/;
export const MAX_STACK = 40, MAX_COMMITS = 200;
// The file the evidence job's snapshot of the store's stack switches is kept in, beside the private mirror: { at, switches: { repo: bool } }.
export const STACK_SWITCH_FILE = "stack-switch.json";
// The repository names (keys of the probe's repos, "" the team's own) whose switch is on; a switch for the team's own repository is `product`.
export const stackOnNames = (switches) => Object.entries(switches && typeof switches === "object" ? switches : {}).filter(([, v]) => v === true).map(([k]) => (k === "product" ? "" : k));

// The Board-Id trailer values of one commit message.
export const boardIds = (message) => [...String(message ?? "").matchAll(/^Board-Id:[ \t]*(\S+)[ \t]*$/gm)].map((m) => m[1]).filter((i) => CARD_ID.test(i));

// The commits a branch has beyond main, oldest first, each { sha, ids }. Bounded; a git failure reads as none.
export function ownCommits(git, remote, main, sha) {
  if (!SHA.test(String(sha))) return [];
  let out = "";
  try { out = git(["log", "--reverse", `-${MAX_COMMITS}`, "--format=%H%x1f%ct%x1f%B%x1e", `${remote}/${main}..${sha}`]); } catch { return []; }
  return String(out).split("\x1e").map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r) => {
    const [h, ct, body] = r.split("\x1f");
    return { sha: String(h).trim(), at: Number(ct) * 1000, message: body ?? "", ids: boardIds(body) };
  }).filter((c) => SHA.test(c.sha));
}

const isAncestor = (git, a, b) => { try { git(["merge-base", "--is-ancestor", a, b]); return true; } catch { return false; } };

// tips: [{ branch, sha, at }] (the repository's remote branches), open: ordered ids of the repository's open cards (queue order), main: the
// main branch name. Returns null when no open card is on any branch, else
// { branch, tip, members: [{ id, sha }], outside: { id: branch }, next: [id] }.
export function stackOf({ git, remote, main, tips, open }) {
  const openSet = new Set((open ?? []).filter((i) => CARD_ID.test(String(i))));
  const byBranch = [];
  for (const t of (tips ?? []).filter((h) => h && h.branch !== main && BRANCH.test(String(h.branch)) && !String(h.branch).startsWith("-") && SHA.test(String(h.sha)))) {
    const commits = ownCommits(git, remote, main, t.sha);
    const mine = new Map();
    for (const c of commits) for (const id of c.ids) if (openSet.has(id)) mine.set(id, c);
    if (mine.size) byBranch.push({ ...t, mine });
  }
  if (!byBranch.length) return null;
  // The stack branch carries the most open cards; the newest tip breaks a tie, then the name (so two runs agree).
  byBranch.sort((a, b) => b.mine.size - a.mine.size || (b.at ?? 0) - (a.at ?? 0) || String(a.branch).localeCompare(String(b.branch)));
  const top = byBranch[0];
  const members = [...top.mine].slice(0, MAX_STACK).map(([id, c]) => ({ id, sha: c.sha, at: c.at, message: c.message }));
  const inside = new Set(members.map((m) => m.id));
  const outside = {};
  for (const other of byBranch.slice(1)) {
    // A branch that is only the stack's own earlier part (its tip is under the stack tip) is inside, not a second line of work.
    const under = isAncestor(git, other.sha, top.sha);
    for (const [id, c] of other.mine) {
      if (inside.has(id) || outside[id]) continue;
      if (under || isAncestor(git, c.sha, top.sha)) { inside.add(id); continue; }
      outside[id] = other.branch;
    }
  }
  const next = (open ?? []).filter((i) => CARD_ID.test(String(i)) && !inside.has(i) && !outside[i] && !byBranch.some((b) => b.mine.has(i)));
  return { branch: top.branch, tip: top.sha, members, outside, next };
}
