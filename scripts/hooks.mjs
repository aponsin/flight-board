// The gate's hook entries for Claude Code's settings (~/.claude/settings.json): PreToolUse on board writes and
// hand-off messages, Stop on the lead's replies. Printed by default; written only with --write, which keeps every other
// entry and replaces an older flight-board one. Usage: node scripts/hooks.mjs <board.config.json> [--write [settings.json]]
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const MARK = "flight-board/gate/";
// A path as one shell word, in single quotes (a ' inside written '\''): sh expands nothing in it, so a folder with a
// space ("Application Support") or a crafted name with $( ) or backticks stays a plain path.
export const shellQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const q = shellQuote;
export function hookEntries(repo, configPath, node = process.execPath) {
  const cmd = (file) => `${q(node)} ${q(resolve(repo, "gate", file))} --config ${q(resolve(configPath))}`;
  return {
    PreToolUse: { matcher: "ArtifactData|SendMessage|mcp__ccd_session_mgmt__send_message", hooks: [{ type: "command", command: cmd("gate.mjs") }] },
    Stop: { hooks: [{ type: "command", command: cmd("stop.mjs") }] },
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
        if (c.includes(MARK)) { replaced.push(`${event}: ${c}`); return false; }
        if (retire.some((r) => r && c.includes(r))) { retired.push(`${event}: ${c}`); return false; }
        return true;
      });
      return hooks.length === (e.hooks ?? []).length ? e : { ...e, hooks };
    }).filter((e) => (e.hooks ?? []).length);
  }
  for (const [event, entry] of Object.entries(entries)) out.hooks[event] = [...(out.hooks[event] ?? []), entry];
  return { settings: out, added: Object.keys(entries), replaced, retired };
}

// "Added …; replaced …; retired …" in one line, for the person who ran it.
export function summary({ added, replaced, retired }, backup) {
  const parts = [`added the gate to ${added.join(" and ")}`];
  if (replaced.length) parts.push(`replaced ${replaced.length} older flight-board entr${replaced.length > 1 ? "ies" : "y"}`);
  parts.push(retired.length ? `retired ${retired.length}: ${retired.join("; ")}` : "retired nothing");
  return `Changed: ${parts.join("; ")}.${backup ? ` Backup: ${backup}` : ""}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const configPath = args[0];
  const opt = (name) => { const n = args.indexOf(name); return n > 0 ? args[n + 1] : undefined; };
  const retire = args.flatMap((a, n) => (args[n - 1] === "--retire" ? [a] : []));
  const target = resolve(opt("--settings") ?? resolve(homedir(), ".claude/settings.json"));
  if (!configPath || configPath.startsWith("--")) { console.error("Usage: node scripts/hooks.mjs <board.config.json> [--write] [--retire <text in an old hook's command>]... [--settings <file>]"); process.exit(2); }
  const entries = hookEntries(fileURLToPath(new URL("..", import.meta.url)), configPath);
  const settings = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : {};
  const result = withHooks(settings, entries, retire);
  if (!args.includes("--write")) {
    console.log(JSON.stringify({ hooks: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, [v]])) }, null, 2));
    console.log(`\n${summary(result, null).replace(/^Changed:/, "Dry run, nothing written. With --write it would change this:")} File: ${target}`);
    process.exit(0);
  }
  const backup = existsSync(target) ? `${target}.before-flight-board-${Date.now()}` : null;
  if (backup) copyFileSync(target, backup);
  writeFileSync(target, JSON.stringify(result.settings, null, 2) + "\n");
  console.log(summary(result, backup));
}
