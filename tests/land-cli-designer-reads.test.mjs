// #C1408 (Checker 2's LOW on #C1407 at 34ff8904): two mutants of scripts/board-land.mjs's command-line part survived the whole suite: (1) the `designer: designerFacts(...)` field of each head, and
// (2) the `+refs/notes/designer` fetch. The release tool's dry run caught both, but the landing job's own plan must too. The real script runs here, from a pinned-install-shaped folder, in a scratch
// home with a scratch origin; the owner's pinned release tool is a stub that leaves a marker when it is started, so "the plan refused it" and "the release tool refused it" read apart.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const SRC = new URL("..", import.meta.url).pathname, SELF = "a".repeat(40), PIN = "b".repeat(40), CARD = "sample-card-a";

function scene() {
  const D = mkdtempSync(join(tmpdir(), "land-cli-designer-")), H = join(D, "home"), ORIGIN = join(D, "origin.git"), W = join(D, "work"), C = join(D, "land-clone");
  const git = (cwd, ...a) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", ORIGIN]);
  execFileSync("git", ["clone", "-q", ORIGIN, W], { stdio: "ignore" });
  git(W, "checkout", "-q", "-b", "main");
  mkdirSync(join(W, "page")); writeFileSync(join(W, "page/board.template.html"), "page\n");
  git(W, "add", "-A"); git(W, "commit", "-qm", "start"); git(W, "push", "-q", "origin", "main");
  git(W, "checkout", "-q", "-b", `build/${CARD}`);
  appendFileSync(join(W, "page/board.template.html"), "<!-- changed -->\n");
  git(W, "commit", "-qam", `a page change\n\nBoard-Id: ${CARD}`);
  const tip = git(W, "rev-parse", "HEAD");
  git(W, "push", "-q", "origin", `build/${CARD}`);
  git(W, "notes", "--ref=checker", "add", "-f", "-m", "PASS Quick", tip); git(W, "notes", "--ref=security", "add", "-f", "-m", "SECURE", tip);
  git(W, "push", "-q", "origin", "refs/notes/checker", "refs/notes/security");
  // The landing job's own clone: it has never seen the notes; the script has to fetch them.
  execFileSync("git", ["clone", "-q", ORIGIN, C], { stdio: "ignore" });
  // The scratch home: the script as a pinned install, the owner's pinned release tool (a stub), the config, a fresh holds file that frees the card.
  for (const dir of ["scripts", "worker", "collector", "gate", "hooks"]) cpSync(join(SRC, dir), join(H, ".flight-board", "install", SELF, dir), { recursive: true });
  mkdirSync(join(H, ".flight-board", "install", PIN, "scripts"), { recursive: true });
  writeFileSync(join(H, ".flight-board", "install", PIN, "scripts", "board-release.mjs"), 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.LAND_MARK, process.argv[2] + "\\n");\nconsole.log("ok  stub release tool");\n');
  mkdirSync(join(H, ".claude"), { recursive: true });
  writeFileSync(join(H, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `node '${H}/.flight-board/install/${PIN}/gate/stop.mjs'` }] }] } }));
  const conf = JSON.parse(readFileSync(join(SRC, "board.config.example.json"), "utf8")), cfg = join(H, "board.config.json");
  writeFileSync(cfg, JSON.stringify({ ...conf, artifactUrl: "https://claude.ai/" + "artifact/AbCdEfGh123" }));
  const state = join(H, ".flight-board", "AbCdEfGh123"); mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "land-holds.json"), JSON.stringify({ at: Date.now(), cards: { [CARD]: "" } }));
  const mark = join(D, "release-started");
  const designer = (text) => { git(W, "notes", "--ref=designer", "add", "-f", "-m", text, tip); git(W, "push", "-q", "-f", "origin", "refs/notes/designer"); };
  const run = () => {
    rmSync(mark, { force: true });
    const r = spawnSync(process.execPath, [join(H, ".flight-board/install", SELF, "scripts/board-land.mjs"), "--config", cfg, "--dry-run"], { encoding: "utf8", env: { HOME: H, PATH: process.env.PATH, FLIGHT_BOARD_REPO: C, LAND_MARK: mark } });
    return { out: `${r.stdout}${r.stderr}`, released: existsSync(mark) ? readFileSync(mark, "utf8").trim() : null };
  };
  return { D, tip, designer, run };
}

test("board-land's command line: Designer's FINDINGS on origin refuses the tip in the plan, before any release tool starts; a LOOK-OK on origin lets it reach the release tool", () => {
  const s = scene();
  try {
    // The note is on origin only: the script's own fetch of refs/notes/designer brings it (mutant 2: no fetch, no note), and its heads carry the facts (mutant 1: no facts, the stub starts).
    s.designer(`FINDINGS #C1408: the scratch page`);
    const findings = s.run();
    assert.equal(findings.released, null, `the plan refused the tip, so the release tool never started\n${findings.out}`);
    assert.match(findings.out, new RegExp(`REFUSED build/${CARD} ${s.tip.slice(0, 12)}: Designer's FINDINGS note stands on this tip`), findings.out);
    s.designer(`LOOK-OK #C1408: the scratch page`);
    const ok = s.run();
    assert.equal(ok.released, s.tip, `a page change with Designer's LOOK-OK on origin reaches the release tool\n${ok.out}`);
    assert.doesNotMatch(ok.out, /REFUSED/, ok.out);
  } finally { rmSync(s.D, { recursive: true, force: true }); }
});
