// Writes the context keeper's prompt into its scheduled task (#C413, one-click packs; Security's six conditions): the
// owner's v3.20 paste didn't save, so an install pack now writes it, run from the owner's own terminal, never by an agent.
//   node scripts/keeper-write.mjs <skill> <prompt file> <prompt file's sha256> <backup suffix>
// skill: ~/.claude/scheduled-tasks/<task>/SKILL.md (that shape only, and no symlink anywhere on the way: its realpath
// must be the very path). In order, each failure a "STOP: …" line, exit 1, nothing written:
//   1. the prompt file is the one the pack names (its sha256); the task's file is a regular file of at most 64 KB;
//   2. the task's front matter (from the first line "---" to the next, inclusive) is kept byte for byte; only the body
//      after it is replaced by the prompt (none found: STOP);
//   3. a backup <skill><suffix> is kept (once: a re-run keeps the first); the new file is written beside it with mode 0644
//      and renamed over the task's file, but only if the task's file still hashes as it did when read;
//   4. read back, its prompt is the pack's by #C407's promptSha: "keeper prompt: ok", else "keeper prompt: paste pending".
// The app must not hold the task's Edit form open meanwhile (it could save over the file): the steps say so.
import { realpathSync, writeFileSync, renameSync, rmSync, existsSync, copyFileSync, chmodSync, openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_PATH, MAX_SKILL, promptSha } from "../collector/keeper.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const FRONT = /^---\n[\s\S]*?\n---\n/;

function readRegular(path, max) {
  let fd = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(max + 1);
    let n = 0, got;
    while ((got = readSync(fd, buf, n, buf.length - n, null)) > 0) { n += got; if (n > max) return null; }
    return buf.subarray(0, n);
  } catch { return null; } finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
}

// Returns { ok, lines }: ok false with a STOP line, or the result line(s).
// between: called after the new file is written and before the task's file is read again (tests change it there).
export function writeKeeper({ skill, prompt, promptFileSha, suffix, home = homedir(), between = () => {} }) {
  const stop = (why) => ({ ok: false, lines: [`STOP: ${why}; nothing written`] });
  if (!SKILL_PATH.test(String(skill ?? ""))) return stop(`${skill} is not ~/.claude/scheduled-tasks/<task>/SKILL.md`);
  if (!/^\.[A-Za-z0-9._-]{1,40}$/.test(String(suffix ?? ""))) return stop("the backup suffix is not like .before-v321");
  if (!/^[0-9a-f]{64}$/.test(String(promptFileSha ?? ""))) return stop("no prompt sha256 given");
  const promptBytes = readRegular(prompt, MAX_SKILL);
  if (!promptBytes || sha(promptBytes) !== promptFileSha) return stop(`${prompt} is not the pack's prompt (its sha256 differs, or it can't be read)`);
  const path = join(home, String(skill).slice(2));
  let real;
  try { real = realpathSync(path); } catch { return stop(`${skill} doesn't exist: save the keeper task once in the app first`); }
  if (real !== path) return stop(`${skill} is reached through a symlink`);
  const before = readRegular(real, MAX_SKILL);
  if (!before) return stop(`${skill} is not a regular file of at most 64 KB`);
  const text = before.toString("utf8");
  const front = FRONT.exec(text);
  if (!front) return stop(`${skill} has no front matter`);
  const body = promptBytes.toString("utf8").replace(/\r\n?/g, "\n").trim();
  const next = Buffer.from(`${front[0]}\n${body}\n`, "utf8");
  if (next.length > MAX_SKILL) return stop("the new prompt would be over 64 KB");
  const backup = real + suffix;
  if (!existsSync(backup)) copyFileSync(real, backup);
  const tmp = join(dirname(real), `.${basename(real)}.${process.pid}.tmp`);
  writeFileSync(tmp, next, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  between();
  const now = readRegular(real, MAX_SKILL);
  if (!now || sha(now) !== sha(before)) { rmSync(tmp, { force: true }); return stop(`${skill} changed while this ran (is its Edit form open in the app?)`); }
  renameSync(tmp, real);
  const after = readRegular(real, MAX_SKILL);
  const ok = !!after && promptSha(after.toString("utf8")) === promptSha(body);
  return { ok: true, lines: [ok ? "keeper prompt: ok" : "keeper prompt: paste pending", `keeper backup: ${backup}`] };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [skill, prompt, promptFileSha, suffix] = process.argv.slice(2);
  const r = writeKeeper({ skill, prompt, promptFileSha, suffix });
  for (const l of r.lines) console.log(l);
  process.exit(r.ok ? 0 : 1);
}
