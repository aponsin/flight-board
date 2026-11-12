// The builder's re-cut of a signed card that no longer continues main (#C906). A landing moves main; a tip signed on the old main then cannot be
// released ("it doesn't continue main") and, because notes are keyed by sha, the re-cut needs a re-sign. When the landings since the tip's base touched
// NONE of the tip's files, the re-cut is a plain cherry-pick and the reviewers need only a range-diff check. This tool does exactly that, and nothing else:
//   node scripts/board-recut.mjs [--dry-run]            (run inside the builder's checkout; it never touches the tree, only a temporary worktree)
// For the newest build/<card>[-vN] branch of each card on origin whose tip carries Checker's PASS and Security's SECURE (read only from origin's notes,
// fetched into private refs), is not on main and does not continue main:
//   - if the landings since the tip's merge base with main touched any file the tip changed (a path, in either name of a rename): prints
//     "needs a human re-cut" and touches nothing;
//   - else cherry-picks the tip's commits (oldest first, no merge among them) onto origin/main in a temporary worktree. A conflict, an empty pick, or any
//     new commit whose message, changed paths, modes or blobs differ from the original's: prints "needs a human re-cut" and touches nothing;
//   - else pushes the result as build/<card>-v(N+1) (a fast-forward-only push of a new branch, never forced) and prints `old -> new`.
// It never writes, copies or forges a note: the new tip is unsigned until the reviewers sign it. --dry-run does everything but the push.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Private copies of origin's notes (git reads a notes ref only under refs/notes/); the checkout's own notes refs are never touched.
export const NOTE_REFS = { checker: "refs/notes/board-recut-checker", security: "refs/notes/board-recut-security" };
const ORIGIN_NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
export const CARD_BRANCH = /^build\/([a-z0-9][a-z0-9-]{0,63}?)(?:-v(\d{1,4}))?$/;
const HEX40 = /^[0-9a-f]{40}$/;

// The notes' first lines: Checker's PASS and Security's SECURE, on this exact sha.
export const signed = (notes) => /^PASS\b/.test(String(notes?.checker ?? "").split("\n")[0].trim()) && /^SECURE\b/.test(String(notes?.security ?? "").split("\n")[0].trim());

// origin's build branches [{ branch, sha }] -> the newest branch of each card: [{ card, n, branch, sha }].
export function newestPerCard(heads) {
  const best = new Map();
  for (const h of Array.isArray(heads) ? heads : []) {
    const m = CARD_BRANCH.exec(String(h?.branch)); if (!m || !HEX40.test(String(h.sha))) continue;
    const n = m[2] ? Number(m[2]) : 1, cur = best.get(m[1]);
    if (!cur || n > cur.n) best.set(m[1], { card: m[1], n, branch: h.branch, sha: h.sha });
  }
  return [...best.values()].sort((a, b) => a.card.localeCompare(b.card));
}

// The version of every origin branch of a card (build/<card> is 1).
const versionsOf = (heads, card) => heads.map((h) => CARD_BRANCH.exec(h.branch)).filter((m) => m && m[1] === card).map((m) => (m[2] ? Number(m[2]) : 1));

// `git diff-tree -r --no-renames` raw lines -> the facts that must be equal between an original commit and its copy: status, path, new mode, new blob.
export function changeSet(raw) {
  return String(raw ?? "").split("\n").filter((l) => l.startsWith(":")).map((l) => {
    const [meta, path] = l.split("\t"), f = meta.slice(1).split(" ");
    return `${f[4]}\t${path}\t${f[1]}\t${f[3]}`;
  }).sort();
}

