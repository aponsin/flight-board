// #C1074: board-release's pinned-file sign check (pendingPack) reads only the commits of origin/main..tip. A commit already on main was signed before Release
// landed it; it named 6729aae6 (#C1056) and be5ed68b (#C970), both landed, for every later tip. An unlanded commit of the range without a sign still flags.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingPack } from "../scripts/board-release.mjs";

const own = { checker: "PASS Full", security: "SECURE" }, none = { checker: "", security: "" };
const c = (sha, x = {}) => ({ sha: sha.repeat(40).slice(0, 40), fromPin: true, touches: true, notes: own, landed: false, ...x });
const run = (range) => pendingPack({ descends: true, range, sameAs: () => true });

test("pendingPack: a landed pinned commit with no note of its own is no flag; the tip's own sign is enough", () => {
  const landed = c("1", { notes: none, landed: true }), tip = c("2");
  const p = run([landed, tip]);
  assert.deepEqual(p.refusals, []);
  assert.equal(p.sha, tip.sha, "the waiting pack is still the newest pinned commit of the whole line");
});

test("pendingPack: an unlanded pinned commit of the range with no note still flags, named, and a landed one beside it is not named", () => {
  const landed = c("1", { notes: none, landed: true }), open = c("2", { notes: none }), tip = c("3");
  const p = run([landed, open, tip]);
  assert.equal(p.refusals.length, 1);
  assert.match(p.refusals[0], /isn't signed by both Checker and Security: 222222222222$/);
  assert.doesNotMatch(p.refusals[0], /111111111111/);
});

test("pendingPack: a landed commit with FINDINGS of its own is not asked either (it is main's); a commit with no `landed` reading is asked as before", () => {
  assert.deepEqual(run([c("1", { notes: { checker: "FINDINGS", security: "SECURE" }, landed: true }), c("2")]).refusals, []);
  const unread = c("1", { notes: none }); delete unread.landed;
  assert.match(run([unread, c("2")]).refusals.join(), /111111111111/);
});

test("board-release --dry-run: a tip on top of a landed pinned commit with no note passes; an unlanded pinned commit below the tip with no note is flagged", () => {
  const REPO = new URL("..", import.meta.url).pathname, D = mkdtempSync(join(tmpdir(), "landed-line-"));
  const git = (cwd, ...a) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const BASE = git(REPO, "rev-parse", "HEAD");
    execFileSync("git", ["init", "-q", "--bare", join(D, "origin.git")]);
    git(REPO, "push", "-q", join(D, "origin.git"), `${BASE}:refs/heads/main`);
    const W = join(D, "work");
    execFileSync("git", ["clone", "-q", join(D, "origin.git"), W]);
    const commit = (file, msg) => { appendFileSync(join(W, file), "\n// x\n"); git(W, "commit", "-qam", `${msg}\n\nBoard-Id: landed-card`); return git(W, "rev-parse", "HEAD"); };
    const note = (sha, checker, security) => { git(W, "notes", "--ref=checker", "add", "-f", "-m", checker, sha); git(W, "notes", "--ref=security", "add", "-f", "-m", security, sha); };
    const push = () => git(W, "push", "-q", "-f", "origin", "refs/notes/checker", "refs/notes/security");
    // Sx is a pinned change that LANDED (origin/main is at Sx) and carries no note of its own; P2 is a newer pinned change on top, signed.
    const Sx = commit("gate/tools.mjs", "the landed pack");
    git(W, "push", "-q", "origin", `${Sx}:refs/heads/main`);
    const P2 = commit("gate/stop.mjs", "a newer pack");
    const H = join(D, "home"), cfg = join(H, "board.config.json");
    mkdirSync(join(H, ".claude"), { recursive: true });
    const conf = JSON.parse(readFileSync(join(REPO, "board.config.example.json"), "utf8"));
    writeFileSync(cfg, JSON.stringify({ ...conf, artifactUrl: "https://claude.ai/" + "artifact/AbCdEfGh123", collector: { ...conf.collector, outDir: join(H, "out") } }));
    mkdirSync(join(H, ".flight-board/AbCdEfGh123/.claude"), { recursive: true });
    writeFileSync(join(H, ".flight-board/AbCdEfGh123/.claude/settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node '${H}/x/collector/fence.mjs' --send-to Manager` }] }] } }));
    writeFileSync(join(H, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `node '${H}/.flight-board/install/${BASE}/gate/stop.mjs' --config '${cfg}'` }] }] } }));
    const go = (sha) => { try { return { ok: true, out: execFileSync(process.execPath, [join(REPO, "scripts/board-release.mjs"), sha, "--dry-run"], { env: { ...process.env, HOME: H, FLIGHT_BOARD_REPO: W, BOARD_PACK: "v3.51" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; } catch (e) { return { ok: false, out: `${e.stdout}${e.stderr}` }; } };
    note(P2, "PASS Full", "SECURE"); push();
    const after = go(P2);
    assert.ok(after.ok, after.out);
    assert.doesNotMatch(after.out, new RegExp(`isn't signed by both Checker and Security: .*${Sx.slice(0, 12)}`));
    // Now Sx has NOT landed: main is the pin again, so Sx is a commit of main..tip with no note: flagged.
    git(W, "push", "-q", "-f", "origin", `${BASE}:refs/heads/main`);
    const before = go(P2);
    assert.ok(!before.ok && new RegExp(`isn't signed by both Checker and Security: ${Sx.slice(0, 12)}`).test(before.out), before.out);
  } finally { rmSync(D, { recursive: true, force: true }); }
});
