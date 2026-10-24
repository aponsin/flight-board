// Builds the board page for one team: page/board.template.html with its board.config.json injected.
// Usage: node scripts/build-page.mjs <board.config.json> [out.html]   (out defaults to dist/board.html)
// The page is then published as the team's artifact (see the README); the config never enters this repository.
import { realpathSync } from "node:fs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig } from "./config.mjs";

const TEMPLATE = new URL("../page/board.template.html", import.meta.url);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// A value as JSON inside the page's script: no "<" (so no "</script>") and no raw line separators. The config check
// already refuses "<" in every field; this holds even if it didn't.
export function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// The page for a config: its values in the script as JSON (no "<" left, so no "</script>"), and in the HTML escaped.
export function buildPage(template, config) {
  const problems = checkConfig(config);
  if (problems.length) throw new Error(`board.config.json:\n- ${problems.join("\n- ")}`);
  const c = fullConfig(config);
  const marked = /\/\*BOARD_CONFIG\*\/[\s\S]*?\/\*END_CONFIG\*\//;
  if (!marked.test(template)) throw new Error("the template has no /*BOARD_CONFIG*/ block");
  const json = scriptJson(c);
  return template.replace(marked, () => `/*BOARD_CONFIG*/${json}/*END_CONFIG*/`)
    .replaceAll("{{TITLE}}", esc(c.title)).replaceAll("{{OWNER}}", esc(c.owner)).replaceAll("{{USAGE_NOTE}}", esc(c.usageNote))
    .replaceAll("{{RUNNER_LABEL}}", esc(c.runnerLabel)).replaceAll("{{AUTOMATION_LABEL}}", esc(c.automationLabel));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [configPath, out = "dist/board.html"] = process.argv.slice(2);
  if (!configPath) { console.error("Usage: node scripts/build-page.mjs <board.config.json> [out.html]"); process.exit(2); }
  try {
    const html = buildPage(readFileSync(TEMPLATE, "utf8"), JSON.parse(readFileSync(configPath, "utf8")));
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, html);
    console.log(`Built ${out}. Publish it as your board's artifact (README, "Publish the page").`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
