// The board's hook entries for Claude Code's settings (~/.claude/settings.json): PreToolUse on board writes and
// hand-off messages, PostToolUse after them, Stop on the lead's replies (the gate's check, then the collector on demand),
// UserPromptSubmit on the lead's prompts (the digest).
// Printed by default; written only with --write, which keeps every other entry and replaces an older flight-board one.
// Usage: node scripts/hooks.mjs <board.config.json> --pin <signed commit> [--write] [--retire <text>]... [--settings <file>]
// [--install-root <folder>]. Run it from a checkout of that commit: the entries it writes are this file's.
import { realpathSync } from "node:fs";
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// A flight-board hook, from this checkout or a pinned copy: replaced on every install.
const MARK = /(?:flight-board|\/[0-9a-f]{40})\/(?:gate\/(?:gate|stop|after|digest|publish)|collector\/refresh)\.mjs/;
// A path as one shell word, in single quotes (a ' inside written '\''): sh expands nothing in it, so a folder with a
// space ("Application Support") or a crafted name with $( ) or backticks stays a plain path.
export const shellQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const q = shellQuote;
export function hookEntries(repo, configPath, node = process.execPath) {
  const cmd = (file, dir = "gate") => `${q(node)} ${q(resolve(repo, dir, file))} --config ${q(resolve(configPath))}`;
  return {
    // Artifact too: the lead's publish of exactly the signed board page goes without asking (#C409, gate/publish.mjs);
    // each hook answers only its own tools.
    PreToolUse: { matcher: "ArtifactData|SendMessage|mcp__ccd_session_mgmt__send_message|Artifact", hooks: [{ type: "command", command: cmd("gate.mjs") }, { type: "command", command: cmd("publish.mjs") }] },
    // After a board write the board applied: what the gate must remember from it (the thread counter).
    PostToolUse: { matcher: "ArtifactData", hooks: [{ type: "command", command: cmd("after.mjs") }] },
    // The lead's turn end: the gate's checks, then "start the collector now" when a card moved since its last run.
    Stop: { hooks: [{ type: "command", command: cmd("stop.mjs") }, { type: "command", command: cmd("refresh.mjs", "collector") }] },
    // The lead's turn start: one line of the mechanical messages logged since its last prompt (#C335).
    UserPromptSubmit: { hooks: [{ type: "command", command: cmd("digest.mjs") }] },
  };
}

// settings with the gate's entries in. Every hook whose command holds one of `retire` (an older board gate) goes, and an
// older flight-board entry is replaced; everything else is kept as it was. Returns { settings, added, replaced, retired }.
export function withHooks(settings, entries, retire = []) {
  const out = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const replaced = [], retired = [];
  for (const event of Object.keys(out.hooks)) {
    out.hooks[event] = (out.hooks[event] ?? []).map((e) => {
      const hooks = (e.hooks ?? []).filter((h) => {
        const c = String(h.command ?? "");
        if (MARK.test(c)) { replaced.push(`${event}: ${c}`); return false; }
        if (retire.some((r) => r && c.includes(r))) { retired.push(`${event}: ${c}`); return false; }
        return true;
      });
      return hooks.length === (e.hooks ?? []).length ? e : { ...e, hooks };
    }).filter((e) => (e.hooks ?? []).length);
  }
  for (const [event, entry] of Object.entries(entries)) out.hooks[event] = [...(out.hooks[event] ?? []), entry];
  return { settings: out, added: Object.keys(entries), replaced, retired };
}

// The hooks run a pinned copy of one signed commit, never a checkout someone is editing: <root>/<full sha>, exported
// with git archive (made once; reused by a later install of the same commit). Upgrading = installing a newer signed sha.
export function pinnedDir(repo, commit, root) {
  let sha = "";
  try { sha = execFileSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${commit}^{commit}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* not found */ }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit: ${commit}`);
  return { sha, dir: resolve(root, sha) };
}
export function pinCopy(repo, commit, root) {
  const { sha, dir } = pinnedDir(repo, commit, root);
  if (existsSync(resolve(dir, "gate", "gate.mjs"))) return dir;
  const tmp = `${dir}.part`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  execFileSync("tar", ["-x", "-C", tmp], { input: execFileSync("git", ["archive", "--format=tar", sha], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }) });
  renameSync(tmp, dir);
  return dir;
}

// "Added …; replaced …; retired …" in one line, for the person who ran it.
export function summary({ added, replaced, retired }, backup) {
  const list = added.length > 1 ? `${added.slice(0, -1).join(", ")} and ${added.at(-1)}` : added.join("");
  const parts = [`added the gate to ${list}`];
  if (replaced.length) parts.push(`replaced ${replaced.length} older flight-board entr${replaced.length > 1 ? "ies" : "y"}`);
  parts.push(retired.length ? `retired ${retired.length}: ${retired.join("; ")}` : "retired nothing");
  return `Changed: ${parts.join("; ")}.${backup ? ` Backup: ${backup}` : ""}`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const configPath = args[0];
  const opt = (name) => { const n = args.indexOf(name); return n > 0 ? args[n + 1] : undefined; };
  const retire = args.flatMap((a, n) => (args[n - 1] === "--retire" ? [a] : []));
  const target = resolve(opt("--settings") ?? resolve(homedir(), ".claude/settings.json"));
  const pin = opt("--pin");
  if (!configPath || configPath.startsWith("--") || !pin) { console.error("Usage: node scripts/hooks.mjs <board.config.json> --pin <signed commit> [--write] [--retire <text in an old hook's command>]... [--settings <file>] [--install-root <folder>]"); process.exit(2); }
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const root = resolve(opt("--install-root") ?? resolve(homedir(), ".flight-board", "install"));
  let pinned;
  try { pinned = pinnedDir(repo, pin, root); } catch (e) { console.error(e.message); process.exit(1); }
  const entries = hookEntries(pinned.dir, configPath);
  const settings = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : {};
  const result = withHooks(settings, entries, retire);
  if (!args.includes("--write")) {
    console.log(JSON.stringify({ hooks: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, [v]])) }, null, 2));
    console.log(`\n${summary(result, null).replace(/^Changed:/, "Dry run, nothing written. With --write it would change this:")} File: ${target}. Hooks would run the copy of ${pinned.sha.slice(0, 12)} at ${pinned.dir}.`);
    process.exit(0);
  }
  pinCopy(repo, pinned.sha, root);
  const backup = existsSync(target) ? `${target}.before-flight-board-${Date.now()}` : null;
  if (backup) copyFileSync(target, backup);
  writeFileSync(target, JSON.stringify(result.settings, null, 2) + "\n");
  console.log(`${summary(result, backup)} Hooks run the copy of ${pinned.sha.slice(0, 12)} at ${pinned.dir}.`);
}
