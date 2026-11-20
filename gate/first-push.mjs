// #C1065: a PreToolUse hook that refuses the first edit on a card branch that is not pushed yet. The board counts a card as started only from its first push
// (#C1059 was worked about 30 minutes with none, so the board showed its group as not started). It guards Edit, Write, MultiEdit, NotebookEdit and the file writes of Bash.
//   refused: a write to a file inside a git work tree whose branch is a card branch (build/, admin/, mainsite/, lang/ ...) and is not on origin
//   allowed: git commands themselves (the push, the empty commit), files outside any repository (the scratchpad's message files), a repository the board config does not
//   name (NO git runs there: git would honor that repository's own core.sshCommand, #C1065 v3), anything inside .git, a branch that is not a card branch (main, dev,
//   manager/ ...), a detached HEAD, a branch the remote-tracking ref shows (no network call), and EVERY doubt: a git call that fails, a config that cannot be read, a command
//   that cannot be read. The hook never blocks on its own failure (exit 0).
// Bash is read best-effort: the targets of a redirection (> and >>), tee, sed -i, perl -i, cp and mv (the last word), rm, touch, mkdir and rmdir (every word) are the
// writes; a command that only reads, or only runs git, node or npm, is never refused.
// Refusal: exit 2 with the reason on stderr (the tool call does not run). Usage in settings: node gate/first-push.mjs --config <board.config.json> (read only for the checkouts it names).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CARD_BRANCH = /^(?:build|admin|mainsite|lang|demos|sales|ops|steward|triage|reviewer)\/[A-Za-z0-9._\/-]+$/;
export const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export const reason = (branch) => `Push this branch first (an empty commit is fine): the board counts a card as started from its first push. ${branch} is not on origin yet: git commit --allow-empty -m "<card> WIP" with the card's Board-Id trailer, then git push origin ${branch}. (#C1065)`;

const realGit = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }).trim();

// The words of one command segment, quotes taken off (best effort: no escapes, no substitutions).
const words = (s) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/, "$2"));

