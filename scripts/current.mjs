// Points the collector's current link at a signed commit (#C223), so a collector change goes out without the owner:
//   node scripts/current.mjs <commit> [--install-root <folder>] [--dry-run]
// Run it from a checkout of this repository. It refuses unless the commit is on origin/main and carries Security's
// SECURE note (refs/notes/security, fetched from origin first). It then pins a copy of the commit
// (<install root>/<full commit>, like scripts/hooks.mjs) and swaps <install root>/../current to it in one rename.
// The scheduled collector runs from the link; the gate, the fence and the settings never do: they stay pinned in the
// settings and change only with the owner's install. It says which of those this commit changes, and whether the
// task's steps (collector/TASK.md) changed, which the lead then saves into the task.
import { realpathSync, existsSync, lstatSync, readlinkSync, symlinkSync, renameSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { pinnedDir, pinCopy } from "./hooks.mjs";

export const NOTES_REF = "refs/notes/security";
// Files that constrain an agent: they take effect only through the owner's install (scripts/hooks.mjs, the settings).
export const OWNER_INSTALLS = [/^gate\//, /^collector\/fence\.mjs$/, /^collector\/refresh\.mjs$/, /^scripts\/hooks\.mjs$/, /^scripts\/config\.mjs$/];
export const TASK_FILE = "collector/TASK.md";

// The verdict on a move, from the facts only: { ok, reason } or { ok, ownerFiles, taskChanged }.
export function judge({ onMain, note, changed }) {
  if (!onMain) return { ok: false, reason: "not on origin/main: merge it first" };
  if (!/^SECURE\b/.test(String(note ?? "").split("\n")[0].trim())) return { ok: false, reason: `no SECURE note on it in ${NOTES_REF}: Security signs first` };
  const files = changed ?? [];
  return { ok: true, ownerFiles: files.filter((f) => OWNER_INSTALLS.some((re) => re.test(f))), taskChanged: files.includes(TASK_FILE) };
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

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (name) => { const n = args.indexOf(name); return n >= 0 ? args[n + 1] : undefined; };
  const commit = args[0];
  if (!commit || commit.startsWith("--")) { console.error("Usage: node scripts/current.mjs <commit> [--install-root <folder>] [--dry-run]"); process.exit(2); }
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const git = (a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const quiet = (a) => { try { return git(a); } catch { return null; } };
  const root = resolve(opt("--install-root") ?? resolve(homedir(), ".flight-board", "install"));
  const link = join(dirname(root), "current");
  try {
    git(["fetch", "-q", "origin"]);
    git(["fetch", "-q", "origin", `+${NOTES_REF}:refs/notes/flight-board-current/security`]);
    const { sha, dir } = pinnedDir(repo, commit, root);
    const before = linkedCommit(link);
    const onMain = quiet(["merge-base", "--is-ancestor", sha, "origin/main"]) !== null;
    const note = quiet(["notes", "--ref=flight-board-current/security", "show", sha]);
    const changed = before && quiet(["cat-file", "-e", `${before}^{commit}`]) !== null ? (quiet(["diff", "--name-only", before, sha]) ?? "").split("\n").filter(Boolean) : null;
    const v = judge({ onMain, note, changed });
    if (!v.ok) { console.error(`Not moved: ${sha.slice(0, 12)} is ${v.reason}.`); process.exit(1); }
    if (args.includes("--dry-run")) console.log(`Dry run: would point ${link} at ${dir}.`);
    else { pinCopy(repo, sha, root); swapLink(link, dir); console.log(`current: ${before ? before.slice(0, 12) : "none"} → ${sha.slice(0, 12)} (${dir}). The next collector run uses it.`); }
    if (changed === null) console.log("No earlier link to compare with: check by hand whether the task's steps or the owner's files changed.");
    else {
      if (v.taskChanged) console.log(`${TASK_FILE} changed: the lead saves the new steps into the scheduled task.`);
      if (v.ownerFiles.length) console.log(`The gate's hooks, the fence and the refresh hook keep their pinned copy until the owner's install: ${v.ownerFiles.join(", ")} changed.`);
    }
  } catch (e) { console.error(`Not moved: ${e.message}`); process.exit(1); }
}
