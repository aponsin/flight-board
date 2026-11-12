// A scratch origin and work clone for running scripts/board-release.mjs --dry-run end to end: the pin B is this checkout's HEAD, X is one signed (or unsigned) commit
// on it that changes `file`. withNotes: push Checker's and Security's notes for X to origin; without, origin has no notes refs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPO = new URL("../..", import.meta.url).pathname;

export function scratch({ withNotes, file = "scripts/board-release.mjs" }) {
  const D = mkdtempSync(join(tmpdir(), "release-scratch-"));
  const git = (cwd, ...a) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const B = git(REPO, "rev-parse", "HEAD");
  execFileSync("git", ["init", "-q", "--bare", join(D, "origin.git")]);
  git(REPO, "push", "-q", join(D, "origin.git"), `${B}:refs/heads/main`);
  const W = join(D, "work");
  execFileSync("git", ["clone", "-q", join(D, "origin.git"), W]);
  appendFileSync(join(W, file), file.endsWith(".py") ? "\n# x\n" : "\n// x\n");
  git(W, "commit", "-qam", "a change\n\nBoard-Id: scratch-card");
  const X = git(W, "rev-parse", "HEAD");
  if (withNotes) {
    git(W, "notes", "--ref=checker", "add", "-f", "-m", "PASS Full", X);
    git(W, "notes", "--ref=security", "add", "-f", "-m", "SECURE", X);
    git(W, "push", "-q", "origin", "refs/notes/checker", "refs/notes/security");
  }
  const H = join(D, "home"), cfg = join(H, "board.config.json");
  mkdirSync(join(H, ".claude"), { recursive: true });
  const conf = JSON.parse(readFileSync(join(REPO, "board.config.example.json"), "utf8"));
  writeFileSync(cfg, JSON.stringify({ ...conf, artifactUrl: "https://claude.ai/" + "artifact/AbCdEfGh123", collector: { ...conf.collector, outDir: join(H, "out") } }));
  mkdirSync(join(H, ".flight-board/AbCdEfGh123/.claude"), { recursive: true });
  writeFileSync(join(H, ".flight-board/AbCdEfGh123/.claude/settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node '${H}/x/collector/fence.mjs' --send-to Manager` }] }] } }));
  writeFileSync(join(H, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `node '${H}/.flight-board/install/${B}/gate/gate.mjs' --config '${cfg}'` }] }] } }));
  const run = (sha) => { try { return { ok: true, out: execFileSync(process.execPath, [join(REPO, "scripts/board-release.mjs"), sha, "--dry-run"], { env: { ...process.env, HOME: H, FLIGHT_BOARD_REPO: W, BOARD_PACK: "v3.51" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; } catch (e) { return { ok: false, out: `${e.stdout}${e.stderr}` }; } };
  return { D, X, run };
}
