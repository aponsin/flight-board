// The gate's hook entries for Claude Code's settings (~/.claude/settings.json): PreToolUse on board writes and
// hand-off messages, Stop on the lead's replies. Printed by default; written only with --write, which keeps every other
// entry and replaces an older flight-board one. Usage: node scripts/hooks.mjs <board.config.json> [--write [settings.json]]
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const MARK = "flight-board/gate/";
export function hookEntries(repo, configPath, node = process.execPath) {
  const cmd = (file) => `${node} ${resolve(repo, "gate", file)} --config ${resolve(configPath)}`;
  return {
    PreToolUse: { matcher: "ArtifactData|SendMessage|mcp__ccd_session_mgmt__send_message", hooks: [{ type: "command", command: cmd("gate.mjs") }] },
    Stop: { hooks: [{ type: "command", command: cmd("stop.mjs") }] },
  };
}

// settings with the gate's entries in: an older flight-board entry is replaced, everything else kept as it was.
export function withHooks(settings, entries) {
  const out = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const [event, entry] of Object.entries(entries)) {
    const kept = (out.hooks[event] ?? []).filter((e) => !(e.hooks ?? []).some((h) => String(h.command ?? "").includes(MARK)));
    out.hooks[event] = [...kept, entry];
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [configPath, flag, target = resolve(homedir(), ".claude/settings.json")] = process.argv.slice(2);
  if (!configPath) { console.error("Usage: node scripts/hooks.mjs <board.config.json> [--write [settings.json]]"); process.exit(2); }
  const entries = hookEntries(fileURLToPath(new URL("..", import.meta.url)), configPath);
  if (flag !== "--write") { console.log(JSON.stringify({ hooks: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, [v]])) }, null, 2)); console.log("\nAdd these to your settings, or run again with --write."); process.exit(0); }
  const settings = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : {};
  if (existsSync(target)) copyFileSync(target, `${target}.before-flight-board`);
  writeFileSync(target, JSON.stringify(withHooks(settings, entries), null, 2) + "\n");
  console.log(`Wrote the gate's hooks into ${target} (the old file is kept as ${target}.before-flight-board). Retire any older board gate entry by hand.`);
}
