// Builds the board page for one team: page/board.template.html with its board.config.json injected.
// Usage: node scripts/build-page.mjs <board.config.json> [out.html]   (out defaults to dist/board.html)
// The page is then published as the team's artifact (see the README); the config never enters this repository.
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig } from "./config.mjs";
import { checkAll } from "./fixtures.mjs";

const TEMPLATE = new URL("../page/board.template.html", import.meta.url);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// A value as JSON inside the page's script: no "<" (so no "</script>") and no raw line separators. The config check
// already refuses "<" in every field; this holds even if it didn't.
export function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// The page for a config: its values in the script as JSON (no "<" left, so no "</script>"), and in the HTML escaped.
// stamp: { commit, pack } for the header's "Board <pack> · page <commit>" line (#C609); a part left out is left out of the line.
export function buildPage(template, config, stamp = {}) {
  const problems = checkConfig(config);
  if (problems.length) throw new Error(`board.config.json:\n- ${problems.join("\n- ")}`);
  const c = fullConfig(config);
  const marked = /\/\*BOARD_CONFIG\*\/[\s\S]*?\/\*END_CONFIG\*\//;
  if (!marked.test(template)) throw new Error("the template has no /*BOARD_CONFIG*/ block");
  const json = scriptJson(c);
  return template.replace(marked, () => `/*BOARD_CONFIG*/${json}/*END_CONFIG*/`)
    .replaceAll("{{TITLE}}", esc(c.title)).replaceAll("{{OWNER}}", esc(c.owner)).replaceAll("{{USAGE_NOTE}}", esc(c.usageNote))
    .replaceAll("{{RUNNER_LABEL}}", esc(c.runnerLabel)).replaceAll("{{AUTOMATION_LABEL}}", esc(c.automationLabel))
    .replaceAll("{{PAGE_COMMIT}}", /^[0-9a-f]{7,12}$/.test(stamp.commit ?? "") ? stamp.commit : "")
    .replaceAll("{{BOARD_PACK}}", /^v\d+\.\d+[a-z]?$/.test(stamp.pack ?? "") ? stamp.pack : "");
}

// The commit the page is built from: the repository's HEAD, 7 characters; none outside a repository.
export function headCommit() {
  try { return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
}

// The page, only if it draws every rendered scenario as expected (#C268): a failing fixture throws, and nothing is
// written. The built page itself is checked, with the team's config in it.
export function buildChecked(template, config, dir, stamp = {}) {
  const html = buildPage(template, config, stamp);
  const failed = checkAll(html, dir).filter((r) => r.bad.length);
  if (failed.length) throw new Error(`Not built: ${failed.length} page fixture(s) fail (node scripts/fixtures.mjs):\n${failed.map((r) => `- ${r.file}: ${r.bad.join("; ")}`).join("\n")}`);
  return html;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [configPath, out = "dist/board.html"] = process.argv.slice(2);
  if (!configPath) { console.error("Usage: node scripts/build-page.mjs <board.config.json> [out.html]"); process.exit(2); }
  try {
    const html = buildChecked(readFileSync(TEMPLATE, "utf8"), JSON.parse(readFileSync(configPath, "utf8")), undefined, { commit: headCommit(), pack: process.env.BOARD_PACK });
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, html);
    console.log(`Built ${out}. Publish it as your board's artifact (README, "Publish the page").`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
