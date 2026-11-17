// The group check before a group head lands (#C1146). Each card of a group is reviewed alone (or as one range, #C1068), but not how the cards meet. So before the landing
// job lands a head that carries two or more cards it wants two things on that exact commit, and waits without them:
//   1. Checker's READ: Checker has read every file that two or more of the head's cards touch (`node scripts/group-check.mjs read --sha <head> --signer "Checker 2" --push`
//      writes the note, listing the files it covers). A merge commit touches nothing here: only the cards' own commits count, each by its Board-Id trailer.
//   2. one run of the full suite on the head, which the landing job makes itself (a snapshot of the commit, once per sha, kept in group-check.json).
// A head with one card, or none, asks for neither. The pure rules are here and tested as data; board-land.mjs reads the facts and runs the suite.
//   node scripts/group-check.mjs files [--sha <head>]            the files two or more cards touch, on origin/main..<head> (default: HEAD)
//   node scripts/group-check.mjs read --sha <40-hex> --signer "Checker 2" [--push]
import { execFileSync } from "node:child_process";

export const GROUP_NOTE_REF = "refs/notes/group-check";
const CARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEP = "\u0001";

// The git read, as arguments (tested as data): no merges (a merge lists no file of its own), the files of each commit, its Board-Id trailers.
export const groupLogArgs = (main, sha) => ["log", "--no-merges", "--no-renames", "--name-only", `--format=${SEP}%H${SEP}%(trailers:key=Board-Id,valueonly,separator=%x2c)`, `${main}..${sha}`];

// git's log text -> [{ sha, cards: [ids], files: [paths] }]. A commit with no Board-Id keeps no card, so it adds no shared file.
export function parseGroupLog(text) {
  if (typeof text !== "string") return null;
  const out = [], parts = text.split(SEP).slice(1); // [sha, "trailers, then the files", sha, ...]
  for (let i = 0; i < parts.length; i += 2) {
    const sha = parts[i], lines = (parts[i + 1] ?? "").split("\n");
    if (!/^[0-9a-f]{40}$/.test(sha.trim())) return null; // not the shape asked for: the read failed, never an empty list
    const cards = [...new Set((lines[0] ?? "").split(",").map((x) => x.trim()).filter((x) => CARD_ID.test(x)))];
    out.push({ sha: sha.trim(), cards, files: lines.slice(1).map((l) => l.trim()).filter(Boolean) });
  }
  return out;
}

// The files that two or more DIFFERENT cards touch, sorted. commits: [{ cards, files }]; null in, null out (the read failed: never an empty list).
export function sharedFiles(commits) {
  if (!Array.isArray(commits)) return null;
  const by = new Map();
  for (const c of commits) for (const f of c?.files ?? []) { const s = by.get(f) ?? new Set(); for (const id of c.cards ?? []) s.add(id); by.set(f, s); }
  return [...by].filter(([, s]) => s.size >= 2).map(([f]) => f).sort();
}

// A note covers the shared files when its first line is READ (the word, then anything) and every file is named in it. Returns the files it does not name.
export function readMissing(note, shared) {
  const text = String(note ?? "");
  if (!/^READ\b/.test(text.split("\n")[0].trim())) return [...shared];
  const named = new Set(text.split("\n").slice(1).map((l) => l.trim()));
  return shared.filter((f) => !named.has(f));
}
export const readNote = (signer, shared) => `READ ${shared.length} file${shared.length === 1 ? "" : "s"} two or more cards touch, signed by ${signer}\n${shared.join("\n")}`;

// The facts the landing job reads for one head: only a head of two or more cards is read (undefined for the rest, which ask nothing). quiet(args) is a git read that gives
// null when git fails; suites is the kept verdicts by sha (group-check.json). A failed log read gives shared: null (a wait), a missing note gives read: null.
export function groupFacts({ cards, quiet, main, sha, suites }) {
  if (!Array.isArray(cards) || cards.length < 2) return undefined;
  return { shared: sharedFiles(parseGroupLog(quiet(groupLogArgs(main, sha)))), read: quiet(["notes", "--ref=board-release/group", "show", sha]), suite: suites && Object.hasOwn(suites, sha) ? suites[sha] : undefined };
}

