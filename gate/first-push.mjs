// #C1065: a PreToolUse hook that refuses the first edit on a card branch that is not pushed yet. The board counts a card as started only from its first push
// (#C1059 was worked about 30 minutes with none, so the board showed its group as not started). It guards Edit, Write, MultiEdit, NotebookEdit and the file writes of Bash.
//   refused: a write to a file inside a git work tree whose branch is a card branch (build/, admin/, mainsite/, lang/ ...) and is not on origin
//   allowed: git commands themselves (the push, the empty commit), files outside any repository (the scratchpad's message files), anything inside .git, a branch that is not
//   a card branch (main, dev, manager/ ...), a detached HEAD, a branch origin has, and EVERY doubt: a git call that fails, a remote that cannot be reached, a command that
//   cannot be read. The hook never blocks on its own failure (exit 0).
// Bash is read best-effort: the targets of a redirection (> and >>), tee, sed -i, perl -i, cp and mv (the last word), rm, touch, mkdir and rmdir (every word) are the
// writes; a command that only reads, or only runs git, node or npm, is never refused.
// Refusal: exit 2 with the reason on stderr (the tool call does not run). Usage in settings: node gate/first-push.mjs --config <board.config.json> (the config is not read).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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

// Is the branch on origin? The remote-tracking ref says so at once; else ask the remote (exit 2 = it has no such branch); a remote that cannot be asked counts as yes.
function onOrigin(top, branch, git) {
  try { git(top, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]); return true; } catch { /* not seen: ask the remote */ }
  try { git(top, ["ls-remote", "--exit-code", "--heads", "origin", branch]); return true; } catch (e) { return e?.status !== 2; }
}

// The refusal text for one tool call ({ tool_name, tool_input, cwd }), or null.
export function refusal(call, git = realGit) {
  try {
    const tool = call?.tool_name, input = call?.tool_input ?? {}, cwd = typeof call?.cwd === "string" && call.cwd ? call.cwd : process.cwd();
    let targets = [];
    if (FILE_TOOLS.has(tool)) targets = [input.file_path ?? input.notebook_path].filter((p) => typeof p === "string" && p);
    else if (tool === "Bash") targets = bashTargets(input.command);
    else return null;
    for (const t of targets) {
      const file = resolve(cwd, t);
      const dir = nearestDir(file);
      if (!dir) continue;
      let top;
      try { top = realpathSync(git(dir, ["rev-parse", "--show-toplevel"])); } catch { continue; } // not in a repository
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
  const why = call ? refusal(call) : null;
  if (why) { console.error(why); process.exit(2); }
}
