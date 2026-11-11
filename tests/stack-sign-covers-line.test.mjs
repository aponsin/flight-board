// #C934: one sign on a stack tip can cover its whole line from main. Both notes on the tip say "line from <main sha>" on their first line, and
// the release dry run then reads them as signing every pinned change between that base and the tip. Three times on 11-11 the dry run refused a
// signed tip because a lower commit lacked its own sign, and reviewers added line-scoped notes by hand. Fictional repository and names.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lineSign, pendingPack } from "../scripts/board-release.mjs";

const B = "b".repeat(40), OTHER = "c".repeat(40);
const own = { checker: "PASS Full", security: "SECURE" };
const line = (base, c = "PASS Full", s = "SECURE") => ({ checker: `${c} line from ${base}`, security: `${s} line from ${base}` });

test("lineSign: both notes say the same 40-hex base on their first line; anything else covers nothing", () => {
  assert.equal(lineSign(line(B)), B);
  assert.equal(lineSign({ checker: `PASS Full line from ${B}\nmore`, security: `SECURE line from ${B}` }), B);
  for (const n of [
    own,
    { checker: `PASS line from ${B}`, security: "SECURE" },
    { checker: "PASS", security: `SECURE line from ${B}` },
    { checker: `PASS line from ${B}`, security: `SECURE line from ${OTHER}` },
    { checker: `PASS line from ${B.slice(0, 12)}`, security: `SECURE line from ${B.slice(0, 12)}` },
    { checker: `FINDINGS line from ${B}`, security: `SECURE line from ${B}` },
    { checker: `PASS line from ${B}`, security: `FINDINGS line from ${B}` },
    { checker: `PASS\nline from ${B}`, security: `SECURE\nline from ${B}` },
    { checker: `PASS line from ${B.toUpperCase()}`, security: `SECURE line from ${B.toUpperCase()}` },
    null, {},
  ]) assert.equal(lineSign(n), null, JSON.stringify(n));
});

const c = (sha, x = {}) => ({ sha: sha.repeat(40).slice(0, 40), fromPin: true, touches: true, notes: own, ...x });
test("pendingPack: a lower pinned commit without its own sign is covered by a later commit's verified line sign", () => {
  const low = c("1", { notes: { checker: "", security: "" } }), mid = c("2", { notes: { checker: "FINDINGS", security: "SECURE" } }), tip = c("3", { notes: line(B), covers: [low.sha, mid.sha, c("3").sha] });
  const p = pendingPack({ descends: true, range: [low, mid, tip], sameAs: () => true });
  assert.equal(p.refusals.length, 0, JSON.stringify(p));
  assert.equal(p.sha, tip.sha);
});