// run(args, { cwd }) -> stdout (throws on a non-zero exit). push: false for --dry-run. Returns { lines, results }.
export function recut({ run, push = true, mkWorktree, rmWorktree }) {
  const out = (args, o) => String(run(args, o)).replace(/\n+$/, "");
  const lines = [], results = [];
  const note = (r, line) => { results.push(r); lines.push(line); };
  out(["fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  for (const k of Object.keys(NOTE_REFS)) { try { out(["fetch", "-q", "origin", `+${ORIGIN_NOTES[k]}:${NOTE_REFS[k]}`]); } catch { /* none yet: nothing is signed by that role */ } }
  const main = out(["rev-parse", "origin/main"]);
  const heads = out(["for-each-ref", "--format=%(refname:strip=3) %(objectname)", "refs/remotes/origin/build"]).split("\n").filter(Boolean)
    .map((l) => { const [b, sha] = l.split(" "); return { branch: b, sha }; });
  const all = new Set(heads.map((h) => h.branch));
  const noteOf = (ref, sha) => { try { return out(["notes", `--ref=${ref}`, "show", sha]); } catch { return ""; } };
  const isAncestor = (a, b) => { try { run(["merge-base", "--is-ancestor", a, b]); return true; } catch { return false; } };
  for (const t of newestPerCard(heads)) {
    const tag = `${t.branch} ${t.sha.slice(0, 12)}`;
    if (isAncestor(t.sha, main)) continue;                       // landed
    if (isAncestor(main, t.sha)) continue;                       // continues main: nothing to do
    if (!signed({ checker: noteOf(NOTE_REFS.checker, t.sha), security: noteOf(NOTE_REFS.security, t.sha) })) continue;
    const human = (why) => note({ branch: t.branch, sha: t.sha, human: why }, `${tag}: needs a human re-cut (${why})`);
    const base = out(["merge-base", main, t.sha]);
    const commits = out(["rev-list", "--reverse", `${base}..${t.sha}`]).split("\n").filter(Boolean);
    if (!commits.length) { human("no commits since the base"); continue; }
    if (out(["rev-list", "--merges", `${base}..${t.sha}`])) { human("a merge commit on the line"); continue; }
    // Every path any commit of the tip changed, and every path any landing since the base changed (per commit, so a path changed and changed back counts).
    const names = (args) => out(args).split("\n").filter(Boolean);
    const tipFiles = new Set(commits.flatMap((c) => names(["diff-tree", "-r", "--no-renames", "--no-commit-id", "--name-only", `${c}^`, c])));
    const landed = new Set(names(["log", "--no-renames", "--name-only", "--format=", `${base}..${main}`]));
    const clash = [...tipFiles].filter((p) => landed.has(p));
    if (clash.length) { human(`the landings since its base touched ${clash.slice(0, 3).join(", ")}${clash.length > 3 ? ` and ${clash.length - 3} more` : ""}`); continue; }
    let wt = null;
    try {
      wt = mkWorktree(main);
      const w = { cwd: wt };
      const copies = [];
      let why = null;
      for (const c of commits) {
        try { out(["cherry-pick", "--allow-empty-message", c], w); } catch { try { out(["cherry-pick", "--abort"], w); } catch { /* none */ } why = `conflict on ${c.slice(0, 12)}`; break; }
        const n = out(["rev-parse", "HEAD"], w);
        if (n === c) { why = `empty pick of ${c.slice(0, 12)}`; break; }
        const same = out(["log", "-1", "--format=%B", n], w) === out(["log", "-1", "--format=%B", c], w)
          && out(["rev-list", "--parents", "-n", "1", n], w).split(" ").length === 2
          && JSON.stringify(changeSet(out(["diff-tree", "-r", "--no-renames", "--no-commit-id", `${n}^`, n], w))) === JSON.stringify(changeSet(out(["diff-tree", "-r", "--no-renames", "--no-commit-id", `${c}^`, c], w)));
        if (!same) { why = `${c.slice(0, 12)} differs from its copy`; break; }
        copies.push(n);
      }
      if (why) { human(why); continue; }
      const tip = copies.at(-1);
      const next = `build/${t.card}-v${Math.max(t.n, ...versionsOf(heads, t.card)) + 1}`;
      if (all.has(next)) { human(`${next} already exists`); continue; }
      if (push) {
        try { out(["push", "origin", `${tip}:refs/heads/${next}`], w); } catch (e) { human(`push refused: ${String(e?.stderr ?? e?.message ?? e).trim().split("\n")[0]}`); continue; }
      }
      note({ branch: t.branch, sha: t.sha, next, tip, pushed: push }, `${tag} -> ${next} ${tip}${push ? "" : " (dry run: not pushed)"}`);
    } finally { if (wt) rmWorktree(wt); }
  }
  if (!lines.length) lines.push("RECUT: nothing to re-cut");
  return { lines, results };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--dry-run")) { console.error("Usage: node scripts/board-recut.mjs [--dry-run]"); process.exit(2); }
  const run = (a, o = {}) => execFileSync("git", a, { cwd: o.cwd ?? process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  const mkWorktree = (sha) => { const d = mkdtempSync(join(tmpdir(), "board-recut-")); run(["worktree", "add", "--detach", d, sha]); return d; };
  const rmWorktree = (d) => { try { run(["worktree", "remove", "--force", d]); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); };
  try { console.log(recut({ run, push: !args.includes("--dry-run"), mkWorktree, rmWorktree }).lines.join("\n")); } catch (e) {
    console.log(`RECUT FAILED: ${String(e?.stderr ?? e?.message ?? e).trim().split("\n")[0]}`); process.exit(1);
  }
}
