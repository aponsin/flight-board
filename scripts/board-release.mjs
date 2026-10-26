// A board release by the release role, like a product release (#C276). It runs only from the signed linked copy:
//   node ~/.flight-board/current/scripts/board-release.mjs <commit> [--dry-run]
// never from a checkout, whose files are unreviewed working tree. Everything else comes from the owner's install: the
// config from the gate's pinned hook in ~/.claude/settings.json, the lead's session from the fence's --send-to in the
// collector's settings, the repository from ~/Documents/Code/flight-board ($FLIGHT_BOARD_REPO to change it). The
// target's files are read from its own snapshot (git archive of the commit), never from a checkout.
// Before anything changes it checks, and refuses naming why (one summary line per check, exit 1, nothing pushed):
//   - Checker's PASS and Security's SECURE on this exact commit, read only from origin's notes fetched into private refs;
//   - the commit continues origin/main (the push is a fast-forward, never forced);
//   - nothing the owner's install pins changed since the commit the settings pin: the gate's hooks, the refresh hook,
//     the fence, the memory hook, this release tool and every file they import (importClosure), and collector/TASK.md's
//     settings block. Those stay the owner's install;
//   - the task's steps didn't change without its prompt (collector/PROMPT.txt);
//   - the page uses no capability beyond PAGE_CAPABILITIES, builds and passes its rendered scenarios.
// Then it runs the scan (this copy's), pushes the commit to origin/main, moves the collector's current link with this
// copy's scripts/current.mjs, and prints what the release role publishes: the page, and the prompt when it changed.
// It never touches ~/.claude/settings.json, the collector's settings or the config.
import { realpathSync, existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { OWNER_ENTRIES, TASK_FILE, importClosure, pinnedCommit, linkedCommit } from "./current.mjs";
import { checkConfig, fullConfig, boardId } from "./config.mjs";

export const NOTES = { security: "refs/notes/security", checker: "refs/notes/checker" };
// The release tool and what it runs are the owner's too (Security): a release can't loosen the next one.
export const RELEASE_ENTRIES = ["scripts/board-release.mjs", "scripts/current.mjs", "scripts/scan.mjs"];
// The capabilities the board page is published with; a new one is the owner's (README, "The page").
export const PAGE_CAPABILITIES = ["db", "comments", "assets", "downloads"];
export const PROMPT_FILE = "collector/PROMPT.txt";
const PAGE_FILE = "page/board.template.html";

// collector/TASK.md's settings block (the collector's settings.local.json, the owner's) and its steps (the task's
// prompt, the release role's), read apart so a change to one never passes for the other.
export const settingsBlock = (text) => /```json\n([\s\S]*?)\n\s*```/.exec(String(text ?? ""))?.[1] ?? "";
export const stepsOf = (text) => { const t = String(text ?? ""), at = t.indexOf("\n## The steps"); return at < 0 ? "" : t.slice(at); };
// The capabilities a page asks for: every claude.use("<name>"). A use whose name the scan can't read (a variable, a
// template, claude["use"]) counts as a name the page computes, which no list holds, so it refuses (Checker). The
// publish call's declaration is the real limit; this keeps a release from widening it unseen.
export const COMPUTED = "(a name the page computes)";
export function pageCapabilities(html) {
  const s = String(html ?? "");
  const named = [...s.matchAll(/claude\.use\s*\(\s*["'`]([A-Za-z0-9_-]+)["'`]\s*\)/g)].map((m) => m[1]);
  const uses = [...s.matchAll(/claude\s*(?:\.\s*use|\[\s*["'`]use["'`]\s*\])\s*\(/g)].length;
  return [...new Set([...named, ...(uses > named.length ? [COMPUTED] : [])])].sort();
}
// The task's prompt: the repository's template with this team's values. A placeholder left over, or an empty value, refuses.
export function renderPrompt(template, values) {
  const text = String(template).replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => { if (!values[k]) throw new Error(`${PROMPT_FILE}: no value for {{${k}}}`); return values[k]; });
  const left = /\{\{([^}]*)\}\}/.exec(text);
  if (left) throw new Error(`${PROMPT_FILE}: no value for {{${left[1]}}}`);
  return text;
}
// The config the owner installed: the gate's pinned hook names it. The lead: the collector's fence sends only to it.
export const configFromSettings = (text) => /gate\/gate\.mjs'? --config '([^']+)'/.exec(String(text ?? ""))?.[1] ?? null;
export const leadFromSettings = (text) => /collector\/fence\.mjs'? [^"]*?--send-to ([A-Za-z0-9_-]{1,100})/.exec(String(text ?? ""))?.[1] ?? null;

// The verdict, from the facts only. changed: the files that differ from the pinned commit (null: no pinned commit);
// owned: the owner's closure (OWNER_ENTRIES and RELEASE_ENTRIES) at the pinned commit and at this one.
export function verdict({ forward, notes, pinned, changed, owned, settingsChanged, stepsChanged, promptChanged, capabilities }) {
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
  if (stepsChanged && !promptChanged) r.push(`${TASK_FILE}: the task's steps changed but ${PROMPT_FILE} didn't`);
  const extra = (capabilities ?? []).filter((c) => !PAGE_CAPABILITIES.includes(c));
  if (extra.length) r.push(`the page asks for a capability beyond ${PAGE_CAPABILITIES.join(", ")}: ${extra.join(", ")} (a new capability is the owner's)`);
  return { ok: r.length === 0, refusals: r, promptNeeded: Boolean(promptChanged) };
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const home = (p) => String(p).replace(/^~(?=\/|$)/, homedir());

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2), commit = args[0], dry = args.includes("--dry-run");
  if (!commit || !/^[0-9a-f]{40}$/.test(commit) || args.some((a, n) => n > 0 && a !== "--dry-run")) {
    console.error("Usage: node ~/.flight-board/current/scripts/board-release.mjs <full commit> [--dry-run]"); process.exit(2);
  }
  const self = dirname(fileURLToPath(import.meta.url)); // this signed copy's scripts/
  const repo = process.env.FLIGHT_BOARD_REPO || join(homedir(), "Documents/Code/flight-board");
  const git = (a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
  const quiet = (a) => { try { return git(a); } catch { return null; } };
  const line = (ok, what) => console.log(`${ok ? "ok  " : "NO  "} ${what}`);
  let tmp = null;
  try {
    // The owner's install: the settings, the config the gate's hook names, the lead the fence sends to.
    const settingsText = readFileSync(join(homedir(), ".claude/settings.json"), "utf8");
    const configPath = configFromSettings(settingsText);
    if (!configPath) throw new Error("no config named by the gate's hook in ~/.claude/settings.json");
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    const problems = checkConfig(raw);
    if (problems.length) throw new Error(`the config: ${problems.join("; ")}`);
    const config = fullConfig(raw);
    const stateDir = join(home(config.gate.stateDir), boardId(config) ?? "no-board");
    const collectorSettings = join(stateDir, ".claude/settings.local.json");
    const lead = leadFromSettings(existsSync(collectorSettings) ? readFileSync(collectorSettings, "utf8") : "");
    const link = join(homedir(), ".flight-board", "current"), before = linkedCommit(link);

    // The facts, from origin and from the commit's own snapshot.
    git(["fetch", "-q", "origin"]);
    for (const [who, ref] of Object.entries(NOTES)) quiet(["fetch", "-q", "origin", `+${ref}:refs/notes/board-release/${who}`]);
    const sha = git(["rev-parse", "--verify", `${commit}^{commit}`]);
    const main = git(["rev-parse", "origin/main"]);
    const notes = Object.fromEntries(Object.keys(NOTES).map((who) => [who, quiet(["notes", `--ref=board-release/${who}`, "show", sha])]));
    const forward = quiet(["merge-base", "--is-ancestor", main, sha]) !== null;
    const pinned = pinnedCommit(settingsText);
    const known = (c) => Boolean(c) && quiet(["cat-file", "-e", `${c}^{commit}`]) !== null;
    tmp = mkdtempSync(join(tmpdir(), "board-release-"));
    execFileSync("tar", ["-x", "-C", tmp], { input: execFileSync("git", ["archive", "--format=tar", sha], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }) });
    // A file as it is at a commit, byte for byte (never trimmed, or every comparison with the snapshot would differ).
    const shown = (c, f) => { try { return execFileSync("git", ["show", `${c}:${f}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }); } catch { return null; } };
    const at = (c) => (f) => (c === sha ? (existsSync(join(tmp, f)) ? readFileSync(join(tmp, f), "utf8") : null) : shown(c, f));
    const entries = [...OWNER_ENTRIES, ...RELEASE_ENTRIES];
    const changed = known(pinned) ? (quiet(["diff", "--name-only", pinned, sha]) ?? "").split("\n").filter(Boolean) : null;
    const owned = [...new Set([...importClosure(entries, at(sha)), ...(known(pinned) ? importClosure(entries, at(pinned)) : [])])];
    const base = known(before) ? before : known(pinned) ? pinned : null; // what the task runs now
    const capabilities = pageCapabilities(at(sha)(PAGE_FILE));
    const v = verdict({
      forward, notes, pinned: known(pinned) ? pinned : null, changed, owned, capabilities,
      settingsChanged: known(pinned) && settingsBlock(at(pinned)(TASK_FILE)) !== settingsBlock(at(sha)(TASK_FILE)),
      stepsChanged: base !== null && stepsOf(at(base)(TASK_FILE)) !== stepsOf(at(sha)(TASK_FILE)),
      promptChanged: base === null || at(base)(PROMPT_FILE) !== at(sha)(PROMPT_FILE),
    });

    // The prompt and the page, both from the commit's snapshot, before anything leaves.
    const out = dirname(configPath);
    const prompt = renderPrompt(at(sha)(PROMPT_FILE) ?? "", { CONFIG: configPath, BOARD: config.artifactUrl, LEAD_ROLE: config.gate.managerRole, LEAD: lead, CURRENT: link, OUT: home(config.collector.outDir) });
    const page = join(out, `board-${sha.slice(0, 7)}.html`), promptPath = join(out, `collector-prompt-${sha.slice(0, 7)}.txt`);
    let built = true;
    if (v.ok) {
      try { execFileSync(process.execPath, [join(tmp, "scripts/build-page.mjs"), configPath, page], { stdio: ["ignore", "pipe", "pipe"] }); }
      catch (e) { built = false; v.refusals.push(`the page didn't build: ${String(e.stderr ?? e.message).trim().split("\n")[0]}`); }
    }

    line(!v.refusals.some((r) => /PASS|SECURE/.test(r)), `sign-offs on ${sha}: Checker "${String(notes.checker ?? "none").split("\n")[0]}", Security "${String(notes.security ?? "none").split("\n")[0]}"`);
    line(forward, `continues origin/main ${main.slice(0, 12)}`);
    line(!v.refusals.some((r) => /owner's install|settings block|no pinned/.test(r)), `nothing pinned changed since ${pinned ? pinned.slice(0, 12) : "(none)"}`);
    line(!v.refusals.some((r) => /PROMPT/.test(r)), v.promptNeeded ? `prompt changed: ${promptPath} (SHA-256 ${sha256(prompt)})` : "prompt unchanged");
    line(!v.refusals.some((r) => /capabilit/.test(r)), `page capabilities: ${capabilities.join(", ")}`);
    if (v.ok) line(built, built ? `page built and its scenarios pass: ${page} (SHA-256 ${sha256(readFileSync(page))})` : "page not built");
    if (v.refusals.length) { console.error(`Not released: ${sha.slice(0, 12)}\n- ${v.refusals.join("\n- ")}\nNothing changed. What the owner's install pins goes out with the owner's install, not this.`); process.exit(1); }
    if (v.promptNeeded) writeFileSync(promptPath, prompt);
    if (dry) { console.log(`Dry run: ${sha.slice(0, 12)} passes every check; nothing pushed, the link not moved.`); process.exit(0); }

    // Out: this copy's scan of what leaves, the push (a fast-forward; the checkout's own hooks never run), the link.
    execFileSync(process.execPath, [join(self, "scan.mjs"), "--pre-push", "origin"], { cwd: repo, input: `refs/heads/main ${sha} refs/heads/main ${main}\n`, stdio: ["pipe", "inherit", "inherit"] });
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "push", "-q", "origin", `${sha}:refs/heads/main`], { cwd: repo, stdio: ["ignore", "inherit", "inherit"] });
    execFileSync(process.execPath, [join(self, "current.mjs"), sha, "--repo", repo], { stdio: "inherit" });
    if (linkedCommit(link) !== sha) throw new Error(`main is ${sha.slice(0, 12)} but the current link is not: tell the lead`);
    console.log(`Released ${sha.slice(0, 12)} to flight-board main; the collector's next run uses it.`);
    console.log(`Page: ${page}. Republish it as the board, with exactly the capabilities ${PAGE_CAPABILITIES.join(", ")}.`);
    if (v.promptNeeded) console.log(`Prompt: ${promptPath}. Save it into the task: update_scheduled_task ${config.collector.refresh.taskId}, the prompt set to the whole file.`);
    else console.log("Prompt: unchanged; the task stays as it is.");
  } catch (e) { console.error(`Not released: ${String(e.message).split("\n")[0]}`); process.exit(1); }
  finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
}
