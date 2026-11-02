// A pack's last step (#C587, Director): run every pinned hook's config check once, against the config the pack just wrote,
// and fail on any problem line. Usage: node scripts/hooks-check.mjs <board.config.json> <file>...
// Each <file> is any text that names pinned copies: ~/.claude/settings.json, the Collector's settings (TASK.md), a task's
// SKILL.md. For every folder those name that holds a scripts/config.mjs (a pinned copy of a signed commit, or a checkout),
// that folder's own checkConfig reads the config, as its hooks do on every run. The v3.40 pack wrote gate.keeperRole into the
// config but left the Collector's fence on a copy that refuses it as an unknown field, and no hook said so: every hook
// answers a config it can't read with silence. Exit 0: every copy accepts it; 1: a copy refuses it (each line named);
// 2: nothing to check.
import { readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

// The folders of the flight-board scripts a text runs: the path before /gate|collector|scripts|worker/<file>.mjs. Quotes
// around a path (hooks.mjs shellQuote) are not part of it.
// A leading "~/" is the home folder (the settings write ~/.flight-board/current/…), not the "/" after it.
const SCRIPT = /((?:~)?\/[^\s'"`]+?)\/(?:gate|collector|scripts|worker)\/[A-Za-z0-9._-]+\.mjs/g;
export function pinnedRoots(texts, home = homedir()) {
  const roots = new Set();
  for (const t of texts) for (const m of String(t).matchAll(SCRIPT)) roots.add(m[1].startsWith("~/") ? join(home, m[1].slice(2)) : m[1]);
  return [...roots].sort();
}

// Only a pinned copy is ever imported (Security: a line in a file an agent can edit must not get a folder of its choosing
// run as the owner): the root's real path is exactly <install root>/<40 hex>, a directory this user owns.
export const INSTALL_ROOT = join(homedir(), ".flight-board", "install");
export function isPinnedCopy(root, installRoot = INSTALL_ROOT, uid = process.getuid()) {
  try {
    const real = realpathSync(root), base = realpathSync(installRoot);
    if (real !== join(base, basename(real)) || !/^[0-9a-f]{40}$/.test(basename(real))) return false;
    const st = statSync(real);
    return st.isDirectory() && st.uid === uid;
  } catch { return false; }
}

// For each root: its checkConfig's problems with this config, or why it couldn't be asked. [{ root, problems }].
export async function dryRun(roots, config, installRoot = INSTALL_ROOT) {
  const out = [];
  for (const root of roots) {
    const file = join(root, "scripts", "config.mjs");
    // A folder with no config check is not a flight-board copy (the owner's other repositories' hooks): skipped, and not
    // imported, only looked for. One that has a config check but is not a pinned copy fails and is never imported.
    if (!existsSync(file)) { out.push({ root, problems: ["no scripts/config.mjs there: nothing to check it against"], skipped: true }); continue; }
    if (!isPinnedCopy(root, installRoot)) { out.push({ root, problems: ["not a pinned copy (<install root>/<signed commit>): not imported"] }); continue; }
    try {
      const { checkConfig } = await import(pathToFileURL(realpathSync(file)).href);
      out.push({ root, problems: checkConfig(config) });
    } catch (e) { out.push({ root, problems: [`its config check did not run: ${String(e.message).split("\n")[0]}`] }); }
  }
  return out;
}

// Lines for the person running the pack, and whether it passes (a root with no config.mjs is skipped, not a pass or a fail).
export function report(results) {
  const lines = [];
  let bad = 0;
  for (const r of results) {
    if (r.skipped) { lines.push(`skipped ${r.root}: ${r.problems[0]}`); continue; }
    if (!r.problems.length) { lines.push(`ok ${r.root}`); continue; }
    bad++;
    for (const p of r.problems) lines.push(`CHECK FAILED ${r.root}: ${p}`);
  }
  return { lines, ok: bad === 0, checked: results.filter((r) => !r.skipped).length };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [configPath, ...files] = process.argv.slice(2);
  if (!configPath || !files.length) { console.error("Usage: node scripts/hooks-check.mjs <board.config.json> <settings or task file>..."); process.exit(2); }
  let config;
  try { config = JSON.parse(readFileSync(resolve(configPath), "utf8")); } catch (e) { console.error(`CHECK FAILED the config: ${String(e.message).split("\n")[0]}`); process.exit(1); }
  const texts = [];
  for (const f of files) { try { texts.push(readFileSync(resolve(f), "utf8")); } catch { console.error(`CHECK FAILED cannot read ${f}`); process.exit(1); } }
  const { lines, ok, checked } = report(await dryRun(pinnedRoots(texts), config, process.env.FLIGHT_BOARD_INSTALL_ROOT || INSTALL_ROOT));
  for (const l of lines) console.log(l);
  if (!checked) { console.error("CHECK FAILED no pinned hook found in those files: nothing was checked"); process.exit(2); }
  console.log(ok ? `hooks check: ${checked} pinned cop${checked > 1 ? "ies accept" : "y accepts"} the config` : "hooks check: FAILED");
  process.exit(ok ? 0 : 1);
}
