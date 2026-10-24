// One-time setup for a team, run from this repository:
//   node scripts/install.mjs <board.config.json> <private-words.txt>
// It checks the config, turns on the pre-push content scan (and points it at the team's private word list), and builds
// the page into dist/board.html for publishing. Later steps (the gate, the collector, the nudges) add their hook entries
// and scheduled task here.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { buildPage } from "./build-page.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const [configPath, wordsPath] = process.argv.slice(2);
if (!configPath || !wordsPath) { console.error("Usage: node scripts/install.mjs <board.config.json> <private-words.txt>"); process.exit(2); }
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const inside = (p) => resolve(p).startsWith(root + "/");
if (inside(configPath) || inside(wordsPath)) { console.error("Keep board.config.json and the word list outside this repository."); process.exit(1); }
if (!existsSync(wordsPath)) { console.error(`No word list at ${wordsPath}.`); process.exit(1); }
try {
  const html = buildPage(readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8"), JSON.parse(readFileSync(configPath, "utf8")));
  mkdirSync("dist", { recursive: true });
  writeFileSync("dist/board.html", html);
} catch (e) { console.error(e.message); process.exit(1); }
execFileSync("git", ["config", "core.hooksPath", ".githooks"]);
execFileSync("git", ["config", "flightboard.scanwords", resolve(wordsPath)]);
console.log("Installed: the pre-push scan is on, and dist/board.html is built.");
console.log("Next: publish dist/board.html as your board's artifact (README, \"Publish the page\").");