test("pendingPack, still refused: no covers (base not an ancestor of main or of the tip), a commit outside the covered line, or a line sign that is not itself signed", () => {
  const low = c("1", { notes: { checker: "FINDINGS", security: "SECURE" } });
  const refused = (tip) => pendingPack({ descends: true, range: [low, tip], sameAs: () => true });
  assert.match(refused(c("3", { notes: line(B), covers: undefined })).refusals.join(), /isn't signed by both Checker and Security: 111111111111/, "the caller found the base is not an ancestor");
  assert.match(refused(c("3", { notes: line(B), covers: [] })).refusals.join(), /111111111111/, "the base is in the line but covers nothing below");
  assert.match(refused(c("3", { notes: line(B), covers: [c("4").sha] })).refusals.join(), /111111111111/, "another commit's cover is no cover for this one");
  assert.match(refused(c("3", { notes: own })).refusals.join(), /111111111111/, "a plain sign on the tip covers only the tip");
  const unsignedTip = refused(c("3", { notes: { checker: `PASS line from ${B}`, security: "", }, covers: [low.sha] }));
  assert.match(unsignedTip.refusals.join(), /111111111111/, "a tip that is not signed by both covers nothing");
});

// End to end, on a scratch clone, like tests/pack-wait.test.mjs: main is the pin B; a pack Sx (pinned file) and a tip P2 on it.
test("board-release --dry-run: a line sign on the tip covers a FINDINGS pack below it; a base off main, or a base that is not below the tip, does not", () => {
  const REPO = new URL("..", import.meta.url).pathname, D = mkdtempSync(join(tmpdir(), "line-sign-"));
  const git = (cwd, ...a) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const BASE = git(REPO, "rev-parse", "HEAD");
    execFileSync("git", ["init", "-q", "--bare", join(D, "origin.git")]);
    git(REPO, "push", "-q", join(D, "origin.git"), `${BASE}:refs/heads/main`);
    const W = join(D, "work");
    execFileSync("git", ["clone", "-q", join(D, "origin.git"), W]);
    const commit = (file, msg) => { appendFileSync(join(W, file), file.endsWith(".html") ? "\n<!-- x -->\n" : "\n// x\n"); git(W, "commit", "-qam", `${msg}\n\nBoard-Id: line-card`); return git(W, "rev-parse", "HEAD"); };
    const note = (sha, checker, security) => { git(W, "notes", "--ref=checker", "add", "-f", "-m", checker, sha); git(W, "notes", "--ref=security", "add", "-f", "-m", security, sha); };
    const push = () => git(W, "push", "-q", "-f", "origin", "refs/notes/checker", "refs/notes/security");
    const Sx = commit("gate/rules.mjs", "the pack");
    const P2 = commit("gate/gate.mjs", "a newer pack");
    const H = join(D, "home"), cfg = join(H, "board.config.json");
    mkdirSync(join(H, ".claude"), { recursive: true });
    const conf = JSON.parse(readFileSync(join(REPO, "board.config.example.json"), "utf8"));
    writeFileSync(cfg, JSON.stringify({ ...conf, artifactUrl: "https://claude.ai/" + "artifact/AbCdEfGh123", collector: { ...conf.collector, outDir: join(H, "out") } }));
    mkdirSync(join(H, ".flight-board/AbCdEfGh123/.claude"), { recursive: true });
    writeFileSync(join(H, ".flight-board/AbCdEfGh123/.claude/settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node '${H}/x/collector/fence.mjs' --send-to Manager` }] }] } }));
    writeFileSync(join(H, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `node '${H}/.flight-board/install/${BASE}/gate/gate.mjs' --config '${cfg}'` }] }] } }));
    const run = (sha) => { try { return { ok: true, out: execFileSync(process.execPath, [join(REPO, "scripts/board-release.mjs"), sha, "--dry-run"], { env: { ...process.env, HOME: H, FLIGHT_BOARD_REPO: W, BOARD_PACK: "v3.51" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; } catch (e) { return { ok: false, out: `${e.stdout}${e.stderr}` }; } };
    const unsigned = new RegExp(`isn't signed by both Checker and Security: ${Sx.slice(0, 12)}`);
    // The pack below has FINDINGS; the tip is signed on its own: refused (as today).
    note(Sx, "FINDINGS", "SECURE"); note(P2, "PASS Full", "SECURE"); push();
    const plain = run(P2);
    assert.ok(!plain.ok && unsigned.test(plain.out), plain.out);
    // The tip's notes say line from main's sha (the pin, an ancestor of main and of the tip): it covers the pack.
    note(P2, `PASS Full line from ${BASE}`, `SECURE line from ${BASE}`); push();
    const covered = run(P2);
    assert.ok(covered.ok, covered.out);
    assert.match(covered.out, new RegExp(`the waiting pack's only: ${P2.slice(0, 12)}`));
    // Refused: the base is a commit that is not on main (Sx itself), so it is not an ancestor of main.
    note(P2, `PASS Full line from ${Sx}`, `SECURE line from ${Sx}`); push();
    const offMain = run(P2);
    assert.ok(!offMain.ok && unsigned.test(offMain.out), offMain.out);
    // Refused: the two notes name different bases.
    note(P2, `PASS Full line from ${BASE}`, `SECURE line from ${Sx}`); push();
    const split = run(P2);
    assert.ok(!split.ok && unsigned.test(split.out), split.out);
    // Refused: a base that is not an ancestor of the tip (a commit on a side line that main also has).
    git(W, "checkout", "-q", "-b", "side", BASE); const Side = commit("collector/state.mjs", "side"); git(W, "push", "-q", "origin", "side:refs/heads/main"); git(W, "checkout", "-q", "main");
    note(P2, `PASS Full line from ${Side}`, `SECURE line from ${Side}`); push();
    const notBelow = run(P2);
    assert.ok(!notBelow.ok && unsigned.test(notBelow.out), notBelow.out);
  } finally { rmSync(D, { recursive: true, force: true }); }
});
