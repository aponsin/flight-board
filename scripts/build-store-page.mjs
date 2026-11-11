// The old board page for the store Worker (#C723, board parity A1). The same page the artifact runs (scripts/build-page.mjs,
// fixtures checked), changed in two places only, both outside its render code:
// - the fonts: the Google Fonts links (between <!--FONTS--> and <!--END_FONTS-->) become @font-face rules on the Worker's own
//   /fonts/ files, so the page's policy can refuse every other site;
// - the document: the artifact wrapped the page in a skeleton (doctype, charset, viewport); the Worker serves it whole.
// Usage: node scripts/build-store-page.mjs <board.config.json> [outDir]   (outDir defaults to worker/store-assets, from any folder)
// It writes <outDir>/board.html and <outDir>/fonts/*.woff2: the Worker's static assets (worker/wrangler.board.toml [assets]).
// The config never enters this repository, and neither does what it writes (git-ignored).
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChecked, headCommit } from "./build-page.mjs";

const TEMPLATE = new URL("../page/board.template.html", import.meta.url);
export const FONTS_DIR = new URL("../page/fonts/", import.meta.url);

// The six faces the page uses (its --display, --body and --mono), latin, as the @fontsource packages name them.
export const FONT_FACES = [
  { family: "Barlow Condensed", weight: 600, file: "barlow-condensed-latin-600-normal.woff2" },
  { family: "Barlow Condensed", weight: 700, file: "barlow-condensed-latin-700-normal.woff2" },
  { family: "Source Sans 3", weight: 400, file: "source-sans-3-latin-400-normal.woff2" },
  { family: "Source Sans 3", weight: 600, file: "source-sans-3-latin-600-normal.woff2" },
  { family: "JetBrains Mono", weight: 400, file: "jetbrains-mono-latin-400-normal.woff2" },
  { family: "JetBrains Mono", weight: 600, file: "jetbrains-mono-latin-600-normal.woff2" },
];
export const FONT_FILE = /^[a-z0-9-]+\.woff2$/;

export function fontFaceCss(faces = FONT_FACES) {
  return faces.map((f) => `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${f.weight};font-display:swap;src:url(/fonts/${f.file}) format("woff2")}`).join("\n");
}

// A built page (build-page.mjs's output) as the Worker serves it. Throws when the page has no fonts block, so a template
// change can't quietly bring Google's links back.
export function storePage(built) {
  const block = /<!--FONTS-->[\s\S]*?<!--END_FONTS-->/;
  if (!block.test(built)) throw new Error("the page has no <!--FONTS--> block");
  const page = built.replace(block, () => `<style>\n${fontFaceCss()}\n</style>`);
  if (/fonts\.(googleapis|gstatic)\.com/.test(page)) throw new Error("the page still names Google's font servers");
  // data-host="store" tells the page it runs on the store (#C723 A4): it leaves out what the owner agreed is gone.
  // #C904: the manifest and the Home Screen tags, so an iPhone can add the board and get its pushes (iOS allows Web Push only there).
  return `<!doctype html>\n<html lang="en" data-host="store">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<link rel="manifest" href="/manifest.webmanifest">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-title" content="Board">\n</head>\n<body>\n${page}\n</body>\n</html>\n`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [configPath, outDir = fileURLToPath(new URL("../worker/store-assets/", import.meta.url))] = process.argv.slice(2);
  if (!configPath) { console.error("Usage: node scripts/build-store-page.mjs <board.config.json> [outDir]"); process.exit(2); }
  try {
    const built = buildChecked(readFileSync(TEMPLATE, "utf8"), JSON.parse(readFileSync(configPath, "utf8")), undefined, { commit: headCommit(), pack: process.env.BOARD_PACK });
    const out = resolve(outDir);
    mkdirSync(join(out, "fonts"), { recursive: true });
    writeFileSync(join(out, "board.html"), storePage(built));
    for (const f of FONT_FACES) copyFileSync(fileURLToPath(new URL(f.file, FONTS_DIR)), join(out, "fonts", f.file));
    console.log(`Built ${join(out, "board.html")} and ${FONT_FACES.length} fonts: the store Worker's assets (deploy with worker/wrangler.board.toml).`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
