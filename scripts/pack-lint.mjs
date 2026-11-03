// The lint every install pack passes before it goes to Security (#C638). The v3.51 install stopped on a backup that an older pack
// had left under the same name (`settings.local.json.before-v351`, 26 Oct): the pack kept an existing backup (`[ -e b ] || cp`),
// then compared the live file with it. Two rules keep that from happening again:
//   1. a backup's name carries the full dotted version: `.before-v3.51`, never `.before-v351` (v3.5.1 and v3.51 share that name);
//   2. a pack uses a backup in three ways only, and compares with an input the pack hash-checks (`ok "$FILE" HASH`) instead.
//      An allow list: any other line naming `.before-` fails, whatever the command (cmp, diff, sed, awk, cat, python, a variable
//      assignment, a diff inside an echo, a command continued onto the next line with `\`). The three ways:
//        - make one:    [ -e "$F.before-v3.51" ] || cp -p "$F" "$F.before-v3.51"
//        - restore one: cp -p "$F.before-v3.51" "$F"
//        - name one in a plain message: echo "... $F.before-v3.51 ..."  (no `$(` or backtick in the message)
//      A line that must read one anyway says why with `# pack-lint: ok <reason>` (a mark with no reason does not count).
// Comments are not linted. Usage: node scripts/pack-lint.mjs <pack.sh>...   (exit 1 with one line per problem)
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UNDOTTED = /\.before-v\d+(?![\d.])/;
const MARK = /#\s*pack-lint:\s*ok\s+\S/;
const ALLOWED = [
  /\[ -e "[^"]*\.before-[^"]*" \] \|\| cp -p "[^"]*" "[^"]*\.before-[^"]*"/g,
  /cp -p "[^"]*\.before-[^"]*" "[^"]*"/g,
  /echo "(?:[^"$`\\]|\$(?!\()|\\.)*"/g,
];

// The pack's lines with each `\`-continued command joined onto its first line: [{ n, line }].
function logicalLines(text) {
  const out = [];
  let cur = null;
  String(text).split("\n").forEach((raw, i) => {
    cur = cur ? { n: cur.n, line: cur.line + " " + raw.trim() } : { n: i + 1, line: raw.trim() };
    if (cur.line.endsWith("\\")) { cur.line = cur.line.slice(0, -1); return; }
    out.push(cur); cur = null;
  });
  if (cur) out.push(cur);
  return out;
}

// The problems in a pack's text, as { line, rule, text }.
export function lintPack(text) {
  const out = [];
  for (const { n, line } of logicalLines(text)) {
    if (!line || line.startsWith("#") || !line.includes(".before-")) continue;
    if (UNDOTTED.test(line)) out.push({ line: n, rule: "a backup name without the dotted version (.before-v3.51, not .before-v351)", text: line });
    if (MARK.test(line)) continue;
    const rest = ALLOWED.reduce((s, re) => s.replace(re, ""), line);
    if (rest.includes(".before-")) out.push({ line: n, rule: "uses a backup other than to make or restore it or name it in a plain message (compare with a hash-checked input)", text: line });
  }
  return out;
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
