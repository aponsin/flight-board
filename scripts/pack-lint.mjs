// The lint every install pack passes before it goes to Security (#C638). The v3.51 install stopped on a backup that an older pack
// had left under the same name (`settings.local.json.before-v351`, 26 Oct): the pack kept an existing backup (`[ -e b ] || cp`),
// then compared the live file with it. Two rules keep that from happening again:
//   1. a backup's name carries the full dotted version: `.before-v3.51`, never `.before-v351` (v3.5.1 and v3.51 share that name);
//   2. a pack never compares with a backup (cmp, diff, sed, shasum, grep, node on a `.before-` path): it compares with an input
//      the pack hash-checks (`ok "$FILE" HASH`). A line that must read a backup anyway says why with `# pack-lint: ok <reason>`.
// Creating a backup (`[ -e b ] || cp -p x b`), restoring one (`cp -p b x`) and naming one in a message or a comment are fine.
// Usage: node scripts/pack-lint.mjs <pack.sh>...   (exit 1 with one line per problem)
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UNDOTTED = /\.before-v\d+(?![\d.])/;
const READER = /(?:^|[\s|;&(`$])(?:cmp|diff|sed|shasum|sum|grep|node)\b/;
const MARK = /#\s*pack-lint:\s*ok\s+\S/;

// The problems in a pack's text, as { line, rule, text }.
export function lintPack(text) {
  const out = [];
  String(text).split("\n").forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const code = MARK.test(line) ? "" : line;
    if (UNDOTTED.test(line)) out.push({ line: n + 1, rule: "a backup name without the dotted version (.before-v3.51, not .before-v351)", text: line });
    if (code && code.includes(".before-") && READER.test(stripCopies(code))) out.push({ line: n + 1, rule: "compares with a backup, not with a hash-checked input", text: line });
  });
  return out;
}

// A line without its backup creations and restores (`[ -e b ] || cp -p x b`, `cp -p b x`) and without a message's text.
function stripCopies(code) {
  return code
    .replace(/\[ -e "[^"]*\.before-[^"]*" \] \|\| cp -p "[^"]*" "[^"]*\.before-[^"]*"/g, "")
    .replace(/cp -p "[^"]*\.before-[^"]*" "[^"]*"/g, "")
    .replace(/echo "[^"]*"/g, "");
}

const here = (() => { try { return realpathSync(fileURLToPath(import.meta.url)); } catch { return ""; } })();
if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === here; } catch { return false; } })()) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error("usage: node scripts/pack-lint.mjs <pack.sh>..."); process.exit(2); }
  let bad = 0;
  for (const f of files) {
    for (const p of lintPack(readFileSync(f, "utf8"))) { bad++; console.log(`${f}:${p.line}: ${p.rule}: ${p.text.slice(0, 160)}`); }
  }
  if (!bad) console.log(`pack lint: ${files.length} pack${files.length > 1 ? "s" : ""} clean`);
  process.exit(bad ? 1 : 0);
}
