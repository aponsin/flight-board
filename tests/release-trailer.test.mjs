// #C847: the probe finds a landed card on main by the Board-Id trailer of a main commit, so board-release refuses a tip when any commit it
// would land lacks one that names a card. The check reads real git trailers.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { verdict, untrailered, parseTrailerLog, TRAILER_LOG } from "../scripts/board-release.mjs";

const ok = { forward: true, notes: { checker: "PASS", security: "SECURE" }, pinned: "a".repeat(40), changed: [], owned: [], capabilities: [] };

test("untrailered: a commit with no Board-Id, or one whose id is not a card id's shape, is named; a good one is not", () => {
  assert.deepEqual(untrailered([{ sha: "a1", ids: ["plan-week-tile-mismatch"] }, { sha: "b2", ids: [] }, { sha: "c3", ids: ["Not A Card"] }, { sha: "d4" }, null]), ["b2", "c3", "d4", ""]);
  assert.deepEqual(untrailered([]), []);
  assert.deepEqual(untrailered(undefined), []);
});

test("verdict: a release with a commit that has no Board-Id trailer is refused, naming it; with all of them it goes", () => {
  assert.equal(verdict({ ...ok }).ok, true);
  assert.equal(verdict({ ...ok, noTrailer: [] }).ok, true);
  const v = verdict({ ...ok, noTrailer: ["8b3855f0f6724512b2e88930346f790a8a607370"] });
  assert.equal(v.ok, false);
  assert.match(v.refusals[0], /a commit has no Board-Id trailer naming a card: 8b3855f0f672 /);
  const many = verdict({ ...ok, noTrailer: Array.from({ length: 7 }, (_, n) => `${n}`.repeat(40)) });
  assert.match(many.refusals[0], /^7 commits have no Board-Id trailer/);
  assert.match(many.refusals[0], /, \.\.\./, "only the first five are listed");
});

test("with real git: the log of main..tip yields the trailers, and the commit with none is the one refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-"));
  const git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "f"), "0");
  git("add", "f"); git("commit", "-q", "-m", "base");
  const main = git("rev-parse", "HEAD");
  const commit = (n, msg) => { writeFileSync(join(dir, "f"), n); git("add", "f"); git("commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };
  const good = commit("1", "A change\n\nBoard-Id: depends-on-blocks-dispatch");
  const bare = commit("2", "No trailer here");
  const coauthor = commit("3", "Only a co-author\n\nCo-Authored-By: Someone <s@example.com>");
  const both = commit("4", "Two trailers\n\nBoard-Id: first-card\nBoard-Id: second-card");
  const commits = parseTrailerLog(git("log", `--format=${TRAILER_LOG}`, `${main}..${both}`));
  assert.equal(commits.length, 4);
  assert.deepEqual(commits.find((c) => c.sha === good).ids, ["depends-on-blocks-dispatch"]);
  assert.deepEqual(commits.find((c) => c.sha === both).ids.sort(), ["first-card", "second-card"]);
  assert.deepEqual(untrailered(commits).sort(), [bare, coauthor].sort());
  assert.deepEqual(untrailered(parseTrailerLog(git("log", `--format=${TRAILER_LOG}`, `${main}..${good}`))), [], "a tip whose commits all carry one");
});
