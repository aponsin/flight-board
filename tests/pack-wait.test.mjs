// A page release never waits behind an install pack (#C412, Director: v3.19's pack waited 564 min and held four page
// releases; Security's ruling on plan A). A release built on a signed pack S goes out when it adds no pinned change of
// its own; S is worked out, never named; the link never moves back from such a release to S.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingPack, verdict } from "../scripts/board-release.mjs";
import { linkMove } from "../scripts/current.mjs";

const SIGNED = { checker: "PASS Full", security: "SECURE" };
const c = (sha, x = {}) => ({ sha: sha.repeat(40).slice(0, 40), fromPin: true, touches: false, notes: SIGNED, ...x });
const S = "5".repeat(40);

test("no pinned change on the line: no pack waits (null), and the release is judged as before", () => {
  assert.equal(pendingPack({ descends: true, range: [c("a"), c("b")], sameAs: () => true }), null);
});

test("one signed pack, the release adds nothing pinned: S is found, no refusal", () => {
  const p = pendingPack({ descends: true, range: [c("a"), c("5", { touches: true }), c("b")], sameAs: (s) => s === S });
  assert.deepEqual(p, { sha: S, refusals: [] });
});

test("two pinned changes on the line: the newest is S, and every one of them must be signed", () => {
  const range = [c("4", { touches: true }), c("5", { touches: true }), c("b")];
  assert.equal(pendingPack({ descends: true, range, sameAs: () => true }).sha, S);
  const p = pendingPack({ descends: true, range: [c("4", { touches: true, notes: { checker: "PASS", security: "" } }), ...range.slice(1)], sameAs: () => true });
  assert.equal(p.sha, null);
  assert.match(p.refusals.join(), /isn't signed by both Checker and Security: 444444444444/);
});

test("refused: S unsigned, a pinned change after S, a side branch, or not from the pin", () => {
  const bad = (x, sameAs = () => true) => pendingPack({ descends: true, range: [c("5", { touches: true, ...x })], sameAs, ...(x.top ?? {}) });
  assert.match(bad({ notes: { checker: "FINDINGS", security: "SECURE" } }).refusals.join(), /isn't signed/);
  assert.match(bad({}, () => false).refusals.join(), /changes what the owner's install pins after the waiting pack 555555555555/);
  assert.match(bad({ fromPin: false }).refusals.join(), /don't descend from the commit the owner's install pins \(a side branch\)/);
  assert.match(pendingPack({ descends: false, range: [c("5", { touches: true })], sameAs: () => true }).refusals.join(), /doesn't descend from the commit the owner's install pins/);
});

test("verdict: a waiting pack it accepts covers the pinned files and the settings block; refusals replace the file list", () => {
  const base = { forward: true, notes: SIGNED, pinned: "1".repeat(40), changed: ["gate/rules.mjs", "page/board.template.html"], owned: ["gate/rules.mjs"], settingsChanged: true, capabilities: ["db"] };
  assert.equal(verdict(base).ok, false, "as before, with no pack");
  assert.deepEqual(verdict({ ...base, pending: { sha: S, refusals: [] } }).refusals, []);
  const r = verdict({ ...base, pending: { sha: null, refusals: ["a pinned change on its line isn't signed"] } }).refusals;
  assert.ok(r.includes("a pinned change on its line isn't signed") && r.some((x) => /settings block/.test(x)) && !r.some((x) => /gate\/rules/.test(x)));
  assert.deepEqual(verdict({ ...base, notes: {}, pending: { sha: S, refusals: [] } }).refusals.length, 2, "the release's own sign-offs still count");
});

test("the link never moves back: kept at a signed release on main that has S; anything else moves to S", () => {
  const P = "9".repeat(40), f = { sha: S, before: P, beforeHasSha: true, beforeOnMain: true, beforeNote: "SECURE" };
  assert.equal(linkMove(f), "keep");
  assert.equal(linkMove({ ...f, beforeNote: "" }), "move", "unsigned");
  assert.equal(linkMove({ ...f, beforeOnMain: false }), "move", "off main");
  assert.equal(linkMove({ ...f, beforeHasSha: false }), "move", "doesn't have S");
  assert.equal(linkMove({ ...f, before: S }), "move", "already S");
  assert.equal(linkMove({ ...f, before: null }), "move", "no link");
});

// End to end, on a scratch clone: the pin B, a signed pack S that changes a pinned file, a page release P on it.
test("board-release --dry-run on a scratch repository: P on a waiting signed pack passes, so does a newer signed pack on it; an unsigned pinned change on the line refuses both", () => {
  const REPO = new URL("..", import.meta.url).pathname, D = mkdtempSync(join(tmpdir(), "pack-wait-"));
  const git = (cwd, ...a) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const B = git(REPO, "rev-parse", "HEAD");
    execFileSync("git", ["init", "-q", "--bare", join(D, "origin.git")]);
    git(REPO, "push", "-q", join(D, "origin.git"), `${B}:refs/heads/main`);
    const W = join(D, "work");
    execFileSync("git", ["clone", "-q", join(D, "origin.git"), W]);
    const commit = (file, msg) => { appendFileSync(join(W, file), file.endsWith(".html") ? "\n<!-- x -->\n" : "\n// x\n"); git(W, "commit", "-qam", msg); return git(W, "rev-parse", "HEAD"); };
    const sign = (sha, checker = "PASS Quick") => { git(W, "notes", "--ref=checker", "add", "-f", "-m", checker, sha); git(W, "notes", "--ref=security", "add", "-f", "-m", "SECURE", sha); };
    const Sx = commit("gate/rules.mjs", "the pack"); sign(Sx);
    const P = commit("page/board.template.html", "a page"); sign(P);
    git(W, "push", "-q", "origin", "refs/notes/checker", "refs/notes/security");
    const H = join(D, "home"), cfg = join(H, "board.config.json");
    mkdirSync(join(H, ".claude"), { recursive: true });
    const conf = JSON.parse(readFileSync(join(REPO, "board.config.example.json"), "utf8"));
    writeFileSync(cfg, JSON.stringify({ ...conf, artifactUrl: "https://claude.ai/" + "artifact/AbCdEfGh123", collector: { ...conf.collector, outDir: join(H, "out") } }));
    mkdirSync(join(H, ".flight-board/AbCdEfGh123/.claude"), { recursive: true });
    writeFileSync(join(H, ".flight-board/AbCdEfGh123/.claude/settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node '${H}/x/collector/fence.mjs' --send-to Manager` }] }] } }));
    writeFileSync(join(H, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `node '${H}/.flight-board/install/${B}/gate/gate.mjs' --config '${cfg}'` }] }] } }));
    const run = (sha) => { try { return { ok: true, out: execFileSync(process.execPath, [join(REPO, "scripts/board-release.mjs"), sha, "--dry-run"], { env: { ...process.env, HOME: H, FLIGHT_BOARD_REPO: W }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; } catch (e) { return { ok: false, out: `${e.stdout}${e.stderr}` }; } };
    const good = run(P);
    assert.ok(good.ok, good.out);
    assert.match(good.out, new RegExp(`pinned changes since ${B.slice(0, 12)} are the waiting pack's only: ${Sx.slice(0, 12)}, signed`));
    // A signed pinned change on top is the newest waiting pack itself (Security: "the newest one if all its pinned
    // ancestors are also signed"); it goes to main, and its pinned code still waits for the owner's install.
    const P2 = commit("gate/gate.mjs", "a newer pack"); sign(P2);
    git(W, "push", "-q", "-f", "origin", "refs/notes/checker", "refs/notes/security");
    const newer = run(P2);
    assert.ok(newer.ok && newer.out.includes(`the waiting pack's only: ${P2.slice(0, 12)}`), newer.out);
    // An older pinned change on the line that isn't signed refuses both.
    sign(Sx, "FINDINGS"); git(W, "push", "-q", "-f", "origin", "refs/notes/checker", "refs/notes/security");
    for (const sha of [P, P2]) {
      const r = run(sha);
      assert.ok(!r.ok && new RegExp(`isn't signed by both Checker and Security: ${Sx.slice(0, 12)}`).test(r.out), r.out);
    }
  } finally { rmSync(D, { recursive: true, force: true }); }
});
