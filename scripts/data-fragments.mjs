// One DATA.md line per card (data-md-change-fragments, #C1090). Every landing used to conflict every waiting branch on docs/DATA.md, because each card
// appended its dated line at the same place (the end of the file); on 11-16 that cost #C1075 two rebases and two re-signs (#C1081, then #C1083) and
// three more rebases the same day. The same cure as CHANGELOG.d (#C1019): a card writes its line to its own file, docs/DATA.d/<card id>.md (one
// line, "- YYYY-MM-DD: ..."), and the files are folded into docs/DATA.md where it is built:
//   node scripts/data-fragments.mjs            prints docs/DATA.md with the fragments' lines appended, in date order
//   node scripts/data-fragments.mjs --check    exits 1, naming each file, when a fragment is not a card id's single dated line
//   node scripts/data-fragments.mjs --write    folds the files into docs/DATA.md and deletes them (a release or a pack does this, once, as changelog.mjs)
// Order: oldest first, by the date in the line, then by the first "#C<number>" in it (lowest first), then by file name: the order the lines were
// already in (a card's line is appended after the lines of the earlier days). Pure functions below; the command line only reads and writes files.
// Nothing here reaches a network or runs git. As changelog.mjs (Security's LOW on #C1019): nothing follows a symbolic link; docs/DATA.d, each file
// in it and docs/DATA.md must be what they say they are (lstat: a plain folder, plain files), or the run refuses and names it.
import { readFileSync, writeFileSync, readdirSync, rmSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = "docs/DATA.d", FILE = "docs/DATA.md";
const CARD_FILE = /^([a-z0-9][a-z0-9-]*)\.md$/;
const DATED = /^- (\d{4})-(\d{2})-(\d{2}): \S/;

// One fragment: its name is a card id (what the Board-Id trailer names), its text exactly one line "- YYYY-MM-DD: ...".
// Returns { id, bullet, date, num } or { problem }.
export function readFragment(name, text) {
  const m = CARD_FILE.exec(String(name));
  if (!m) return { problem: `${name}: the file name must be <card id>.md (lower-case letters, digits and dashes)` };
  const body = String(text).replace(/\n$/, "");
  if (body === "") return { problem: `${name}: empty` };
  if (body.includes("\n") || body.includes("\r")) return { problem: `${name}: must be one line` };
  const d = DATED.exec(body);
  if (!d) return { problem: `${name}: the line must start with "- YYYY-MM-DD: " and say something` };
  const month = Number(d[2]), day = Number(d[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return { problem: `${name}: ${d[1]}-${d[2]}-${d[3]} is not a date` };
  const n = /#C(\d+)/.exec(body);
  return { id: m[1], bullet: body, date: `${d[1]}-${d[2]}-${d[3]}`, num: n ? Number(n[1]) : Infinity };
}

// files: [{ name, text }]. Returns { bullets, problems }: the lines oldest first (date, then card number, then name).
export function fragmentBullets(files) {
  const ok = [], problems = [];
  for (const f of files) {
    const r = readFragment(f.name, f.text);
    if (r.problem) problems.push(r.problem); else ok.push(r);
  }
  ok.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || (a.num === b.num ? 0 : a.num < b.num ? -1 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { bullets: ok.map((r) => r.bullet), problems: problems.sort() };
}

// base: docs/DATA.md's text. The lines go after its last line, as the cards appended them (a file that does not end in a newline gets one first).
export function joinData(base, bullets) {
  if (!bullets.length) return base;
  const text = String(base);
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${bullets.join("\n")}\n`;
}

const kindOf = (p) => { try { const s = lstatSync(p); return s.isSymbolicLink() ? "link" : s.isFile() ? "file" : s.isDirectory() ? "dir" : "other"; } catch { return null; } };
const WHAT = { link: "a symbolic link", dir: "a folder", other: "a special file" };

// { files: [{ name, text }] of the plain files, problems: the paths that are not what they must be }.
export function readFiles(root) {
  const dir = join(root, DIR), k = kindOf(dir);
  if (k === null) return { files: [], problems: [] };
  if (k !== "dir") return { files: [], problems: [`${DIR}: must be a plain folder, not ${WHAT[k] ?? "a file"}`] };
  const files = [], problems = [];
  for (const name of readdirSync(dir).filter((n) => n !== "README.md" && !n.startsWith(".")).sort()) {
    const fk = kindOf(join(dir, name));
    if (fk === "file") files.push({ name, text: readFileSync(join(dir, name), "utf8") });
    else problems.push(`${name}: must be a plain file, not ${WHAT[fk] ?? "missing"}`);
  }
  return { files, problems };
}

// The command line. Returns { code, out } so a test can call it; the file entry below prints and exits.
export function run(argv, root) {
  const read = readFiles(root), { files } = read, { bullets, problems: bad } = fragmentBullets(files), problems = [...read.problems, ...bad];
  if (argv.includes("--check")) return problems.length ? { code: 1, out: problems.join("\n") + "\n" } : { code: 0, out: `${files.length} DATA fragment(s), all fine\n` };
  if (problems.length) return { code: 1, out: problems.join("\n") + "\n" };
  const k = kindOf(join(root, FILE));
  if (k !== "file") return { code: 1, out: `${FILE}: must be a plain file, not ${WHAT[k] ?? "missing"}\n` };
  const base = readFileSync(join(root, FILE), "utf8"), joined = joinData(base, bullets);
  if (!argv.includes("--write")) return { code: 0, out: joined };
  if (joined !== base) writeFileSync(join(root, FILE), joined);
  for (const f of files) rmSync(join(root, DIR, f.name));
  return { code: 0, out: `${files.length} DATA fragment(s) folded into ${FILE}\n` };
}

import { isMain } from "./is-main.mjs";
if (isMain(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const r = run(process.argv.slice(2), root);
  (r.code ? process.stderr : process.stdout).write(r.out);
  // #C1153: set the exit code and let the process end by itself, so a pipe is drained first (process.exit cut the print at 64 KB).
  process.exitCode = r.code;
}
