// The context keeper's prompt check (#C407): the owner's v3.20 keeper paste didn't save, and nothing noticed. Each run
// reads the keeper task's saved SKILL.md (collector.keeper.skill, the one path; node's own read, its text never leaves
// this file), drops the front matter the app adds, and compares the trimmed prompt's sha256 with the one the owner's
// install shipped (collector.keeper.promptSha256). Only { ok, at } goes to derived/all; the page shows the owner a red
// line with the command that copies the prompt file, built from the page's own config.
// Security's conditions: the file read must be, after realpath, a regular file of at most 64 KB at
// ~/.claude/scheduled-tasks/<name>/SKILL.md, opened read only and non-blocking. Anything else (a symlink out, a device,
// a FIFO, too big, unreadable) is "can't tell": nothing reported, so the check is no probe of other files.
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { realpathSync, openSync, fstatSync, readSync, closeSync, constants } from "node:fs";

export const MAX_SKILL = 64 * 1024;
export const SKILL_PATH = /^~\/\.claude\/scheduled-tasks\/[a-z0-9-]{1,60}\/SKILL\.md$/;
export const PROMPT_PATH = /^~\/(?:[A-Za-z0-9._-]{1,80}\/){0,6}[A-Za-z0-9._-]{1,80}\.txt$/;

// The prompt as the task holds it: without the "---" front matter block, line ends as \n, trimmed.
export function promptBody(text) {
  const s = String(text ?? "").replace(/\r\n?/g, "\n");
  const m = /^---\n[\s\S]*?\n---\n/.exec(s);
  return (m ? s.slice(m[0].length) : s).trim();
}

export const promptSha = (text) => createHash("sha256").update(promptBody(text), "utf8").digest("hex");

const expand = (p, home) => String(p).replace(/^~(?=\/)/, home);

// The task's saved prompt text, or null when it isn't a regular file of at most MAX_SKILL bytes inside
// <home>/.claude/scheduled-tasks/<name>/SKILL.md after realpath.
export function readSkill(skill, home = homedir()) {
  if (!SKILL_PATH.test(String(skill ?? ""))) return null;
  let fd = null;
  try {
    const base = realpathSync(join(home, ".claude", "scheduled-tasks"));
    const real = realpathSync(expand(skill, home));
    if (!/^[a-z0-9-]{1,60}\/SKILL\.md$/.test(relative(base, real).split(sep).join("/"))) return null;
    fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_SKILL) return null;
    const buf = Buffer.alloc(MAX_SKILL + 1);
    let n = 0, got;
    while ((got = readSync(fd, buf, n, buf.length - n, null)) > 0) { n += got; if (n > MAX_SKILL) return null; }
    return buf.subarray(0, n).toString("utf8");
  } catch { return null; } finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
}

// Returns null when the check is off, the prompt file isn't in the config's own folder (configDir, when given), or the
// saved prompt can't be read as above; else { ok, at }.
export function keeperCheck(config, now, { home = homedir(), configDir = null } = {}) {
  const k = config.collector.keeper ?? {};
  if (!k.skill || !k.prompt || !k.promptSha256) return null;
  if (!PROMPT_PATH.test(k.prompt)) return null;
  if (configDir) { let at = null; try { at = realpathSync(dirname(expand(k.prompt, home))); } catch { /* no folder */ } if (at !== configDir) return null; }
  const text = readSkill(k.skill, home);
  return text === null ? null : { ok: promptSha(text) === k.promptSha256, at: now };
}

// keeper/TASK.md's {{WATCHDOG}} (#C411): the step for collector.keeper.watchdog, or "none." without one. The command is
// written exactly as the task's allow rule names it.
export function watchdogStep(config) {
  const w = config.collector.keeper?.watchdog;
  if (!w) return "none.";
  // #C443: between warnings (every 3 h) the script prints "watchdog late, already warned at hh:mm" on each run: that
  // line goes in the run summary only, never as a push.
  return `run exactly (one Bash call, nothing around it) "node ${w.script} ${w.state} ${w.alert}". If it prints a line starting with "watchdog late, already warned", don't push or send it: put that exact line in your run summary. Any other line: send that exact line as ONE PushNotification (status proactive) and, as its own message, to the session titled "Manager". If it prints nothing, put "watchdog on time" in your run summary and go on.`;
}

// The lead's line when it doesn't match: fixed text and the prompt file's own name (the config's, never the task's).
export function keeperLine(config, check) {
  if (!check || check.ok) return null;
  const file = basename(config.collector.keeper.prompt);
  return `KEEPER the context keeper's saved prompt isn't the installed one: the owner pastes ${file} into the keeper task and saves (the board shows the command that copies it)`;
}
