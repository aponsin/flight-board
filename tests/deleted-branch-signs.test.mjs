// #C716: a shipped card in the team's own repository whose branch was deleted after it merged still shows its signs. The Collector
// found such a card by its Board-Id trailer on main only in another repository (#C281); the team's own repository read "no branch or
// Board-Id commit", never saw the notes on the commit, and the gate refused the card's end step and close (#C708 on 2026-11-06).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { collect } from "../collector/collect.mjs";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-dbs-"));
  const repo = join(dir, "repo"), bare = join(dir, "origin.git");
  const g = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  const commit = (file, msg) => { writeFileSync(join(repo, file), msg + "\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  const sign = (sha, ...who) => { for (const w of who) g(["notes", `--ref=refs/notes/${w}`, "add", "-m", w === "security" ? "SECURE" : "PASS", sha]); };
  commit("a.md", "start");
  // The card's work merged and its branch deleted: only the trailer on main is left, and the signs are on that commit.
  const shipped = commit("s.md", "shipped work\n\nBoard-Id: owner-form-hide-hours");
  sign(shipped, "checker", "security");
  // A near miss and an unsigned card.
  commit("n.md", "near miss\n\nBoard-Id: owner-form-hide-hours-two");
  commit("u.md", "unsigned work\n\nBoard-Id: unsigned-card");
  g(["push", "-q", "origin", "main", "refs/notes/checker", "refs/notes/security"]);
  g(["fetch", "-q", "origin", "+refs/notes/*:refs/notes/flight-board/*"]);
  g(["fetch", "-q", "origin"]);
  return { dir, git: (args) => g(args), shipped };
}

test("a card of the team's own repository whose branch is gone is found on main by its Board-Id trailer, and its signs are read", () => {
  const s = scratch();
  try {
    const config = fullConfig({ collector: { repoPath: "/srv/team", notes: { checker: "refs/notes/checker", security: "refs/notes/security" } } });
    const cards = ["owner-form-hide-hours", "unsigned-card", "no-such-card", "owner-form-hide"].map((id) => ({ id, status: "active", phase: "ship", level: "Full" }));
    const { doc } = collect({ config, cards, git: s.git, gh: () => "[]", now: 5 });
    const done = doc.cards["owner-form-hide-hours"];
    assert.ok(done.phase, `the card reads a phase (was: ${done.evidence})`);
    assert.ok(String(done.head).startsWith(s.shipped.slice(0, 8)), "its head is the commit on main");
    assert.deepEqual([...Object.keys(done.reviews ?? {})].sort(), ["checker", "security"], "both signs on it are seen");
    assert.equal(doc.cards["unsigned-card"].reviews, undefined, "an unsigned commit shows no signs");
    assert.ok(doc.cards["unsigned-card"].head, "but it is found");
    assert.equal(doc.cards["no-such-card"].phase, null, "no branch and no trailer: as before");
    assert.equal(doc.cards["no-such-card"].evidence, "no branch or Board-Id commit for this card");
    assert.equal(doc.cards["owner-form-hide"].phase, null, "the trailer must be the card's id exactly, not a prefix of another's");
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
