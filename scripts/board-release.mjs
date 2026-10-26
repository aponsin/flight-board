// A board release by the release role, like a product release (#C276):
//   npm run board-release -- <commit> --config <board.config.json> [--prompt <file>] [--page <out.html>] [--dry-run]
// Run it from a checkout of this repository. Before anything changes it checks, and refuses naming why:
//   - Checker's PASS (refs/notes/checker) and Security's SECURE (refs/notes/security) on this exact commit;
//   - the commit continues origin/main (the push is a fast-forward, never forced);
//   - nothing the owner's install pins changed since the commit the settings pin: the gate's hooks, the refresh hook,
//     the fence, the memory hook and every file they import (importClosure of OWNER_ENTRIES, scripts/current.mjs), and
//     the collector's settings (collector/TASK.md's settings block). Those stay the owner's install;
//   - a prompt file when the task's steps changed;
//   - the page builds from the commit and passes its rendered scenarios.
// Then it pushes the commit to origin/main, moves the collector's current link to it (scripts/current.mjs, which checks
// the note and main again), and prints what the release role saves: the page to republish and, when the steps changed,
// the prompt for the scheduled task. It never touches ~/.claude/settings.json, the collector's settings or the config.
import { realpathSync, existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { OWNER_ENTRIES, TASK_FILE, importClosure, pinnedCommit, linkedCommit } from "./current.mjs";
import { checkConfig, fullConfig } from "./config.mjs";

export const NOTES = { security: "refs/notes/security", checker: "refs/notes/checker" };
// The capabilities the board page is published with (README, "The page").
export const PAGE_CAPABILITIES = ["db", "comments", "assets", "downloads"];

// collector/TASK.md's settings block (the collector's settings.local.json, the owner's) and its steps (the task's
// prompt, the release role's), read apart so a change to one never passes for the other.
export const settingsBlock = (text) => /```json\n([\s\S]*?)\n\s*```/.exec(String(text ?? ""))?.[1] ?? "";
export const stepsOf = (text) => { const t = String(text ?? ""), at = t.indexOf("\n## The steps"); return at < 0 ? "" : t.slice(at); };

// The verdict, from the facts only. changed: the files that differ from the pinned commit (null: no pinned commit);
// owned: the owner's closure at the pinned commit and at this one; settingsChanged / stepsChanged: TASK.md's two parts.
export function verdict({ forward, notes, pinned, changed, owned, settingsChanged, stepsChanged, prompt }) {
  const r = [];
  if (!/^PASS\b/.test(String(notes?.checker ?? "").split("\n")[0].trim())) r.push(`no PASS from Checker on it in ${NOTES.checker}`);
  if (!/^SECURE\b/.test(String(notes?.security ?? "").split("\n")[0].trim())) r.push(`no SECURE from Security on it in ${NOTES.security}`);
  if (!forward) r.push("it doesn't continue origin/main: rebase it on main and sign it again");
  if (!pinned || !Array.isArray(changed)) r.push("no pinned commit found in ~/.claude/settings.json to compare with: the owner's install decides");
  else {
    const mine = changed.filter((f) => owned.includes(f));
    if (mine.length) r.push(`it changes what the owner's install pins (${pinned.slice(0, 12)}): ${mine.join(", ")}`);
  }
  if (settingsChanged) r.push(`${TASK_FILE}: the collector's settings block changed, and those settings are the owner's`);
  if (stepsChanged && !prompt) r.push(`${TASK_FILE}: the task's steps changed: give the new prompt with --prompt <file>`);
  return { ok: r.length === 0, refusals: r, promptNeeded: Boolean(stepsChanged) };
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (name) => { const n = args.indexOf(name); return n >= 0 ? args[n + 1] : undefined; };
  const commit = args[0], configPath = opt("--config");
  if (!commit || commit.startsWith("--") || !configPath) { console.error("Usage: npm run board-release -- <commit> --config <board.config.json> [--prompt <file>] [--page <out.html>] [--dry-run]"); process.exit(2); }
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const git = (a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const quiet = (a) => { try { return git(a); } catch { return null; } };
  const dry = args.includes("--dry-run");
  let tmp = null;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    const problems = checkConfig(raw);
    if (problems.length) throw new Error(`the config: ${problems.join("; ")}`);
    const config = fullConfig(raw);
    git(["fetch", "-q", "origin"]);
    for (const [who, ref] of Object.entries(NOTES)) quiet(["fetch", "-q", "origin", `+${ref}:refs/notes/flight-board-release/${who}`]);
    const sha = git(["rev-parse", "--verify", `${commit}^{commit}`]);
    const notes = Object.fromEntries(Object.keys(NOTES).map((who) => [who, quiet(["notes", `--ref=flight-board-release/${who}`, "show", sha])]));
    const forward = quiet(["merge-base", "--is-ancestor", "origin/main", sha]) !== null;
    const settingsPath = resolve(opt("--settings") ?? join(homedir(), ".claude/settings.json"));
    const pinned = pinnedCommit(existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "");
    const known = (c) => c && quiet(["cat-file", "-e", `${c}^{commit}`]) !== null;
    const show = (at) => (f) => quiet(["show", `${at}:${f}`]);
    const changed = known(pinned) ? (quiet(["diff", "--name-only", pinned, sha]) ?? "").split("\n").filter(Boolean) : null;
    const owned = [...new Set([...importClosure(OWNER_ENTRIES, show(sha)), ...(known(pinned) ? importClosure(OWNER_ENTRIES, show(pinned)) : [])])];
    const link = join(homedir(), ".flight-board", "current"), before = linkedCommit(link);
    const prompt = opt("--prompt") ? resolve(opt("--prompt")) : undefined;
    if (prompt && !existsSync(prompt)) throw new Error(`no prompt file at ${prompt}`);
    const v = verdict({
      forward, notes, pinned: known(pinned) ? pinned : null, changed, owned,
      settingsChanged: known(pinned) && settingsBlock(show(pinned)(TASK_FILE)) !== settingsBlock(show(sha)(TASK_FILE)),
      stepsChanged: stepsOf(show(known(before) ? before : pinned ?? sha)(TASK_FILE)) !== stepsOf(show(sha)(TASK_FILE)),
      prompt,
    });
    if (!v.ok) { console.error(`Not released: ${sha.slice(0, 12)}\n- ${v.refusals.join("\n- ")}\nNothing changed. What the owner's install pins goes out with the owner's install (an install script), not this.`); process.exit(1); }

    // The page, built from the commit itself, only if it passes every rendered scenario (scripts/build-page.mjs).
    tmp = mkdtempSync(join(tmpdir(), "board-release-"));
    execFileSync("tar", ["-x", "-C", tmp], { input: execFileSync("git", ["archive", "--format=tar", sha], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }) });
    const page = resolve(opt("--page") ?? join(dirname(resolve(configPath)), `board-${sha.slice(0, 7)}.html`));
    execFileSync(process.execPath, [join(tmp, "scripts/build-page.mjs"), resolve(configPath), page], { stdio: ["ignore", "pipe", "pipe"] });
    if (dry) { console.log(`Dry run: ${sha.slice(0, 12)} passes every check and its page built (${page}); nothing pushed, the link not moved.`); process.exit(0); }

    // Out: main, then the link (scripts/current.mjs checks main and the SECURE note again, and pins an exact copy).
    execFileSync("git", ["push", "-q", "origin", `${sha}:refs/heads/main`], { cwd: repo, stdio: ["ignore", "inherit", "inherit"] }); // the pre-push scan speaks for itself
    execFileSync(process.execPath, [join(repo, "scripts/current.mjs"), sha], { cwd: repo, stdio: "inherit" });
    if (linkedCommit(link) !== sha) throw new Error(`main is ${sha.slice(0, 12)} but the current link is not: run node scripts/current.mjs ${sha} and tell the lead`);
    console.log(`Released ${sha.slice(0, 12)} to flight-board main; the collector's next run uses it.`);
    console.log(`Page: ${page} (SHA-256 ${sha256(page)}). Republish it as the board, with the capabilities ${PAGE_CAPABILITIES.join(", ")}.`);
    if (v.promptNeeded) console.log(`Prompt: ${prompt} (SHA-256 ${sha256(prompt)}). Save it into the task: update_scheduled_task ${config.collector.refresh.taskId}, the prompt set to the whole file.`);
    else console.log("Prompt: the task's steps didn't change; the task stays as it is.");
  } catch (e) { console.error(`Not released: ${e.message}`); process.exit(1); }
  finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
}
