// A reviewer's sign-off note that never replaces another signer's (#C1035). Checker and Checker 2 both write refs/notes/checker, and a plain
// `git notes add -f` by one erased the other's PASS twice on 11-12 (#C1019, #C1020). This writes the note with a trailing line `signed-by: <name>` and
// refuses, changing nothing, when a note is already on the commit (in the checkout's notes ref or on origin's) unless it carries the same signer:
//   node scripts/sign-note.mjs --role checker|security --sha <40-hex> --signer "Checker 2" --line "PASS (Quick) ..." [--push]
// The first line is what the release tool reads (PASS / SECURE / FINDINGS ...); the second line is for this tool. A note with no signed-by line (written
// before this tool) is another signer's too: ask Manager. Run it inside the checkout that holds the commit.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ROLE_REFS = { checker: "refs/notes/checker", security: "refs/notes/security" };
const SIGNER = /^[A-Za-z][A-Za-z0-9 ]{0,30}$/;
class Refusal extends Error {}
const fail = (why) => { throw new Refusal(why); };

// The signer a note names on its signed-by line, null when it names none.
export const signerOf = (note) => /^signed-by: ([A-Za-z][A-Za-z0-9 ]{0,30})$/m.exec(String(note ?? ""))?.[1] ?? null;

// run(args) -> trimmed stdout, throws on a non-zero exit (git, in the checkout). Returns the line printed.
export function signNote({ run, role, sha, signer, line, push = false }) {
  const ref = ROLE_REFS[role];
  if (!ref) fail("--role is checker or security");
  if (!/^[0-9a-f]{40}$/.test(String(sha))) fail("--sha is the commit's full 40-character lower-case hex");
  if (!SIGNER.test(String(signer ?? ""))) fail("--signer is your own name, such as Checker 2");
  const first = String(line ?? "");
  if (!first.trim() || /[\r\n]/.test(first)) fail("--line is the note's one first line (PASS ..., SECURE ..., FINDINGS ...)");
  const tryRun = (a) => { try { return { out: String(run(a)).replace(/\n+$/, "") }; } catch (e) { return { error: String(e?.stderr ?? e?.message ?? e).trim().split("\n")[0] }; } };
  // origin's copy of the notes ref, into a private ref (a missing one is fine: nothing signed yet there).
  const priv = `refs/notes/sign-note-${role}`;
  tryRun(["fetch", "-q", "origin", `+${ref}:${priv}`]);
  for (const r of [ref, priv]) {
    const have = tryRun(["notes", `--ref=${r}`, "show", sha]);
    if (have.out === undefined) continue; // no note there
    const by = signerOf(have.out);
    if (by !== signer) fail(by ? `${sha.slice(0, 12)} already has a ${role} note signed by ${by}; I will not replace it (ask Manager)` : `${sha.slice(0, 12)} already has a ${role} note with no signer ("${have.out.split("\n")[0].slice(0, 60)}"); I will not replace it (ask Manager)`);
  }
  // Write on top of origin's ref (Checker's F1): the other signer may have pushed a note on ANY commit since our last fetch, and a note added to the stale
  // local ref would make the push non-fast-forward. Merging origin's notes in first (a fast-forward when ours is behind or absent) keeps the push a fast-forward.
  // Origin wins EVERY conflict (-s theirs): a local note that was never pushed, on ANOTHER commit, must not overwrite the other signer's newer note there
  // (Security's risk). This sha is not affected: it was checked above, and the add -f below writes it last.
  if (tryRun(["rev-parse", "-q", "--verify", priv]).out) {
    const merged = tryRun(["notes", `--ref=${ref}`, "merge", "-s", "theirs", priv]);
    if (merged.error) fail(`could not bring origin's ${role} notes in: ${merged.error}`);
  }
  const added = tryRun(["notes", `--ref=${ref}`, "add", "-f", "-m", `${first}\nsigned-by: ${signer}`, sha]);
  if (added.error) fail(`git notes failed: ${added.error}`);
  if (push) { const sent = tryRun(["push", "origin", `${ref}:${ref}`]); if (sent.error) fail(`the note is written but the push failed: ${sent.error}`); }
  return `SIGNED ${role} ${sha.slice(0, 12)} as ${signer}${push ? ", pushed" : ""}`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2), val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const known = new Set(["--role", "--sha", "--signer", "--line", "--push"]);
  if (a.some((x, n) => x.startsWith("--") && !known.has(x)) || ["--role", "--sha", "--signer", "--line"].some((k) => val(k) === undefined)) {
    console.error('Usage: node scripts/sign-note.mjs --role checker|security --sha <40-hex> --signer "Checker 2" --line "PASS ..." [--push]'); process.exit(2);
  }
  const run = (g) => execFileSync("git", g, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try { console.log(signNote({ run, role: val("--role"), sha: val("--sha"), signer: val("--signer"), line: val("--line"), push: a.includes("--push") })); } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    console.log(`SIGN REFUSED: ${e.message}`); process.exit(1);
  }
}
