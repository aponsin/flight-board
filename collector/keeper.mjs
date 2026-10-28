// The context keeper's prompt check (#C407): the owner's v3.20 keeper paste didn't save, and nothing noticed. Each run
// reads the keeper task's saved SKILL.md (collector.keeper.skill, the one path; node's own read, its text never leaves
// this file), drops the front matter the app adds, and compares the trimmed prompt's sha256 with the one the owner's
// install shipped (collector.keeper.promptSha256). Only { ok, at } goes to derived/all; the page shows the owner a red
// line with the command that copies the prompt file, built from the page's own config.
import { createHash } from "node:crypto";
import { basename } from "node:path";

// The prompt as the task holds it: without the "---" front matter block, line ends as \n, trimmed.
export function promptBody(text) {
  const s = String(text ?? "").replace(/\r\n?/g, "\n");
  const m = /^---\n[\s\S]*?\n---\n/.exec(s);
  return (m ? s.slice(m[0].length) : s).trim();
}

export const promptSha = (text) => createHash("sha256").update(promptBody(text), "utf8").digest("hex");

// read: (path) => text, throwing when there's no such file. Returns null when the check is off or the file can't be read
// (no task saved yet is the install's to say), else { ok, at }.
export function keeperCheck(config, read, now) {
  const k = config.collector.keeper ?? {};
  if (!k.skill || !k.prompt || !k.promptSha256) return null;
  let text;
  try { text = read(k.skill); } catch { return null; }
  return { ok: promptSha(text) === k.promptSha256, at: now };
}

// The lead's line when it doesn't match: fixed text and the prompt file's own name (the config's, never the task's).
export function keeperLine(config, check) {
  if (!check || check.ok) return null;
  const file = basename(config.collector.keeper.prompt);
  return `KEEPER the context keeper's saved prompt isn't the installed one: the owner pastes ${file} into the keeper task and saves (the board shows the command that copies it)`;
}
