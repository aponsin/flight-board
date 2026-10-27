// Points the collector's current link at a signed commit (#C223), so a collector change goes out without the owner:
//   node scripts/current.mjs <commit> [--repo <checkout>] [--install-root <folder>] [--settings <file>] [--dry-run]
// Run it from a checkout of this repository. It refuses unless the commit is on origin/main and carries Security's
// SECURE note (refs/notes/security, fetched from origin first). It then pins a copy of the commit
// (<install root>/<full commit>, like scripts/hooks.mjs; a copy already there must be exactly the commit) and swaps
// <install root>/../current to it in one rename. A SECURE note is a process, not an identity: any session that can push
// may write one, so what gates a collector change is Security's review of the commit.
// The scheduled collector runs from the link; the gate, the fence and the settings never do: they stay pinned in the
// settings and change only with the owner's install. It says which of those this commit changes, and whether the
// task's steps (collector/TASK.md) changed, which the lead then saves into the task. Last, it fast-forwards the
// checkout's local main to the commit when nobody's work is in the way (fastForwardMain, #C282), and says what it did.
import { realpathSync, existsSync, lstatSync, readlinkSync, symlinkSync, renameSync, rmSync, readdirSync, readFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join, basename, posix } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { pinnedDir } from "./hooks.mjs";

export const NOTES_REF = "refs/notes/security";
// What the owner's install runs, pinned in the settings: the gate's hooks, the refresh hook, the fence and the memory hook. Everything
// they import (importClosure) waits for the owner's install too; the rest moves with the link (Security). The red-ask
// Stop hook (hooks/red-ask-board.py, #C329) runs from the copy an install pack puts in ~/.claude/hooks: the owner's too.
export const OWNER_ENTRIES = ["gate/gate.mjs", "gate/after.mjs", "gate/stop.mjs", "collector/refresh.mjs", "collector/fence.mjs", "collector/context.mjs", "scripts/hooks.mjs", "hooks/red-ask-board.py", "gate/digest.mjs"];
export const TASK_FILE = "collector/TASK.md";

// The files `entries` load, themselves included: every relative static import, followed. read(path) gives a file's
// text, or null when it isn't there. Paths are relative to the repository, with "/".
export function importClosure(entries, read) {
  const seen = new Set(), todo = [...entries];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    const text = read(file);
    if (text == null) continue;
    seen.add(file);
    for (const m of text.matchAll(/^\s*(?:import|export)\b(?:[^;"']*?\bfrom)?\s*["'](\.{1,2}\/[^"']+)["']/gm)) todo.push(posix.normalize(posix.join(posix.dirname(file), m[1])));
  }
  return [...seen].sort();
}

// The verdict on a move, from the facts only: { ok, reason } or { ok, ownerFiles, taskChanged }. owned: the owner's
// install's files (importClosure of OWNER_ENTRIES); changed: the files that differ from the commit the settings pin.
export function judge({ onMain, note, changed, owned = [] }) {
  if (!onMain) return { ok: false, reason: "not on origin/main: merge it first" };
  if (!/^SECURE\b/.test(String(note ?? "").split("\n")[0].trim())) return { ok: false, reason: `no SECURE note on it in ${NOTES_REF}: Security signs first` };
  const files = changed ?? [];
  return { ok: true, ownerFiles: files.filter((f) => owned.includes(f)), taskChanged: files.includes(TASK_FILE) };
}

// The commit the owner's install pins: the one the gate's hook runs from in the settings, or null.
export function pinnedCommit(settingsText) {
  return /install\/([0-9a-f]{40})\/gate\/gate\.mjs/.exec(String(settingsText ?? ""))?.[1] ?? null;
}

// Every regular file under dir (relative path → bytes); anything else (a link, a device) is a difference in itself.
function tree(dir) {
  const out = new Map();
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name, st = lstatSync(join(dir, r));
      if (st.isDirectory()) walk(r);
      else out.set(r, st.isFile() ? readFileSync(join(dir, r)) : null);
    }
  };
  walk("");
  return out;
}
// Whether two folders hold exactly the same files, byte for byte, and nothing else.
export function sameTree(a, b) {
  const x = tree(a), y = tree(b);
  if (x.size !== y.size) return false;
  for (const [k, v] of x) { const w = y.get(k); if (!v || !w || !v.equals(w)) return false; }
  return true;
}

