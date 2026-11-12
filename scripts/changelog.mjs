// One changelog file per card (changelog-no-recut, #C1019). Every landing used to conflict every waiting branch on CHANGELOG.md, because
// each card put its bullet at the same place, and each conflict cost a re-cut and a re-sign. Now a card writes its bullet to its own file,
// CHANGELOG.d/<card id>.md (one line, "- ..."), and CHANGELOG.md is joined from those files where it is read or built:
//   node scripts/changelog.mjs            prints CHANGELOG.md with the card files' bullets at the top of its Unreleased section
//   node scripts/changelog.mjs --check    exits 1, naming each file, when a card file is not a card id's single bullet
//   node scripts/changelog.mjs --write    folds the files into CHANGELOG.md and deletes them (a release or a pack does this, once)
// Order: newest first, by the first "#C<number>" in a bullet, highest first (a bullet with none goes last, by file name). Pure functions
// below; the command line only reads and writes files. Nothing here reaches a network or runs git.
// Security's LOW on #C1019: nothing here follows a symbolic link. CHANGELOG.d, each file in it and CHANGELOG.md must be what they say they are
// (lstat: a plain folder, plain files), or the run refuses and names it; a link could fold a file from outside the repository into CHANGELOG.md, or
// make --write delete files outside it. A folder inside CHANGELOG.d is named too, never a crash (Checker 2's LOW).
import { readFileSync, writeFileSync, readdirSync, rmSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = "CHANGELOG.d", FILE = "CHANGELOG.md";
const CARD_FILE = /^([a-z0-9][a-z0-9-]*)\.md$/;
const UNRELEASED = /^## .*Unreleased/i;

// One card file: its name is a card id (what the Board-Id trailer names), its text exactly one "- " line.
// Returns { id, bullet, num } or { problem }.
export function readCardFile(name, text) {
  const m = CARD_FILE.exec(String(name));
  if (!m) return { problem: `${name}: the file name must be <card id>.md (lower-case letters, digits and dashes)` };
  const body = String(text).replace(/\n$/, "");
  if (body === "") return { problem: `${name}: empty` };
  if (body.includes("\n") || body.includes("\r")) return { problem: `${name}: must be one bullet on one line` };
  if (!body.startsWith("- ") || body.length < 3) return { problem: `${name}: the line must start with "- "` };
  const n = /#C(\d+)/.exec(body);
  return { id: m[1], bullet: body, num: n ? Number(n[1]) : -1 };
}

// files: [{ name, text }]. Returns { bullets, problems }: bullets newest first (number high to low, then name).
export function cardBullets(files) {
  const ok = [], problems = [];
  for (const f of files) {
    const r = readCardFile(f.name, f.text);
    if (r.problem) problems.push(r.problem); else ok.push(r);
  }
  ok.sort((a, b) => b.num - a.num || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { bullets: ok.map((r) => r.bullet), problems: problems.sort() };
}

// base: CHANGELOG.md's text. The bullets go straight under the Unreleased heading's blank line, above the bullets already there.
export function joinChangelog(base, bullets) {
  if (!bullets.length) return base;
  const lines = String(base).split("\n");
  const at = lines.findIndex((l) => UNRELEASED.test(l));
  if (at < 0) throw new Error(`${FILE} has no "## ... Unreleased" heading to put the bullets under`);
  let insert = at + 1;
  if (lines[insert] === "") insert++;
  lines.splice(insert, 0, ...bullets);
  return lines.join("\n");
}

// What a path is, by lstat (a link is a link, never what it points at): "file", "dir", "link", "other", or null when there is nothing there.
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
  const read = readFiles(root), { files } = read, { bullets, problems: bad } = cardBullets(files), problems = [...read.problems, ...bad];
  if (argv.includes("--check")) return problems.length ? { code: 1, out: problems.join("\n") + "\n" } : { code: 0, out: `${files.length} card file(s), all fine\n` };
  if (problems.length) return { code: 1, out: problems.join("\n") + "\n" };
  if (kindOf(join(root, FILE)) !== "file") return { code: 1, out: `${FILE}: must be a plain file, not ${WHAT[kindOf(join(root, FILE))] ?? "missing"}\n` };
  const base = readFileSync(join(root, FILE), "utf8");
  let joined;
  try { joined = joinChangelog(base, bullets); } catch (e) { return { code: 1, out: `${e.message}\n` }; }
  if (!argv.includes("--write")) return { code: 0, out: joined };
  if (joined !== base) writeFileSync(join(root, FILE), joined);
  for (const f of files) rmSync(join(root, DIR, f.name));
  return { code: 0, out: `${files.length} card file(s) folded into ${FILE}\n` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const r = run(process.argv.slice(2), root);
  (r.code ? process.stderr : process.stdout).write(r.out);
  process.exit(r.code);
}