// The files a Bash command writes, as written (relative ones are the caller's to resolve against the cwd).
export function bashTargets(command) {
  const out = [];
  // A heredoc's body is text, not commands; quoted text (a commit message with a ">" or a ";" in it) is never a redirection or a separator. The command is read on a copy
  // whose quoted text is masked by "Q"s, and the pieces are cut from the original at the same places.
  const text = String(command ?? "").replace(/(<<-?[ \t]*(["']?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, "$1");
  const mask = text.replace(/"[^"]*"|'[^']*'/g, (m) => "Q".repeat(m.length));
  const segs = []; let from = 0;
  for (const m of mask.matchAll(/&&|\|\||;|\||\n/g)) { segs.push([from, m.index]); from = m.index + m[0].length; }
  segs.push([from, mask.length]);
  for (const [a, b] of segs) {
    const s = text.slice(a, b).trim(), ms = mask.slice(a, b).trim();
    if (!s) continue;
    for (const m of ms.matchAll(/(?:^|[^\d&<>])>>?\s*([^\s&|;<>()]+)/g)) {
      const at = m.index + m[0].length - m[1].length, target = s.slice(at, at + m[1].length).replace(/^(["'])(.*)\1$/, "$2");
      if (target !== "/dev/null") out.push(target);
    }
    const w = words(s);
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
    const [cmd, ...args] = w;
    const plain = args.filter((a) => !a.startsWith("-") && !a.startsWith(">"));
    if (cmd === "tee") out.push(...plain);
    else if ((cmd === "sed" || cmd === "perl") && args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith("-i"))) { if (plain.length) out.push(plain.at(-1)); }
    else if (cmd === "cp" || cmd === "mv") { if (plain.length > 1) out.push(plain.at(-1)); }
    else if (cmd === "rm" || cmd === "touch" || cmd === "mkdir" || cmd === "rmdir") out.push(...plain);
  }
  return out.filter((t) => t && !t.startsWith("&"));
}

// The nearest folder of `file` that exists (a new file's folder may not).
function nearestDir(file) {
  let d = dirname(file);
  while (!existsSync(d)) { const up = dirname(d); if (up === d) return null; d = up; }
  return d;
}

// Is the branch on origin? Only the remote-tracking ref is asked (a local read: no network, so no ssh command of any repository runs; `git push` writes that ref).
function onOrigin(top, branch, git) {
  try { git(top, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]); return true; } catch { return false; }
}

// #C1065 v3 (Security's M1): git honors a repository's own .git/config (core.sshCommand, ...), so the hook runs git ONLY in a checkout the board config names, and finds out
// whether a folder is one by READING files, never by running git there. The checkouts: collector.repoPath, collector.repos[].path, collector.refresh.repos (~ allowed).
export function configCheckouts(configPath) {
  try {
    const c = JSON.parse(readFileSync(configPath, "utf8")), k = c?.collector ?? {}, out = [];
    for (const p of [k.repoPath, ...(Array.isArray(k.repos) ? k.repos.map((r) => r?.path) : []), ...(Array.isArray(k.refresh?.repos) ? k.refresh.repos : [])]) {
      if (typeof p !== "string" || !p) continue;
      try { out.push(realpathSync(p.replace(/^~(?=\/|$)/, homedir()))); } catch { /* not there */ }
    }
    return out;
  } catch { return []; }
}

// The folder holding the nearest ".git" above `dir`, and the common git folder it belongs to (a linked worktree's .git FILE says gitdir: <repo>/.git/worktrees/x, whose
// "commondir" file points back to <repo>/.git). File reads only.
function gitHome(dir) {
  let d = dir;
  for (;;) {
    const g = resolve(d, ".git");
    if (existsSync(g)) {
      try {
        let gd = g;
        if (!statSync(g).isDirectory()) { const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, "utf8")); if (!m) return null; gd = resolve(d, m[1].trim()); }
        let common = gd;
        try { common = resolve(gd, readFileSync(resolve(gd, "commondir"), "utf8").trim()); } catch { /* no commondir: gd is the common folder */ }
        return { top: realpathSync(d), common: realpathSync(common) };
      } catch { return null; }
    }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}
const namedCheckout = (dir, checkouts) => { const h = gitHome(dir); return h && checkouts.some((c) => h.common === resolve(c, ".git")) ? h.top : null; };

// #C1285 (11-19: a commit said "Board-Id: C1274", not the card's id, so once its branches were deleted nothing could find the card and the board kept showing a ship in progress): a git commit whose
// message, as typed in the command, has a Board-Id trailer that is not a valid card id (BOARD_ID_SHAPE in collector/board-id.mjs, the shape the landing job reads: lowercase letters, digits and hyphens)
// is refused before it is made, naming the right form. Text only (no git runs), so it holds in any repository, the board's own or a product's. A message read from a file (-F) or built by a shell
// substitution cannot be seen and is let through; the hook never blocks on its own doubt.
export const BOARD_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const badBoardIdReason = (value) => `Board-Id must be the card's id: lowercase letters, digits and hyphens, as the board shows it (for example "picture-option-looks-clickable"), not "${String(value).slice(0, 40)}". A commit with any other value cannot be found once its branch is deleted. Fix the trailer in the commit message and commit again. (#C1285)`;
// Checker 2's F1 on 4a694486: only a TRAILER line counts (the line starts with Board-Id, after a real newline or a literal \n inside -m), so prose that mentions a bad id is let through; and only the
// git commit command's own segment is read (cut at &&, ||, ; and | outside quotes and heredocs), so a later git log --grep or echo is not.
const commitSegments = (text) => {
  const noDocs = text.replace(/(<<-?[ \t]*(["']?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, (m, head) => head + "Q".repeat(m.length - head.length));
  const mask = noDocs.replace(/"[^"]*"|'[^']*'/g, (m) => "Q".repeat(m.length));
  const out = []; let from = 0;
  const cut = (to) => { const ms = mask.slice(from, to); if (/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*git\b/.test(ms) && /\bcommit\b/.test(ms)) out.push(text.slice(from, to)); };
  for (const m of mask.matchAll(/&&|\|\||;|\||\n/g)) { cut(m.index); from = m.index + m[0].length; }
  cut(mask.length);
  return out;
};
export function boardIdRefusal(command) {
  try {
    for (const seg of commitSegments(String(command ?? ""))) {
      for (const line of seg.split(/\r?\n|\\n/)) {
        const m = /^[ \t]*Board-Id[ \t]*:[ \t]*([^\s"'`\\]*)["'`]*[ \t]*$/i.exec(line);
        if (!m) continue;
        const value = m[1];
        if (!value || /[<>$(){}]/.test(value)) continue; // an empty value (a message built elsewhere), a placeholder or a shell expansion: not read
        if (!BOARD_ID_SHAPE.test(value)) return badBoardIdReason(value);
      }
    }
  } catch { /* every doubt allows */ }
  return null;
}

// The refusal text for one tool call ({ tool_name, tool_input, cwd }), or null.
export function refusal(call, git = realGit, checkouts = []) {
  try {
    const tool = call?.tool_name, input = call?.tool_input ?? {}, cwd = typeof call?.cwd === "string" && call.cwd ? call.cwd : process.cwd();
    if (tool === "Bash") { const bad = boardIdRefusal(input.command); if (bad) return bad; }
    let targets = [];
    if (FILE_TOOLS.has(tool)) targets = [input.file_path ?? input.notebook_path].filter((p) => typeof p === "string" && p);
    else if (tool === "Bash") targets = bashTargets(input.command);
    else return null;
    for (const t of targets) {
      const file = resolve(cwd, t);
      const dir = nearestDir(file);
      if (!dir) continue;
      const top = namedCheckout(dir, checkouts); // not in a checkout the config names (or in no repository): no git runs there
      if (!top) continue;
      let real = file;
      try { real = resolve(realpathSync(dir), relative(dir, file)); } catch { /* keep */ }
      if (real === resolve(top, ".git") || real.startsWith(resolve(top, ".git") + sep)) continue;
      let branch;
      try { branch = git(top, ["symbolic-ref", "--short", "-q", "HEAD"]); } catch { continue; } // a detached HEAD
      if (!CARD_BRANCH.test(branch)) continue;
      if (onOrigin(top, branch, git)) continue;
      return reason(branch);
    }
  } catch { /* every doubt allows */ }
  return null;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let call = null;
  try { call = JSON.parse(readFileSync(0, "utf8")); } catch { /* unreadable: allow */ }
  const at = process.argv.indexOf("--config"), cfg = at > 0 ? process.argv[at + 1] : null;
  const why = call && cfg ? refusal(call, realGit, configCheckouts(cfg)) : null;
  if (why) { console.error(why); process.exit(2); }
}