// The link's commit now, or null (no link, or not a link to a pinned copy).
export function linkedCommit(link) {
  try { // readlinkSync throws on anything but a symlink
    const sha = basename(readlinkSync(link));
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch { return null; }
}

// Swaps the link to target in one rename (a reader sees the old copy or the new one, never none). A real folder in its
// place is refused, never removed.
export function swapLink(link, target) {
  if (existsSync(link) && !lstatSync(link).isSymbolicLink()) throw new Error(`${link} is not a link: move it away by hand`);
  const tmp = `${link}.next`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

// The checkout's own main after a push (#C282): installs and board releases push a signed commit to origin/main and
// used to leave local main far behind. The decision, from the facts only: main moves only by a fast-forward (behind:
// main is an ancestor of sha), and only over no one's work: not checked out anywhere, or checked out and clean; never
// in the middle of a rebase, merge or cherry-pick. Anything else is left as it is, and said.
export function localMainMove({ sha, main, behind, contains, checkedOut, clean, busy }) {
  const s = (c) => String(c).slice(0, 12), left = (why) => ({ action: "none", say: `local main: left as it is, ${why}` });
  if (!main) return { action: "none", say: "local main: none (no local main branch); nothing to move" };
  if (main === sha) return { action: "none", say: `local main: already at ${s(sha)}` };
  if (busy) return left(`a worktree is in the middle of a rebase, merge or cherry-pick on it (${s(main)})`);
  if (contains) return { action: "none", say: `local main: ${s(main)} already has ${s(sha)}; left as it is` };
  if (!behind) return left(`it has diverged from ${s(sha)} (${s(main)}): bring it up to date by hand`);
  if (checkedOut && !clean) return left(`${checkedOut} has uncommitted changes on it (${s(main)})`);
  return { action: checkedOut ? "merge" : "ref", say: `local main: ${s(main)} → ${s(sha)} (fast-forward${checkedOut ? ` in ${checkedOut}` : ""})` };
}

// Reads the facts in repo (any worktree of the checkout) and fast-forwards local main to sha when localMainMove says so.
// Returns what it did, as one line; never throws (a push already made stays made whatever happens here).
export function fastForwardMain(repo, sha, { dry = false } = {}) {
  const run = (cwd, a) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const quiet = (cwd, a) => { try { return run(cwd, a); } catch { return null; } };
  try {
    const main = quiet(repo, ["rev-parse", "--verify", "-q", "refs/heads/main^{commit}"]);
    // Every worktree: which has main checked out, and whether any is mid-operation on it.
    const trees = run(repo, ["worktree", "list", "--porcelain"]).split("\n\n").map((b) => ({
      path: /^worktree (.+)$/m.exec(b)?.[1], branch: /^branch (.+)$/m.exec(b)?.[1] ?? null,
    })).filter((t) => t.path && existsSync(t.path));
    const checkedOut = trees.find((t) => t.branch === "refs/heads/main")?.path ?? null;
    const gitPath = (t, p) => quiet(t, ["rev-parse", "--path-format=absolute", "--git-path", p]);
    const headName = (t) => ["rebase-merge/head-name", "rebase-apply/head-name"].map((p) => gitPath(t, p)).filter((f) => f && existsSync(f)).map((f) => readFileSync(f, "utf8").trim());
    const busy = trees.some((t) => headName(t.path).includes("refs/heads/main"))
      || (checkedOut !== null && ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].some((p) => { const f = gitPath(checkedOut, p); return f && existsSync(f); }));
    const clean = checkedOut === null || run(checkedOut, ["status", "--porcelain", "--untracked-files=no"]) === "";
    const behind = Boolean(main) && quiet(repo, ["merge-base", "--is-ancestor", main, sha]) !== null;
    const contains = Boolean(main) && quiet(repo, ["merge-base", "--is-ancestor", sha, main]) !== null;
    const m = localMainMove({ sha, main, behind, contains, checkedOut, clean, busy });
    if (m.action === "none") return m.say;
    if (dry) return `Dry run: would move ${m.say}`;
    // A fast-forward merge in the worktree that has main (it refuses rather than overwrite an untracked file), or the
    // ref alone, moved only from the commit read above.
    if (m.action === "merge") run(checkedOut, ["merge", "--ff-only", "-q", sha]);
    else run(repo, ["update-ref", "-m", `fast-forward to ${sha.slice(0, 12)} after its push`, "refs/heads/main", sha, main]);
    const now = quiet(repo, ["rev-parse", "refs/heads/main"]);
    return now === sha ? m.say : `local main: left as it is, the fast-forward didn't land (it is ${String(now).slice(0, 12)})`;
  } catch (e) {
    return `local main: left as it is, ${String(e.stderr || e.message).trim().split("\n")[0]}`;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (name) => { const n = args.indexOf(name); return n >= 0 ? args[n + 1] : undefined; };
  const commit = args[0];
  if (!commit || commit.startsWith("--")) { console.error("Usage: node scripts/current.mjs <commit> [--repo <checkout>] [--install-root <folder>] [--settings <file>] [--dry-run]"); process.exit(2); }
  // --repo: the checkout to read and fetch from, when this runs from a pinned copy (which has no .git): scripts/board-release.mjs.
  const repo = resolve(opt("--repo") ?? fileURLToPath(new URL("..", import.meta.url)));
  const git = (a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const quiet = (a) => { try { return git(a); } catch { return null; } };
  const root = resolve(opt("--install-root") ?? resolve(homedir(), ".flight-board", "install"));
  const link = join(dirname(root), "current");
  try {
    git(["fetch", "-q", "origin"]);
    git(["fetch", "-q", "origin", `+${NOTES_REF}:refs/notes/flight-board-current/security`]);
    const { sha, dir } = pinnedDir(repo, commit, root);
    const before = linkedCommit(link);
    const settings = resolve(opt("--settings") ?? resolve(homedir(), ".claude/settings.json"));
    const pinned = pinnedCommit(existsSync(settings) ? readFileSync(settings, "utf8") : "");
    const onMain = quiet(["merge-base", "--is-ancestor", sha, "origin/main"]) !== null;
    const note = quiet(["notes", "--ref=flight-board-current/security", "show", sha]);
    const diff = (from) => (from && quiet(["cat-file", "-e", `${from}^{commit}`]) !== null ? (quiet(["diff", "--name-only", from, sha]) ?? "").split("\n").filter(Boolean) : null);
    const show = (at) => (f) => quiet(["show", `${at}:${f}`]);
    const owned = [...new Set([...importClosure(OWNER_ENTRIES, show(sha)), ...(pinned ? importClosure(OWNER_ENTRIES, show(pinned)) : [])])];
    const fromPin = diff(pinned), fromLink = diff(before) ?? fromPin;
    const v = judge({ onMain, note, changed: fromPin, owned });
    if (!v.ok) { console.error(`Not moved: ${sha.slice(0, 12)} is ${v.reason}.`); process.exit(1); }
    // A copy already there is used only when it is exactly the commit (Checker, Security): a folder planted or edited
    // under a signed commit's name is refused, never run.
    mkdirSync(root, { recursive: true }); // a first install has no root yet (Checker)
    const fresh = mkdtempSync(join(root, ".check-"));
    try {
      execFileSync("tar", ["-x", "-C", fresh], { input: execFileSync("git", ["archive", "--format=tar", sha], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }) });
      if (existsSync(dir) && !sameTree(dir, fresh)) throw new Error(`${dir} is not exactly ${sha.slice(0, 12)}: move it away and run this again`);
      if (!existsSync(dir) && !args.includes("--dry-run")) renameSync(fresh, dir); // a dry run writes nothing (Checker)
    } finally { rmSync(fresh, { recursive: true, force: true }); }
    if (args.includes("--dry-run")) console.log(`Dry run: ${existsSync(dir) ? `${dir} is exactly ${sha.slice(0, 12)}` : `would copy ${sha.slice(0, 12)} to ${dir}`}; would point ${link} at it.`);
    else { swapLink(link, dir); console.log(`current: ${before ? before.slice(0, 12) : "none"} → ${sha.slice(0, 12)} (${dir}). The next collector run uses it.`); }
    console.log(fastForwardMain(repo, sha, { dry: args.includes("--dry-run") }));
    if (fromPin === null) console.log("No pinned commit found in the settings to compare with: check by hand whether the owner's files changed.");
    else if (v.ownerFiles.length) console.log(`The gate's hooks, the fence and the refresh hook keep the owner's pinned copy (${pinned.slice(0, 12)}) until the owner's install; changed since: ${v.ownerFiles.join(", ")}.`);
    if ((fromLink ?? []).includes(TASK_FILE)) console.log(`${TASK_FILE} changed: the lead saves the new steps into the scheduled task.`);
  } catch (e) { console.error(`Not moved: ${e.message}`); process.exit(1); }
}
