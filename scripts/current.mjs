// Points the collector's current link at a signed commit (#C223), so a collector change goes out without the owner:
//   node scripts/current.mjs <commit> [--install-root <folder>] [--settings <file>] [--dry-run]
// Run it from a checkout of this repository. It refuses unless the commit is on origin/main and carries Security's
// SECURE note (refs/notes/security, fetched from origin first). It then pins a copy of the commit
// (<install root>/<full commit>, like scripts/hooks.mjs; a copy already there must be exactly the commit) and swaps
// <install root>/../current to it in one rename. A SECURE note is a process, not an identity: any session that can push
// may write one, so what gates a collector change is Security's review of the commit.
// The scheduled collector runs from the link; the gate, the fence and the settings never do: they stay pinned in the
// settings and change only with the owner's install. It says which of those this commit changes, and whether the
// task's steps (collector/TASK.md) changed, which the lead then saves into the task.
import { realpathSync, existsSync, lstatSync, readlinkSync, symlinkSync, renameSync, rmSync, readdirSync, readFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join, basename, posix } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { pinnedDir } from "./hooks.mjs";

export const NOTES_REF = "refs/notes/security";
// What the owner's install runs, pinned in the settings: the gate's hooks, the refresh hook and the fence. Everything
// they import (importClosure) waits for the owner's install too; the rest moves with the link (Security).
export const OWNER_ENTRIES = ["gate/gate.mjs", "gate/after.mjs", "gate/stop.mjs", "collector/refresh.mjs", "collector/fence.mjs", "scripts/hooks.mjs"];
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

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (name) => { const n = args.indexOf(name); return n >= 0 ? args[n + 1] : undefined; };
  const commit = args[0];
  if (!commit || commit.startsWith("--")) { console.error("Usage: node scripts/current.mjs <commit> [--install-root <folder>] [--settings <file>] [--dry-run]"); process.exit(2); }
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
    if (fromPin === null) console.log("No pinned commit found in the settings to compare with: check by hand whether the owner's files changed.");
    else if (v.ownerFiles.length) console.log(`The gate's hooks, the fence and the refresh hook keep the owner's pinned copy (${pinned.slice(0, 12)}) until the owner's install; changed since: ${v.ownerFiles.join(", ")}.`);
    if ((fromLink ?? []).includes(TASK_FILE)) console.log(`${TASK_FILE} changed: the lead saves the new steps into the scheduled task.`);
  } catch (e) { console.error(`Not moved: ${e.message}`); process.exit(1); }
}