// What the landing job does with a head: { state, why }.
//   none  the head carries fewer than two cards: no group check
//   wait  facts missing or Checker's READ is not there (or is stale: a shared file it does not name)
//   run   Checker has read; the suite has not run on this sha
//   fail  the suite ran on this sha and was red
//   ok    both are done
// head: { cards, shared (array, or null when the git read failed), read (the note text or null), suite ({ ok, line } or undefined) }
export function groupVerdict(head) {
  const cards = Array.isArray(head?.cards) ? head.cards : [];
  if (cards.length < 2) return { state: "none" };
  if (!Array.isArray(head.shared)) return { state: "wait", why: "the files two or more of its cards touch could not be read" };
  if (head.shared.length) {
    const missing = readMissing(head.read, head.shared);
    if (missing.length) return { state: "wait", why: `group check: Checker has not read the ${head.shared.length} file${head.shared.length === 1 ? "" : "s"} two or more of its cards touch (${missing.slice(0, 4).join(", ")}${missing.length > 4 ? `, and ${missing.length - 4} more` : ""}): node scripts/group-check.mjs read --sha <head>` };
  }
  if (!head.suite) return { state: "run" };
  if (head.suite.ok !== true) return { state: "fail", why: `the full suite on the group head was red: ${String(head.suite.line ?? "no detail").slice(0, 200)}` };
  return { state: "ok" };
}

// The full suite on a snapshot of the commit: { ok, line }. run(args) is a git call in the repository, suite(dir) runs the tests there; both injected for the tests.
export function suiteOnSnapshot({ sha, mkdtemp, run, suite, remove }) {
  const dir = mkdtemp();
  try {
    run(["worktree", "add", "--detach", dir, sha]);
    return suite(dir);
  } catch (e) {
    return { ok: false, line: `the snapshot could not be made or run: ${String(e?.message ?? e).split("\n")[0].slice(0, 120)}` };
  } finally {
    try { remove(dir); } catch { /* the temporary folder stays; a later prune takes it */ }
  }
}

// The suite run itself (Security's INFO and Checker 2's LOW on 249a281b). It is the snapshot's own `scripts/test-run.mjs`, what `npm test` runs, so its verdict is npm test's (the
// temp-folder preload and the leftovers check included). A hanging test must not stall the landing job (a macOS privacy prompt waits for a person nobody has put there): stdin is closed,
// HOME is an empty temporary folder (nothing under ~/Documents or ~/Desktop to ask about), and the run is killed after its time. A red that names failing test files gets ONE rerun of
// just those files (a git-fixture flake passes alone; a real failure does not): green after that is green, said in the line; red names the failing tests so Release can rerun them.
export const SUITE_SCRIPT = "scripts/test-run.mjs";
export const FIRST_RUN_SHARE = 0.8; // of the suite's time; the rest is the rerun's
const FAILED_LINE = /^FAILED (\S+): /;
export const failedLines = (text) => String(text ?? "").split("\n").map((l) => l.trim()).filter((l) => FAILED_LINE.test(l));
// The test files named by failing lines: tests/<name>.test.mjs only, at most 10 (a path from a line never goes to a command line otherwise).
export const failedFiles = (lines) => [...new Set((lines ?? []).map((l) => FAILED_LINE.exec(l)?.[1]).filter((f) => typeof f === "string" && /^tests\/[A-Za-z0-9._-]+\.test\.mjs$/.test(f)))].slice(0, 10);
// How the suite is started: { file, args, options } for spawnSync. files: rerun only these (default the whole suite).
export function suiteSpawn({ dir, home, tmp, failuresFile, timeoutMs, env = process.env, node = process.execPath, files = null }) {
  return {
    file: node, args: [SUITE_SCRIPT, ...(files ?? [])],
    options: { cwd: dir, env: { ...env, HOME: home, TMPDIR: tmp, SUITE_FAILURES_FILE: failuresFile }, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  };
}
// One spawnSync result -> { ok, line, files }: green; red naming up to three failing tests; or why it was stopped.
export function suiteVerdict(r, timeoutMs) {
  if (r?.error?.code === "ETIMEDOUT") return { ok: false, line: `the suite ran past ${Math.round(timeoutMs / 1000)} s and was stopped`, files: [] };
  if (r?.error) return { ok: false, line: `the suite could not start: ${String(r.error.message ?? r.error).split("\n")[0].slice(0, 120)}`, files: [] };
  if (r?.status === 0) return { ok: true, line: "green", files: [] };
  const text = `${r?.stderr ?? ""}\n${r?.stdout ?? ""}`, lines = failedLines(text);
  const leftover = text.split("\n").find((l) => l.startsWith("TEST TEMP LEFTOVERS:"));
  const named = lines.slice(0, 3).map((l) => l.slice(0, 160)).join(" | ");
  return { ok: false, line: `exit ${r?.status ?? "?"}${named ? `, ${named}${lines.length > 3 ? ` (and ${lines.length - 3} more)` : ""}` : leftover ? `, ${leftover.slice(0, 160)}` : ""}`, files: failedFiles(lines) };
}
// The whole run in one folder: { ok, line }. spawn(file, args, options) and mkdtemp()/remove(dir) are injected; totalMs is the suite's whole time (first run 80%, the rerun the rest).
export function runGroupSuite({ dir, spawn, mkdtemp, remove, totalMs, env = process.env }) {
  const home = mkdtemp(), tmp = mkdtemp();
  try {
    const failuresFile = `${tmp}/failures-copy.txt`, first = Math.floor(totalMs * FIRST_RUN_SHARE), rest = totalMs - first;
    const run = (files, timeoutMs) => { const s = suiteSpawn({ dir, home, tmp, failuresFile, timeoutMs, env, files }); return suiteVerdict(spawn(s.file, s.args, s.options), timeoutMs); };
    const one = run(null, first);
    if (one.ok || !one.files.length) return { ok: one.ok, line: one.line };
    const again = run(one.files, rest);
    return again.ok ? { ok: true, line: `green: ${one.files.join(", ")} failed once and passed alone` } : { ok: false, line: `${one.line}; again alone: ${again.line}`.slice(0, 400) };
  } finally {
    for (const d of [home, tmp]) { try { remove(d); } catch { /* left in the temp folder */ } }
  }
}

if (process.argv[1] && process.argv[1].endsWith("group-check.mjs") && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const a = process.argv.slice(2), cmd = a[0], val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
  const sha = val("--sha") ?? "HEAD";
  const shared = () => sharedFiles(parseGroupLog(execFileSync("git", groupLogArgs("origin/main", sha), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })));
  try {
    if (cmd === "files") { console.log((shared() ?? []).join("\n")); }
    else if (cmd === "read") {
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("--sha is the head's full 40-character commit");
      const signer = val("--signer");
      if (!signer || !/^[A-Za-z][A-Za-z0-9 ]{0,30}$/.test(signer)) throw new Error('--signer is your name, e.g. "Checker 2"');
      git(["cat-file", "-e", `${sha}^{commit}`]);
      try { git(["fetch", "-q", "origin", `+${GROUP_NOTE_REF}:${GROUP_NOTE_REF}`]); } catch { /* no note on origin yet */ }
      const files = shared();
      git(["notes", `--ref=${GROUP_NOTE_REF}`, "add", "-f", "-m", readNote(signer, files), sha]);
      if (a.includes("--push")) git(["push", "origin", `${GROUP_NOTE_REF}:${GROUP_NOTE_REF}`]);
      console.log(`READ ${sha.slice(0, 12)}: ${files.length} shared file(s)${a.includes("--push") ? ", pushed" : ""}`);
    } else { console.error('Usage: node scripts/group-check.mjs files [--sha <head>] | read --sha <40-hex> --signer "Checker 2" [--push]'); process.exit(2); }
  } catch (e) { console.error(`group-check: ${String(e?.message ?? e).split("\n")[0]}`); process.exit(1); }
}
